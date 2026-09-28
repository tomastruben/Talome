/**
 * Cross-app path mapping — the most common silent failure in a media stack.
 *
 * - Download mapping: the folder qBittorrent saves into must be the folder
 *   the *arr imports from (same host directory, possibly via a remote path
 *   mapping), otherwise downloads finish and never get imported.
 * - Library mapping: the *arr root folder must be inside a library of the
 *   media server, otherwise imports never show up for streaming.
 *
 * Proof strategy: translate container paths to host paths through each
 * container's mounts (docker inspect, read-only). The *arr's own filesystem
 * API confirms the path exists inside the *arr container. When Docker can't
 * tell us mounts, fall back to container-path comparison and say so.
 */

import { posix } from "node:path";
import { z } from "zod";
import { APP_REGISTRY } from "../../app-registry/index.js";
import type { MountInfo } from "../env.js";
import { appRequest, getAppName, resolveConnection, type ProbeCallContext } from "../http.js";
import { applyRemotePathMappings, isSameOrUnder, normalizePath, pathsOverlap, toHostPath, type RemotePathMapping } from "../paths.js";
import { outcome } from "../runner.js";
import type { CheckOutcome, CheckStatus } from "../types.js";
import { arrPath, evaluateArrRootFolders, fieldValue, getArrDownloadClients, getArrRootFolders, type ArrAppId } from "./arr.js";
import { getJellyfinLibraries } from "./jellyfin.js";
import { listPreview, parseOr } from "./common.js";

// ── Shared helpers ──────────────────────────────────────────────────────────

export function containerNameFor(appId: string): string {
  return APP_REGISTRY[appId]?.dockerServiceName ?? appId;
}

async function mountsFor(ctx: ProbeCallContext, appId: string): Promise<MountInfo[] | null> {
  try {
    return await ctx.env.inspectMounts(containerNameFor(appId));
  } catch {
    return null;
  }
}

const RANK: Record<CheckStatus, number> = { fail: 4, timeout: 3, warn: 2, pass: 1, skip: 0 };

/** Merge per-app outcomes into one: worst status wins, evidence is concatenated. */
export function combineOutcomes(parts: Array<{ label: string; outcome: CheckOutcome }>, emptyEvidence: string): CheckOutcome {
  const relevant = parts.filter((p) => p.outcome.status !== "skip");
  if (relevant.length === 0) {
    return outcome.skip(parts.length > 0 ? parts.map((p) => `${p.label}: ${p.outcome.evidence}`).join(" ") : emptyEvidence, parts.find((p) => p.outcome.remediation)?.outcome.remediation);
  }
  const worst = relevant.reduce((a, b) => (RANK[b.outcome.status] > RANK[a.outcome.status] ? b : a));
  return {
    status: worst.outcome.status,
    evidence: relevant.map((p) => `${p.label}: ${p.outcome.evidence}`).join(" "),
    remediation: worst.outcome.remediation,
  };
}

// ── *arr filesystem ────────────────────────────────────────────────────────

const fsSchema = z.object({
  parent: z.string().nullable().optional(),
  directories: z.array(z.unknown()).optional(),
  files: z.array(z.unknown()).optional(),
});

/** Does `path` exist inside the *arr container? Read-only (the *arr folder browser API). */
export async function arrPathExists(ctx: ProbeCallContext, appId: ArrAppId, path: string): Promise<boolean | null> {
  const folder = `${normalizePath(path).replace(/\/$/, "")}/`;
  const query = `?path=${encodeURIComponent(folder)}&includeFiles=false&allowFoldersWithoutTrailingSlashes=true`;
  const res = await appRequest(ctx, appId, arrPath(appId, `/filesystem${query}`));
  if (!res.ok) return null;
  const data = parseOr(fsSchema, res.data);
  if (!data) return null;
  return Boolean(data.parent) || (data.directories?.length ?? 0) > 0 || (data.files?.length ?? 0) > 0;
}

// ── Download path mapping (qBittorrent → *arr) ───────────────────────────────

const qbtPrefsSchema = z.object({ save_path: z.string().optional() });
const qbtCategoriesSchema = z.record(z.string(), z.object({ name: z.string().optional(), savePath: z.string().optional() }));
const remoteMappingSchema = z.array(z.object({ host: z.string().optional(), remotePath: z.string(), localPath: z.string() }));

export async function getQbtSavePaths(ctx: ProbeCallContext): Promise<{ savePath: string | null; categories: Record<string, { savePath?: string }>; error?: string }> {
  const prefs = await appRequest(ctx, "qbittorrent", "/api/v2/app/preferences");
  if (!prefs.ok) return { savePath: null, categories: {}, error: prefs.error };
  const parsed = parseOr(qbtPrefsSchema, prefs.data);
  const cats = await appRequest(ctx, "qbittorrent", "/api/v2/torrents/categories");
  const categories = cats.ok ? parseOr(qbtCategoriesSchema, cats.data) ?? {} : {};
  return { savePath: parsed?.save_path ? normalizePath(parsed.save_path) : null, categories };
}

