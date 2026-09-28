/**
 * Stack probes — verify the outcome chain across apps, not each app alone.
 *
 * Media: request → indexer → download client → import → library
 * Photos: server → storage → phone backup URL
 * Books: Audiobookshelf libraries (+ Readarr root folder inside a library)
 * Smart home: Home Assistant API and core state
 */

import type { ProbeEnv } from "./env.js";
import { getAppName, resolveConnection, type ProbeCallContext } from "./http.js";
import {
  evaluateArrDownloadClients,
  evaluateArrIndexers,
  getArrDownloadClients,
  getArrHealth,
  arrChecks,
  IMPORT_HEALTH_SOURCES,
  type ArrAppId,
} from "./probes/arr.js";
import { listPreview } from "./probes/common.js";
import { immichChecks } from "./probes/immich.js";
import { evaluateJellyfinLibraryPaths, jellyfinChecks } from "./probes/jellyfin.js";
import { evaluateDownloadPathMapping, evaluateLibraryPathMapping } from "./probes/path-mapping.js";
import { evaluateProwlarrAppSync, prowlarrChecks } from "./probes/prowlarr.js";
import { qbittorrentChecks } from "./probes/qbittorrent.js";
import { evaluateSeerrArrConnectivity, evaluateSeerrMediaServer, seerrChecks, type SeerrAppId } from "./probes/seerr.js";
import { audiobookshelfChecks, homeAssistantChecks } from "./probes/simple-apps.js";
import { outcome, prefixChecks, type CheckDefinition } from "./runner.js";
import type { CheckOutcome } from "./types.js";

export interface ChainSpec {
  id: string;
  label: string;
  /** Check ids (or id prefixes ending in ":") that make up this link. */
  checkIds: string[];
}

export interface StackPlan {
  name: string;
  checks: CheckDefinition[];
  chain: ChainSpec[];
}

interface StackDefinition {
  id: string;
  name: string;
  aliases: string[];
  plan: (env: ProbeEnv) => StackPlan;
}

function isConfigured(env: ProbeEnv, appId: string): boolean {
  return resolveConnection(env, appId) !== null;
}

/** First check(s) of an app probe, prefixed — "is it up with our credentials". */
function reachability(appId: string, defs: CheckDefinition[], count: number, critical: boolean): CheckDefinition[] {
  return prefixChecks(appId, defs.slice(0, count), appId).map((d) => ({ ...d, critical: d.critical ? critical : false }));
}

function missing(id: string, label: string, evidence: string, remediation: string, critical: boolean): CheckDefinition {
  return { id, label, critical, run: async () => outcome.skip(evidence, remediation) };
}

/**
 * Import link. With qBittorrent we prove the save path is the *arr's import
 * path. With other clients (or qBittorrent not connected to Talome) we fall
 * back to the *arr's own remote-path/import health checks.
 */
async function evaluateImportLink(ctx: ProbeCallContext, arrId: ArrAppId): Promise<CheckOutcome> {
  const direct = await evaluateDownloadPathMapping(ctx, arrId);
  if (direct.status !== "skip") return direct;

  const name = getAppName(arrId);
  const { clients } = await getArrDownloadClients(ctx, arrId);
  const clientNames = (clients ?? []).filter((c) => c.enable !== false).map((c) => c.name ?? c.implementation ?? "client");
  const health = await getArrHealth(ctx, arrId);
  if (!health) return direct;
  const problems = health
    .filter((h) => h.source !== undefined && IMPORT_HEALTH_SOURCES.has(h.source) && (h.type === "error" || h.type === "warning"))
    .map((h) => h.message ?? h.source ?? "problem");
  if (problems.length > 0) {
    return outcome.fail(
      `${name} reports import path problems: ${listPreview(problems, 2)}`,
      `Mount the download folder at the same path in the download client and ${name}, or add a Remote Path Mapping.`,
    );
  }
  return outcome.pass(
    `${name} reports no remote-path or import problems for ${listPreview(clientNames)} (${direct.evidence.replace(/\.$/, "")}; paths not inspected directly).`,
  );
}

// ── Media server ─────────────────────────────────────────────────────────────

