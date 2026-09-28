/**
 * Immich probe — the "Photos" outcome: server up, storage healthy, and a
 * server URL the phone app can actually reach for automatic backup.
 */

import { z } from "zod";
import { appRequest, probeFetch, resolveConnection, type ProbeCallContext } from "../http.js";
import { outcome, type CheckDefinition } from "../runner.js";
import type { CheckOutcome } from "../types.js";
import { displayUrl, formatBytes, httpFailure, notConfiguredOutcome, parseOr } from "./common.js";

/** Talome setting for the URL phones use (Tailscale / reverse-proxy / LAN). Optional. */
export const IMMICH_EXTERNAL_URL_SETTING = "immich_external_url";

const pingSchema = z.object({ res: z.string() });
const versionSchema = z.object({ major: z.number(), minor: z.number(), patch: z.number() });
const storageSchema = z.object({
  diskSize: z.string().optional(),
  diskAvailable: z.string().optional(),
  diskUsagePercentage: z.number().optional(),
  diskSizeRaw: z.number().optional(),
  diskAvailableRaw: z.number().optional(),
});
const statisticsSchema = z.object({ photos: z.number().optional(), videos: z.number().optional() });
const serverConfigSchema = z.object({ externalDomain: z.string().optional() });

const STORAGE_WARN_PERCENT = 85;
const STORAGE_FAIL_PERCENT = 95;

export async function evaluateImmichPing(ctx: ProbeCallContext): Promise<CheckOutcome> {
  const conn = resolveConnection(ctx.env, "immich");
  if (!conn) return notConfiguredOutcome(ctx, "immich");
  const ping = await appRequest(ctx, "immich", "/api/server/ping", { auth: false });
  if (!ping.ok) return httpFailure(ctx, "immich", ping, "pinging the server");
  if (parseOr(pingSchema, ping.data)?.res !== "pong") {
    return outcome.fail(`${displayUrl(conn.baseUrl)} answered, but not like an Immich server.`, "Check that immich_url points at the Immich server (port 2283), not the database or a proxy error page.");
  }
  const version = await appRequest(ctx, "immich", "/api/server/version", { auth: false });
  const v = version.ok ? parseOr(versionSchema, version.data) : null;
  return outcome.pass(`Immich${v ? ` v${v.major}.${v.minor}.${v.patch}` : ""} is up (${displayUrl(conn.baseUrl)}).`);
}

export async function evaluateImmichAuth(ctx: ProbeCallContext): Promise<CheckOutcome> {
  const conn = resolveConnection(ctx.env, "immich");
  if (!conn) return notConfiguredOutcome(ctx, "immich");
  if (!conn.apiKey) {
    return outcome.warn(
      "No Immich API key saved in Talome, so storage and library checks can't run.",
      "In Immich open Account Settings → API Keys → New API Key, then save it as immich_api_key under Settings → Connections.",
    );
  }
  const me = await appRequest(ctx, "immich", "/api/users/me");
  if (!me.ok) return httpFailure(ctx, "immich", me, "checking the API key");
  return outcome.pass("Immich accepted Talome's API key.");
}

export async function evaluateImmichStorage(ctx: ProbeCallContext): Promise<CheckOutcome> {
  if (!resolveConnection(ctx.env, "immich")?.apiKey) {
    return outcome.skip("Needs an Immich API key (immich_api_key) to read storage.");
  }
  const res = await appRequest(ctx, "immich", "/api/server/storage");
  if (!res.ok) return httpFailure(ctx, "immich", res, "reading storage");
  const storage = parseOr(storageSchema, res.data);
  if (!storage) return outcome.fail("Immich returned unexpected storage data.");

  const available = storage.diskAvailableRaw !== undefined ? formatBytes(storage.diskAvailableRaw) : storage.diskAvailable ?? "unknown";
  const size = storage.diskSizeRaw !== undefined ? formatBytes(storage.diskSizeRaw) : storage.diskSize ?? "unknown";
  const pct = storage.diskUsagePercentage;

  // Library size (admin-only endpoint — optional evidence).
  const stats = await appRequest(ctx, "immich", "/api/server/statistics");
  const s = stats.ok ? parseOr(statisticsSchema, stats.data) : null;
  const library = s ? `; library holds ${s.photos ?? 0} photos and ${s.videos ?? 0} videos` : "";

  const evidence = `${available} free of ${size}${pct !== undefined ? ` (${pct.toFixed(0)}% used)` : ""} on the upload drive${library}.`;
  if (pct !== undefined && pct >= STORAGE_FAIL_PERCENT) {
    return outcome.fail(evidence, "The photo drive is nearly full — new phone backups will fail. Free space or move UPLOAD_LOCATION to a larger drive.");
  }
  if (pct !== undefined && pct >= STORAGE_WARN_PERCENT) {
    return outcome.warn(evidence, "The photo drive is getting full; plan to free space or move UPLOAD_LOCATION to a larger drive.");
  }
  return outcome.pass(evidence);
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0" || h === "::1" || h.startsWith("127.");
}