const CATEGORY_FIELDS = ["tvCategory", "movieCategory", "bookCategory", "musicCategory", "category"];

export async function evaluateDownloadPathMapping(ctx: ProbeCallContext, arrId: ArrAppId): Promise<CheckOutcome> {
  const arrName = getAppName(arrId);
  const { clients, error } = await getArrDownloadClients(ctx, arrId);
  if (!clients) return error!;
  const qbtClients = clients.filter((c) => c.enable !== false && (c.implementation ?? "").toLowerCase() === "qbittorrent");
  if (qbtClients.length === 0) return outcome.skip(`${arrName} does not use qBittorrent.`);
  if (!resolveConnection(ctx.env, "qbittorrent")) {
    return outcome.skip(
      "qBittorrent is not connected to Talome, so its save path can't be compared.",
      "Save qbittorrent_url and qbittorrent_password under Settings → Connections.",
    );
  }

  const { savePath, categories, error: qbtError } = await getQbtSavePaths(ctx);
  if (!savePath) {
    return outcome.fail(`Could not read qBittorrent's save path${qbtError ? `: ${qbtError}` : ""}.`, "Make sure Talome can log in to qBittorrent (qbittorrent_password).");
  }

  const mappingRes = await appRequest(ctx, arrId, arrPath(arrId, "/remotepathmapping"));
  const mappings: RemotePathMapping[] = mappingRes.ok ? parseOr(remoteMappingSchema, mappingRes.data) ?? [] : [];
  const [arrMounts, qbtMounts] = await Promise.all([mountsFor(ctx, arrId), mountsFor(ctx, "qbittorrent")]);

  const problems: string[] = [];
  const warnings: string[] = [];
  const proofs: string[] = [];
  let remediation: string | undefined;

  for (const client of qbtClients) {
    const category = fieldValue(client, ...CATEGORY_FIELDS);
    const categoryName = typeof category === "string" ? category : undefined;
    const explicit = categoryName ? categories[categoryName]?.savePath : undefined;
    const qbtPath = explicit ? normalizePath(posix.isAbsolute(explicit) ? explicit : posix.join(savePath, explicit)) : savePath;
    const clientHost = typeof fieldValue(client, "host") === "string" ? (fieldValue(client, "host") as string) : undefined;
    const mapped = applyRemotePathMappings(qbtPath, mappings, clientHost);
    const arrLocal = mapped.path;
    const via = mapped.mapping ? ` via remote path mapping ${mapped.mapping.remotePath} → ${mapped.mapping.localPath}` : "";

    const qbtHost = toHostPath(qbtPath, qbtMounts);
    const arrHost = toHostPath(arrLocal, arrMounts);
    let exists = await arrPathExists(ctx, arrId, arrLocal);
    let pendingCategoryFolder = false;
    if (exists === false && explicit) {
      // Category folders are created by qBittorrent on first download — check the parent instead.
      const parentExists = await arrPathExists(ctx, arrId, posix.dirname(arrLocal));
      if (parentExists) {
        exists = true;
        pendingCategoryFolder = true;
      }
    }

    if (exists === false) {
      problems.push(`qBittorrent saves to ${qbtPath}${categoryName ? ` (category "${categoryName}")` : ""}, but ${arrName} cannot see ${arrLocal}${via}.`);
      remediation = `Mount the same host download folder at the same path in both qBittorrent and ${arrName} (e.g. /downloads), or add a Remote Path Mapping in ${arrName} → Settings → Download Clients.`;
      continue;
    }
    if (qbtHost && arrMounts && !arrHost) {
      problems.push(`qBittorrent saves to host folder ${qbtHost}, but ${arrLocal} is not a mounted folder in ${arrName} — imports would read the container's own disk.`);
      remediation = `Mount ${qbtHost} into the ${arrName} container at ${arrLocal} (add_volume_mount), then restart ${arrName}.`;
      continue;
    }
    if (qbtHost && arrHost && normalizePath(qbtHost) !== normalizePath(arrHost)) {
      problems.push(`qBittorrent writes to host folder ${qbtHost}, but ${arrName}'s ${arrLocal} is host folder ${arrHost} — different directories.`);
      remediation = `Point both containers at the same host download folder (${qbtHost}).`;
      continue;
    }
    const proof = qbtHost && arrHost
      ? `${qbtPath} (qBittorrent) and ${arrLocal} (${arrName}) are the same host folder ${qbtHost}${via}`
      : `${arrName} can see qBittorrent's save path ${arrLocal}${via}${exists === null ? " (existence not confirmed)" : ""}${qbtHost || arrHost ? "" : " — container mounts unavailable, compared container paths only"}`;
    if (exists === null && !(qbtHost && arrHost)) warnings.push(proof);
    else proofs.push(pendingCategoryFolder ? `${proof} (category folder is created on first download)` : proof);
  }

  if (problems.length > 0) return outcome.fail(problems.join(" "), remediation);
  if (warnings.length > 0) {
    return outcome.warn(
      [...proofs, ...warnings].join("; "),
      `Could not confirm the folder inside ${arrName}; check ${arrName} → System → Status for remote path mapping warnings.`,
    );
  }
  return outcome.pass(`${proofs.join("; ")}.`);
}

