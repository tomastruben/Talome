/**
 * Sonarr / Radarr / Readarr probes.
 *
 * Verified means: the API answers with Talome's key, at least one root folder
 * exists and is accessible inside the container, an enabled download client
 * is healthy, and indexers are present.
 */

import { z } from "zod";
import { appRequest, getAppName, type ProbeCallContext } from "../http.js";
import { outcome, type CheckDefinition } from "../runner.js";
import type { CheckOutcome } from "../types.js";
import {
  apiReachableCheck,
  formatBytes,
  httpFailure,
  listPreview,
  parseOr,
  plural,
  versionSchema,
} from "./common.js";

export type ArrAppId = "sonarr" | "radarr" | "readarr";
export const ARR_APPS: readonly ArrAppId[] = ["sonarr", "radarr", "readarr"];

const API_VERSION: Record<ArrAppId | "prowlarr", string> = {
  sonarr: "v3",
  radarr: "v3",
  readarr: "v1",
  prowlarr: "v1",
};

export function arrPath(appId: ArrAppId | "prowlarr", path: string): string {
  return `/api/${API_VERSION[appId]}${path}`;
}

/** Warn when a root folder has less free space than this. */
const LOW_SPACE_BYTES = 10 * 1024 ** 3;

const rootFolderSchema = z.array(
  z.object({
    path: z.string(),
    accessible: z.boolean().optional(),
    freeSpace: z.number().nullable().optional(),
  }),
);

const fieldSchema = z.object({ name: z.string(), value: z.unknown().optional() });

export const downloadClientSchema = z.array(
  z.object({
    id: z.number().optional(),
    name: z.string().optional(),
    enable: z.boolean().optional(),
    protocol: z.string().optional(),
    implementation: z.string().optional(),
    fields: z.array(fieldSchema).optional(),
  }).loose(),
);
export type ArrDownloadClient = z.infer<typeof downloadClientSchema>[number];

const indexerSchema = z.array(
  z.object({
    name: z.string().optional(),
    enable: z.boolean().optional(),
    enableRss: z.boolean().optional(),
    enableAutomaticSearch: z.boolean().optional(),
    enableInteractiveSearch: z.boolean().optional(),
    protocol: z.string().optional(),
  }),
);

export const healthSchema = z.array(
  z.object({
    source: z.string().optional(),
    type: z.string().optional(),
    message: z.string().optional(),
  }),
);
export type ArrHealthItem = z.infer<typeof healthSchema>[number];

/** *arr ↔ download client communication. */
const DOWNLOAD_CLIENT_HEALTH_SOURCES = new Set(["DownloadClientCheck", "DownloadClientStatusCheck", "DownloadClientSortingCheck"]);
/** Where finished downloads land vs. where the *arr can import from. */
export const IMPORT_HEALTH_SOURCES = new Set(["DownloadClientRootFolderCheck", "RemotePathMappingCheck", "ImportMechanismCheck"]);
const DOWNLOAD_HEALTH_SOURCES = new Set([...DOWNLOAD_CLIENT_HEALTH_SOURCES, ...IMPORT_HEALTH_SOURCES]);
const INDEXER_HEALTH_SOURCES = new Set([
  "IndexerStatusCheck",
  "IndexerLongTermStatusCheck",
  "IndexerRssCheck",
  "IndexerSearchCheck",
  "IndexerJackettAllCheck",
]);

export function fieldValue(client: ArrDownloadClient, ...names: string[]): unknown {
  for (const n of names) {
    const f = client.fields?.find((x) => x.name === n);
    if (f && f.value !== undefined && f.value !== null && f.value !== "") return f.value;
  }
  return undefined;
}

/** Download-client credentials returned by the *arr must never reach evidence. */
function registerClientSecrets(ctx: ProbeCallContext, clients: ArrDownloadClient[]): void {
  for (const c of clients) {
    for (const f of c.fields ?? []) {
      if (/password|apikey|api_key|token|secret/i.test(f.name) && typeof f.value === "string" && f.value) {
        ctx.env.secrets.add(f.value);
      }
    }
  }
}

export async function getArrHealth(ctx: ProbeCallContext, appId: ArrAppId | "prowlarr"): Promise<ArrHealthItem[] | null> {
  const res = await appRequest(ctx, appId, arrPath(appId, "/health"));
  if (!res.ok) return null;
  return parseOr(healthSchema, res.data);
}

function problemsFrom(health: ArrHealthItem[] | null, sources: Set<string>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const h of health ?? []) {
    if (!h.source || !sources.has(h.source) || !h.message) continue;
    if (h.type === "error") errors.push(h.message);
    else if (h.type === "warning") warnings.push(h.message);
  }
  return { errors, warnings };
}

export async function getArrDownloadClients(ctx: ProbeCallContext, appId: ArrAppId): Promise<{ clients: ArrDownloadClient[] | null; error?: CheckOutcome }> {
  const res = await appRequest(ctx, appId, arrPath(appId, "/downloadclient"));
  if (!res.ok) return { clients: null, error: httpFailure(ctx, appId, res, "listing download clients") };
  const clients = parseOr(downloadClientSchema, res.data);
  if (!clients) return { clients: null, error: outcome.fail(`${getAppName(appId)} returned an unexpected download-client list.`) };
  registerClientSecrets(ctx, clients);
  return { clients };
}