function mediaServerPlan(env: ProbeEnv): StackPlan {
  const checks: CheckDefinition[] = [];
  const arrs = (["sonarr", "radarr"] as const).filter((id) => isConfigured(env, id));
  const seerr: SeerrAppId | null = env.getSetting("jellyseerr_url")
    ? "jellyseerr"
    : isConfigured(env, "overseerr")
      ? "overseerr"
      : null;
  const hasJellyfin = isConfigured(env, "jellyfin");
  const hasProwlarr = isConfigured(env, "prowlarr");
  const hasQbt = isConfigured(env, "qbittorrent");
  const hasPlex = Boolean(env.getSetting("plex_url"));

  // Reachability of every configured member.
  for (const arrId of arrs) checks.push(...reachability(arrId, arrChecks(arrId), 1, true));
  if (hasJellyfin) checks.push(...reachability("jellyfin", jellyfinChecks(), 1, true));
  if (hasQbt) checks.push(...reachability("qbittorrent", qbittorrentChecks(), 1, false));
  if (hasProwlarr) checks.push(...reachability("prowlarr", prowlarrChecks(), 1, false));
  // Request app: "up" and "API key accepted" both gate the request link.
  if (seerr) checks.push(...prefixChecks(seerr, seerrChecks(seerr).slice(0, 2), seerr).map((d) => ({ ...d, critical: true })));

  if (arrs.length === 0) {
    checks.push(missing(
      "arr",
      "Sonarr/Radarr connected",
      "Neither Sonarr nor Radarr is connected to Talome, so the download chain can't be verified.",
      "Install the Media Server stack or save sonarr_url/radarr_url and their API keys under Settings → Connections.",
      true,
    ));
  }

  // 1. Request
  if (seerr) {
    const deps = [`${seerr}:api`, `${seerr}:auth`];
    checks.push({ id: `request:${seerr}:media-server`, label: `${getAppName(seerr)} knows your library`, appId: seerr, critical: true, dependsOn: deps, run: (ctx) => evaluateSeerrMediaServer(ctx, seerr) });
    checks.push({ id: `request:${seerr}:arr`, label: `${getAppName(seerr)} → Sonarr/Radarr`, appId: seerr, critical: true, dependsOn: deps, timeoutMs: 20_000, run: (ctx) => evaluateSeerrArrConnectivity(ctx, seerr) });
  } else {
    checks.push(missing(
      "request:none",
      "Request app connected",
      "No Overseerr/Jellyseerr connected — requests from phones aren't part of this setup.",
      "Optional: install Jellyseerr or Overseerr so family members can request shows and movies.",
      false,
    ));
  }

  // 2. Indexers
  for (const arrId of arrs) {
    checks.push({ id: `indexer:${arrId}`, label: `${getAppName(arrId)} has indexers`, appId: arrId, critical: true, dependsOn: [`${arrId}:api`], run: (ctx) => evaluateArrIndexers(ctx, arrId) });
  }
  if (hasProwlarr) {
    checks.push({ id: "indexer:prowlarr-sync", label: "Prowlarr syncs indexers to the *arr apps", appId: "prowlarr", dependsOn: ["prowlarr:api"], run: evaluateProwlarrAppSync });
  }

  // 3. Download client
  for (const arrId of arrs) {
    checks.push({ id: `download:${arrId}`, label: `${getAppName(arrId)} → download client`, appId: arrId, critical: true, dependsOn: [`${arrId}:api`], run: (ctx) => evaluateArrDownloadClients(ctx, arrId, { includeImportHealth: false }) });
  }

  // 4. Import (download path mapping)
  for (const arrId of arrs) {
    checks.push({ id: `import:${arrId}`, label: `${getAppName(arrId)} can import finished downloads`, appId: arrId, critical: true, dependsOn: [`download:${arrId}`], timeoutMs: 20_000, run: (ctx) => evaluateImportLink(ctx, arrId) });
  }

  // 5. Library (root folder inside a media-server library)
  if (hasJellyfin) {
    checks.push({ id: "library:jellyfin-paths", label: "Jellyfin library folders exist", appId: "jellyfin", critical: true, dependsOn: ["jellyfin:api"], timeoutMs: 15_000, run: evaluateJellyfinLibraryPaths });
    for (const arrId of arrs) {
      checks.push({ id: `library:${arrId}`, label: `${getAppName(arrId)} imports land in a Jellyfin library`, appId: arrId, critical: true, dependsOn: [`${arrId}:api`, "jellyfin:api"], timeoutMs: 15_000, run: (ctx) => evaluateLibraryPathMapping(ctx, arrId, "jellyfin") });
    }
  } else {
    checks.push(missing(
      "library:none",
      "Media server connected",
      hasPlex ? "Plex is connected; its library mapping isn't verified yet." : "No Jellyfin connected, so imports can't be traced into a library.",
      hasPlex ? "Make sure Plex libraries point at the Sonarr/Radarr root folders." : "Install Jellyfin or save jellyfin_url and jellyfin_api_key under Settings → Connections.",
      !hasPlex,
    ));
  }

  return {
    name: "Media Server",
    checks,
    chain: [
      { id: "request", label: "Request → Sonarr/Radarr", checkIds: ["request:"] },
      { id: "indexer", label: "Search indexers", checkIds: ["indexer:"] },
      { id: "download", label: "Send to download client", checkIds: ["download:"] },
      { id: "import", label: "Import finished downloads", checkIds: ["import:"] },
      { id: "library", label: "Appear in the library", checkIds: ["library:"] },
    ],
  };
}

