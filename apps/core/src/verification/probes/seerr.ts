/**
 * Overseerr / Jellyseerr probe — requests only work when the request app is
 * connected to the media server (to know what you have) and to Sonarr/Radarr
 * (to fulfil requests).
 */

import { z } from "zod";
import { appRequest, getAppName, resolveConnection, type ProbeCallContext } from "../http.js";
import { outcome, type CheckDefinition } from "../runner.js";
import type { CheckOutcome } from "../types.js";
import { apiReachableCheck, httpFailure, listPreview, parseOr, versionSchema } from "./common.js";

export type SeerrAppId = "overseerr" | "jellyseerr";

const mediaServerSchema = z.object({
  name: z.string().optional(),
  ip: z.string().optional(),
  hostname: z.string().optional(),
  port: z.number().optional(),
  libraries: z.array(z.object({ name: z.string().optional(), enabled: z.boolean().optional() })).optional(),
});

const arrServerSchema = z.array(
  z.object({
    id: z.number().optional(),
    name: z.string().optional(),
    hostname: z.string().optional(),
    port: z.number().optional(),
    apiKey: z.string().optional(),
    useSsl: z.boolean().optional(),
    baseUrl: z.string().optional(),
    isDefault: z.boolean().optional(),
    is4k: z.boolean().optional(),
  }).loose(),
);
type SeerrArrServer = z.infer<typeof arrServerSchema>[number];

export async function evaluateSeerrAuth(ctx: ProbeCallContext, appId: SeerrAppId): Promise<CheckOutcome> {
  const conn = resolveConnection(ctx.env, appId);
  if (!conn?.apiKey) {
    return outcome.fail(
      `No ${getAppName(appId)} API key saved in Talome.`,
      `Copy the API key from ${getAppName(appId)} → Settings → General and save it as ${conn?.keySettingKey ?? `${appId}_api_key`} under Settings → Connections.`,
    );
  }
  const res = await appRequest(ctx, appId, "/api/v1/settings/main");
  if (!res.ok) return httpFailure(ctx, appId, res, "reading settings with the API key");
  return outcome.pass(`${getAppName(appId)} accepted Talome's API key.`);
}

export async function evaluateSeerrMediaServer(ctx: ProbeCallContext, appId: SeerrAppId): Promise<CheckOutcome> {
  const name = getAppName(appId);
  const tried: string[] = [];
  /**
   * Upstream Overseerr (sctx/overseerr) is Plex-only: it has no
   * /settings/jellyfin route. Jellyseerr — often saved as overseerr_url,
   * since Talome's overseerr tools drive both — does.
   */
  let jellyfinUnsupported = false;
  for (const server of ["jellyfin", "plex"] as const) {
    const res = await appRequest(ctx, appId, `/api/v1/settings/${server}`);
    if (!res.ok) {
      if (server === "jellyfin" && res.status === 404) jellyfinUnsupported = true;
      tried.push(`${server}: ${res.error ?? `HTTP ${res.status}`}`);
      continue;
    }
    const settings = parseOr(mediaServerSchema, res.data);
    const host = settings?.ip || settings?.hostname;
    if (!settings || !host) continue;
    const enabled = (settings.libraries ?? []).filter((l) => l.enabled);
    const serverName = server === "jellyfin" ? "Jellyfin" : "Plex";
    const where = `${host}${settings.port ? `:${settings.port}` : ""}`;
    if (enabled.length === 0) {
      return outcome.warn(
        `${name} is connected to ${serverName} at ${where}, but no library is enabled — it can't tell what you already have.`,
        `Enable your libraries in ${name} → Settings → ${serverName} and run a library sync.`,
      );
    }
    return outcome.pass(`${name} is connected to ${serverName} at ${where} with ${listPreview(enabled.map((l) => l.name ?? "library"))} enabled.`);
  }
  if (jellyfinUnsupported) {
    if (ctx.env.getSetting("plex_url") || !ctx.env.getSetting("jellyfin_url")) {
      return outcome.fail(
        `${name} is not connected to Plex (it only supports Plex).`,
        `Connect Plex in ${name} → Settings → Plex, then enable your libraries and run a library sync.`,
      );
    }
    // A Jellyfin setup with Plex-only Overseerr (what the Media Server stack
    // installs): no setting can connect them. Requests still reach
    // Sonarr/Radarr, so this is degraded, not a broken chain — and the
    // remediation must not send the assistant to a tool that cannot work.
    return outcome.warn(
      `${name} only supports Plex, so it can't read your Jellyfin library — requests still go to Sonarr/Radarr, but it can't show what you already have.`,
      "Replace Overseerr with Jellyseerr (the Jellyfin edition of Overseerr) and save it as jellyseerr_url / jellyseerr_api_key under Settings → Connections. overseerr_configure_jellyfin cannot work with Overseerr.",
    );
  }
  return outcome.fail(
    `${name} is not connected to a media server${tried.length === 2 ? ` (${tried.join("; ")})` : ""}.`,
    appId === "overseerr" ? "Ask the assistant to run overseerr_configure_jellyfin, or connect it in Overseerr → Settings." : `Connect Jellyfin in ${name} → Settings → Jellyfin.`,
  );
}