export async function getArrRootFolders(ctx: ProbeCallContext, appId: ArrAppId): Promise<{ folders: z.infer<typeof rootFolderSchema> | null; error?: CheckOutcome }> {
  const res = await appRequest(ctx, appId, arrPath(appId, "/rootfolder"));
  if (!res.ok) return { folders: null, error: httpFailure(ctx, appId, res, "listing root folders") };
  const folders = parseOr(rootFolderSchema, res.data);
  if (!folders) return { folders: null, error: outcome.fail(`${getAppName(appId)} returned an unexpected root-folder list.`) };
  return { folders };
}

// ── Evaluations (shared with stack probes) ─────────────────────────────────

export async function evaluateArrRootFolders(ctx: ProbeCallContext, appId: ArrAppId): Promise<CheckOutcome> {
  const name = getAppName(appId);
  const { folders, error } = await getArrRootFolders(ctx, appId);
  if (!folders) return error!;
  if (folders.length === 0) {
    return outcome.fail(
      `${name} has no root folder, so it cannot import anything.`,
      `Add the library folder ${name} should import into (e.g. ${appId === "sonarr" ? "/data/media/tv" : appId === "radarr" ? "/data/media/movies" : "/data/media/books"}) — ask the assistant to run arr_add_root_folder.`,
    );
  }
  const inaccessible = folders.filter((f) => f.accessible === false);
  if (inaccessible.length > 0) {
    return outcome.fail(
      `${name} cannot access ${listPreview(inaccessible.map((f) => f.path))} inside its container.`,
      `Mount the host folder into the ${name} container at that path (add_volume_mount) and make sure it is writable by PUID/PGID.`,
    );
  }
  const described = folders.map((f) => (typeof f.freeSpace === "number" ? `${f.path} (${formatBytes(f.freeSpace)} free)` : f.path));
  const low = folders.filter((f) => typeof f.freeSpace === "number" && f.freeSpace < LOW_SPACE_BYTES);
  if (low.length > 0) {
    return outcome.warn(
      `Root folders accessible, but ${listPreview(low.map((f) => f.path))} ${low.length === 1 ? "has" : "have"} under ${formatBytes(LOW_SPACE_BYTES)} free: ${listPreview(described)}.`,
      "Free up space on that drive or move the library to a larger one — imports stop when the disk fills.",
    );
  }
  return outcome.pass(`${plural(folders.length, "root folder")} accessible: ${listPreview(described)}.`);
}

/**
 * @param opts.includeImportHealth also judge remote-path/import health (app probe);
 *   stack probes check those in their own "import" link instead.
 */
export async function evaluateArrDownloadClients(
  ctx: ProbeCallContext,
  appId: ArrAppId,
  opts: { includeImportHealth?: boolean } = {},
): Promise<CheckOutcome> {
  const name = getAppName(appId);
  const { clients, error } = await getArrDownloadClients(ctx, appId);
  if (!clients) return error!;
  const enabled = clients.filter((c) => c.enable !== false);
  if (enabled.length === 0) {
    return outcome.fail(
      clients.length === 0 ? `${name} has no download client configured.` : `${name} has download clients, but all are disabled.`,
      `Connect a download client (e.g. qBittorrent) to ${name} — ask the assistant to run arr_add_download_client.`,
    );
  }
  const health = await getArrHealth(ctx, appId);
  const sources = opts.includeImportHealth === false ? DOWNLOAD_CLIENT_HEALTH_SOURCES : DOWNLOAD_HEALTH_SOURCES;
  const { errors, warnings } = problemsFrom(health, sources);
  const names = enabled.map((c) => `${c.name ?? c.implementation ?? "client"}${c.protocol ? ` (${c.protocol})` : ""}`);
  if (errors.length > 0) {
    return outcome.fail(
      `${name} reports download problems: ${listPreview(errors, 2)}`,
      `Open ${name} → System → Status, or ask the assistant to run arr_test_download_client and fix the reported host/port/credentials or path mapping.`,
    );
  }
  if (warnings.length > 0) {
    return outcome.warn(`${listPreview(names)} enabled; ${name} warns: ${listPreview(warnings, 2)}`);
  }
  return outcome.pass(
    `${listPreview(names)} enabled${health ? "; no download-client health issues" : " (health endpoint unavailable)"}.`,
  );
}

/**
 * Runs each enabled client's "Test" in the *arr. Flagged active: for
 * qBittorrent the test creates the *arr's category if it's missing.
 */