// ── Library mapping (*arr root folder → media server library) ─────────────

const absLibrariesSchema = z.object({
  libraries: z.array(
    z.object({
      name: z.string().optional(),
      mediaType: z.string().optional(),
      folders: z.array(z.object({ fullPath: z.string() })).optional(),
    }),
  ),
});

export type LibraryTarget = "jellyfin" | "audiobookshelf";

async function libraryLocations(ctx: ProbeCallContext, target: LibraryTarget): Promise<{ locations: string[] | null; error?: CheckOutcome }> {
  if (target === "jellyfin") {
    const { libraries, error } = await getJellyfinLibraries(ctx);
    if (!libraries) return { locations: null, error };
    return { locations: [...new Set(libraries.flatMap((l) => l.Locations ?? []))] };
  }
  const res = await appRequest(ctx, "audiobookshelf", "/api/libraries");
  if (!res.ok) return { locations: null, error: outcome.fail(`Could not list Audiobookshelf libraries: ${res.error ?? `HTTP ${res.status}`}.`) };
  const parsed = parseOr(absLibrariesSchema, res.data);
  if (!parsed) return { locations: null, error: outcome.fail("Audiobookshelf returned an unexpected library list.") };
  return { locations: [...new Set(parsed.libraries.flatMap((l) => (l.folders ?? []).map((f) => f.fullPath)))] };
}

/** Translate a host path into the target container's path (for "add this library" remediation). */
function hostToContainer(hostPath: string, mounts: MountInfo[] | null): string | null {
  if (!mounts) return null;
  let best: MountInfo | null = null;
  for (const m of mounts) {
    if (!isSameOrUnder(hostPath, m.source)) continue;
    if (!best || normalizePath(m.source).length > normalizePath(best.source).length) best = m;
  }
  if (!best) return null;
  const rest = normalizePath(hostPath).slice(normalizePath(best.source).length);
  return normalizePath(`${best.destination}/${rest}`);
}

export async function evaluateLibraryPathMapping(ctx: ProbeCallContext, arrId: ArrAppId, target: LibraryTarget): Promise<CheckOutcome> {
  const arrName = getAppName(arrId);
  const targetName = getAppName(target);
  const { folders, error } = await getArrRootFolders(ctx, arrId);
  if (!folders) return error!;
  if (folders.length === 0) return evaluateArrRootFolders(ctx, arrId);

  const { locations, error: libError } = await libraryLocations(ctx, target);
  if (!locations) return libError!;
  if (locations.length === 0) {
    return outcome.fail(`${targetName} has no library folders, so ${arrName} imports will never appear.`, `Create a ${targetName} library for ${listPreview(folders.map((f) => f.path))}.`);
  }

  const [arrMounts, targetMounts] = await Promise.all([mountsFor(ctx, arrId), mountsFor(ctx, target)]);
  const problems: string[] = [];
  const uncertain: string[] = [];
  const proofs: string[] = [];
  let remediation: string | undefined;

  for (const folder of folders) {
    const rHost = toHostPath(folder.path, arrMounts);
    const lHosts = locations.map((l) => ({ container: l, host: toHostPath(l, targetMounts) }));

    if (rHost && lHosts.some((l) => l.host)) {
      const match = lHosts.find((l) => l.host && pathsOverlap(rHost, l.host));
      if (match) {
        proofs.push(`${arrName} ${folder.path} → ${targetName} library ${match.container} (host ${rHost})`);
      } else {
        const inTarget = hostToContainer(rHost, targetMounts);
        problems.push(`${arrName} imports into ${folder.path} (host ${rHost}), but no ${targetName} library covers that folder.`);
        remediation = inTarget
          ? `Add a ${targetName} library with the folder ${inTarget}.`
          : `Mount ${rHost} into the ${targetName} container (add_volume_mount), then add it as a library.`;
      }
      continue;
    }

    const match = locations.find((l) => pathsOverlap(folder.path, l));
    if (match) proofs.push(`${arrName} ${folder.path} → ${targetName} library ${match} (same container path; mounts not verified)`);
    else uncertain.push(folder.path);
  }

  if (problems.length > 0) return outcome.fail(problems.join(" "), remediation);
  if (uncertain.length > 0) {
    return outcome.warn(
      `Could not prove that ${listPreview(uncertain)} (${arrName}) is inside a ${targetName} library (${listPreview(locations)}); container paths differ and Docker mounts were unavailable.`,
      `Make sure the ${arrName} root folder and a ${targetName} library point at the same host folder.`,
    );
  }
  return outcome.pass(`${proofs.join("; ")}.`);
}