/**
 * Can a phone reach Immich? Uses Talome's immich_external_url, else Immich's
 * own External Domain setting. A loopback URL can never work from a phone.
 */
export async function evaluateImmichMobileUrl(ctx: ProbeCallContext): Promise<CheckOutcome> {
  const conn = resolveConnection(ctx.env, "immich");
  if (!conn) return notConfiguredOutcome(ctx, "immich");

  let external = ctx.env.getSetting(IMMICH_EXTERNAL_URL_SETTING)?.trim();
  let source = IMMICH_EXTERNAL_URL_SETTING;
  if (!external) {
    const cfg = await appRequest(ctx, "immich", "/api/server/config", { auth: false });
    const domain = cfg.ok ? parseOr(serverConfigSchema, cfg.data)?.externalDomain?.trim() : undefined;
    if (domain) {
      external = domain;
      source = "Immich External Domain";
    }
  }

  const port = (() => {
    try {
      return new URL(conn.baseUrl).port || "2283";
    } catch {
      return "2283";
    }
  })();
  const lan = ctx.env.lanAddress();
  const lanUrl = `http://${lan ?? "<server-ip>"}:${port}`;

  if (!external) {
    return outcome.warn(
      `No external URL configured. At home the phone app can use ${lanUrl}; backups pause when the phone leaves your network.`,
      `For backup from anywhere, expose Immich through Tailscale or Talome's reverse proxy, then set Immich → Administration → Settings → Server → External Domain (or save it as ${IMMICH_EXTERNAL_URL_SETTING}).`,
    );
  }

  let url: URL;
  try {
    url = new URL(external);
  } catch {
    return outcome.fail(`${source} "${external}" is not a valid URL.`, "Use a full URL such as https://photos.example.com or http://100.x.y.z:2283.");
  }
  if (isLoopbackHost(url.hostname)) {
    return outcome.fail(
      `${source} is ${displayUrl(url.toString())}, which only works on the server itself — a phone can't reach it.`,
      `Use ${lanUrl} (home network) or a Tailscale / reverse-proxy URL instead.`,
    );
  }

  const res = await probeFetch(ctx, `${url.origin}${url.pathname.replace(/\/+$/, "")}/api/server/ping`);
  const pong = res.ok && parseOr(pingSchema, res.data)?.res === "pong";
  if (!pong) {
    return outcome.fail(
      `Immich is not reachable at ${displayUrl(url.toString())} (${source}): ${res.error ?? "unexpected response"}.`,
      "Check the reverse-proxy route / Tailscale serve config and DNS for that address.",
    );
  }
  return outcome.pass(
    `Phones can use ${displayUrl(url.toString())} (${source}) — reachable from this server; on home Wi-Fi ${lanUrl} also works.`,
  );
}

export function immichChecks(): CheckDefinition[] {
  return [
    { id: "api", label: "Immich server up", critical: true, appId: "immich", run: evaluateImmichPing },
    { id: "auth", label: "API key accepted", appId: "immich", dependsOn: ["api"], run: evaluateImmichAuth },
    { id: "storage", label: "Upload storage healthy", appId: "immich", dependsOn: ["auth"], run: evaluateImmichStorage },
    { id: "mobile-url", label: "Server URL reachable for mobile backup", appId: "immich", dependsOn: ["api"], run: evaluateImmichMobileUrl },
  ];
}