export async function testArrDownloadClients(ctx: ProbeCallContext, appId: ArrAppId): Promise<CheckOutcome> {
  const name = getAppName(appId);
  const { clients, error } = await getArrDownloadClients(ctx, appId);
  if (!clients) return error!;
  const enabled = clients.filter((c) => c.enable !== false);
  if (enabled.length === 0) return outcome.skip(`${name} has no enabled download client to test.`);
  const failures: string[] = [];
  const passes: string[] = [];
  for (const client of enabled) {
    const label = client.name ?? client.implementation ?? "client";
    const res = await appRequest(ctx, appId, arrPath(appId, "/downloadclient/test"), { method: "POST", body: client });
    if (res.ok) passes.push(label);
    else failures.push(`${label}: ${res.error ?? `HTTP ${res.status}`}`);
  }
  if (failures.length > 0) {
    return outcome.fail(
      `${name}'s download client test failed — ${listPreview(failures, 2)}`,
      "Fix the client's host, port and credentials in the *arr (container names like 'qbittorrent' only resolve on the shared Docker network).",
    );
  }
  return outcome.pass(`${name} successfully tested ${listPreview(passes)}.`);
}

export async function evaluateArrIndexers(ctx: ProbeCallContext, appId: ArrAppId): Promise<CheckOutcome> {
  const name = getAppName(appId);
  const res = await appRequest(ctx, appId, arrPath(appId, "/indexer"));
  if (!res.ok) return httpFailure(ctx, appId, res, "listing indexers");
  const indexers = parseOr(indexerSchema, res.data);
  if (!indexers) return outcome.fail(`${name} returned an unexpected indexer list.`);
  const enabled = indexers.filter((i) => i.enableRss || i.enableAutomaticSearch || i.enableInteractiveSearch || i.enable);
  if (enabled.length === 0) {
    return outcome.fail(
      indexers.length === 0 ? `${name} has no indexers, so it can never find releases.` : `${name} has indexers but none are enabled for search.`,
      "Add indexers in Prowlarr and sync them — ask the assistant to run arr_sync_indexers_from_prowlarr.",
    );
  }
  const health = await getArrHealth(ctx, appId);
  const { errors, warnings } = problemsFrom(health, INDEXER_HEALTH_SOURCES);
  const summary = `${plural(enabled.length, "indexer")} enabled: ${listPreview(enabled.map((i) => i.name ?? "unnamed"))}`;
  if (errors.length > 0 || warnings.length > 0) {
    return outcome.warn(`${summary}; ${name} reports: ${listPreview([...errors, ...warnings], 2)}`, "Check the failing indexers in Prowlarr (credentials, rate limits, or a site that is down).");
  }
  return outcome.pass(`${summary}.`);
}

export async function evaluateArrGeneralHealth(ctx: ProbeCallContext, appId: ArrAppId): Promise<CheckOutcome> {
  const name = getAppName(appId);
  const res = await appRequest(ctx, appId, arrPath(appId, "/health"));
  if (!res.ok) return httpFailure(ctx, appId, res, "reading health checks");
  const items = parseOr(healthSchema, res.data) ?? [];
  const covered = new Set([...DOWNLOAD_HEALTH_SOURCES, ...INDEXER_HEALTH_SOURCES]);
  const other = items.filter((h) => !h.source || !covered.has(h.source));
  const errors = other.filter((h) => h.type === "error").map((h) => h.message ?? h.source ?? "error");
  const warnings = other.filter((h) => h.type === "warning").map((h) => h.message ?? h.source ?? "warning");
  if (errors.length > 0) return outcome.warn(`${name} reports ${plural(errors.length, "error")}: ${listPreview(errors, 2)}`, `Review ${name} → System → Status.`);
  if (warnings.length > 0) return outcome.warn(`${name} reports ${plural(warnings.length, "warning")}: ${listPreview(warnings, 2)}`, `Review ${name} → System → Status.`);
  return outcome.pass(`${name} reports no other health issues.`);
}

// ── App probe ────────────────────────────────────────────────────────────────

export function arrChecks(appId: ArrAppId): CheckDefinition[] {
  const name = getAppName(appId);
  return [
    apiReachableCheck(appId, arrPath(appId, "/system/status"), (data) => {
      const v = parseOr(versionSchema, data)?.version;
      return `${name}${v ? ` ${v}` : ""} answered and accepted the API key`;
    }),
    // Critical: without a root folder, a download client or indexers the *arr
    // cannot deliver anything — "failed", not merely "degraded".
    { id: "root-folders", label: "Root folder exists and is accessible", appId, critical: true, dependsOn: ["api"], run: (ctx) => evaluateArrRootFolders(ctx, appId) },
    { id: "download-client", label: "Download client configured and healthy", appId, critical: true, dependsOn: ["api"], run: (ctx) => evaluateArrDownloadClients(ctx, appId) },
    {
      id: "download-client-test",
      label: "Download client test passes",
      appId,
      active: true,
      dependsOn: ["download-client"],
      timeoutMs: 20_000,
      run: (ctx) => testArrDownloadClients(ctx, appId),
    },
    { id: "indexers", label: "Indexers present", appId, critical: true, dependsOn: ["api"], run: (ctx) => evaluateArrIndexers(ctx, appId) },
    { id: "health", label: `${name} health checks`, appId, dependsOn: ["api"], run: (ctx) => evaluateArrGeneralHealth(ctx, appId) },
  ];
}