// ── Photos ───────────────────────────────────────────────────────────────────

function photoPlan(): StackPlan {
  return {
    name: "Photo Management",
    checks: prefixChecks("immich", immichChecks(), "immich"),
    chain: [
      { id: "server", label: "Immich server", checkIds: ["immich:api", "immich:auth"] },
      { id: "storage", label: "Photo storage", checkIds: ["immich:storage"] },
      { id: "mobile", label: "Phone backup reachable", checkIds: ["immich:mobile-url"] },
    ],
  };
}

// ── Books ────────────────────────────────────────────────────────────────────

function booksPlan(env: ProbeEnv): StackPlan {
  const checks = prefixChecks("audiobookshelf", audiobookshelfChecks(), "audiobookshelf");
  const chain: ChainSpec[] = [{ id: "library", label: "Audiobookshelf libraries", checkIds: ["audiobookshelf:"] }];
  if (isConfigured(env, "readarr")) {
    checks.push(...reachability("readarr", arrChecks("readarr"), 1, false));
    checks.push({ id: "import:readarr", label: "Readarr downloads land in an Audiobookshelf library", appId: "readarr", dependsOn: ["readarr:api", "audiobookshelf:api"], timeoutMs: 15_000, run: (ctx) => evaluateLibraryPathMapping(ctx, "readarr", "audiobookshelf") });
    chain.push({ id: "import", label: "Readarr → library", checkIds: ["readarr:", "import:readarr"] });
  }
  return { name: "Books", checks, chain };
}

// ── Smart home ───────────────────────────────────────────────────────────────

function smartHomePlan(): StackPlan {
  return {
    name: "Smart Home",
    checks: prefixChecks("homeassistant", homeAssistantChecks(), "homeassistant"),
    chain: [{ id: "core", label: "Home Assistant", checkIds: ["homeassistant:"] }],
  };
}

const STACKS: StackDefinition[] = [
  { id: "media-server", name: "Media Server", aliases: ["media"], plan: mediaServerPlan },
  { id: "photo-management", name: "Photo Management", aliases: ["photos", "photo"], plan: () => photoPlan() },
  { id: "books", name: "Books", aliases: ["audiobooks"], plan: booksPlan },
  { id: "smart-home", name: "Smart Home", aliases: ["home-automation"], plan: () => smartHomePlan() },
];

export function resolveStackId(stackId: string): string | null {
  const id = stackId.toLowerCase();
  return STACKS.find((s) => s.id === id || s.aliases.includes(id))?.id ?? null;
}

export function getStackPlan(stackId: string, env: ProbeEnv): StackPlan | null {
  const id = resolveStackId(stackId);
  const stack = STACKS.find((s) => s.id === id);
  return stack ? stack.plan(env) : null;
}

export function listVerifiableStacks(): Array<{ id: string; name: string; aliases: string[] }> {
  return STACKS.map(({ id, name, aliases }) => ({ id, name, aliases }));
}