async function getSeerrArrServers(ctx: ProbeCallContext, appId: SeerrAppId, type: "sonarr" | "radarr"): Promise<SeerrArrServer[] | null> {
  const res = await appRequest(ctx, appId, `/api/v1/settings/${type}`);
  if (!res.ok) return null;
  const servers = parseOr(arrServerSchema, res.data);
  for (const s of servers ?? []) if (s.apiKey) ctx.env.secrets.add(s.apiKey);
  return servers;
}

export async function evaluateSeerrArrConfigured(ctx: ProbeCallContext, appId: SeerrAppId): Promise<CheckOutcome> {
  const name = getAppName(appId);
  const [sonarr, radarr] = await Promise.all([getSeerrArrServers(ctx, appId, "sonarr"), getSeerrArrServers(ctx, appId, "radarr")]);
  if (!sonarr && !radarr) return outcome.fail(`${name} did not return its Sonarr/Radarr settings.`);
  const describe = (servers: SeerrArrServer[]) => servers.map((s) => `${s.name ?? "server"} (${s.hostname ?? "?"}:${s.port ?? "?"}${s.isDefault ? ", default" : ""})`);
  const hasSonarr = (sonarr ?? []).length > 0;
  const hasRadarr = (radarr ?? []).length > 0;
  const listed = [...describe(sonarr ?? []), ...describe(radarr ?? [])];
  if (!hasSonarr && !hasRadarr) {
    return outcome.fail(
      `${name} has no Sonarr or Radarr server, so approved requests are never downloaded.`,
      "Ask the assistant to run overseerr_configure_sonarr and overseerr_configure_radarr.",
    );
  }
  const noDefault = [
    ...(hasSonarr && !(sonarr ?? []).some((s) => s.isDefault && !s.is4k) ? ["Sonarr"] : []),
    ...(hasRadarr && !(radarr ?? []).some((s) => s.isDefault && !s.is4k) ? ["Radarr"] : []),
  ];
  if (!hasSonarr || !hasRadarr) {
    return outcome.warn(
      `${name} only has ${hasSonarr ? "Sonarr" : "Radarr"}: ${listPreview(listed)} — ${hasSonarr ? "movie" : "TV"} requests can't be fulfilled.`,
      `Add ${hasSonarr ? "Radarr" : "Sonarr"} in ${name} → Settings → Services.`,
    );
  }
  if (noDefault.length > 0) {
    return outcome.warn(`${listPreview(listed)} — no default ${noDefault.join("/")} server, so requests won't be sent automatically.`, `Mark one ${noDefault.join("/")} server as default in ${name} → Settings → Services.`);
  }
  return outcome.pass(`${listPreview(listed)}.`);
}

/**
 * Ask the request app to connect to each configured Sonarr/Radarr using its
 * own saved settings. Read-only: the test endpoint only fetches profiles and
 * root folders from the *arr.
 */
export async function evaluateSeerrArrConnectivity(ctx: ProbeCallContext, appId: SeerrAppId): Promise<CheckOutcome> {
  const name = getAppName(appId);
  const results: string[] = [];
  const failures: string[] = [];
  for (const type of ["sonarr", "radarr"] as const) {
    const servers = await getSeerrArrServers(ctx, appId, type);
    for (const s of servers ?? []) {
      const res = await appRequest(ctx, appId, `/api/v1/settings/${type}/test`, {
        method: "POST",
        body: { hostname: s.hostname, port: s.port, apiKey: s.apiKey, useSsl: s.useSsl ?? false, baseUrl: s.baseUrl ?? "" },
      });
      const label = `${s.name ?? type} (${s.hostname ?? "?"}:${s.port ?? "?"})`;
      if (res.ok) results.push(label);
      else failures.push(`${label}: ${res.error ?? `HTTP ${res.status}`}`);
    }
  }
  if (results.length === 0 && failures.length === 0) return outcome.skip(`${name} has no Sonarr/Radarr servers to test.`);
  if (failures.length > 0) {
    return outcome.fail(
      `${name} cannot reach ${listPreview(failures, 2)}`,
      `Fix the hostname/port/API key in ${name} → Settings → Services. Inside Docker use the container name (e.g. sonarr) on the shared network, not localhost.`,
    );
  }
  return outcome.pass(`${name} reached ${listPreview(results)}.`);
}

export function seerrChecks(appId: SeerrAppId): CheckDefinition[] {
  const name = getAppName(appId);
  return [
    apiReachableCheck(appId, "/api/v1/status", (data) => {
      const v = parseOr(versionSchema, data)?.version;
      return `${name}${v ? ` ${v}` : ""} is up`;
    }, { auth: false, requireKey: false, label: `${name} up` }),
    { id: "auth", label: "API key accepted", appId, dependsOn: ["api"], run: (ctx) => evaluateSeerrAuth(ctx, appId) },
    { id: "media-server", label: "Connected to the media server", appId, dependsOn: ["auth"], run: (ctx) => evaluateSeerrMediaServer(ctx, appId) },
    { id: "arr", label: "Sonarr/Radarr configured", appId, dependsOn: ["auth"], run: (ctx) => evaluateSeerrArrConfigured(ctx, appId) },
    { id: "arr-connectivity", label: "Can reach Sonarr/Radarr", appId, dependsOn: ["arr"], timeoutMs: 20_000, run: (ctx) => evaluateSeerrArrConnectivity(ctx, appId) },
  ];
}
