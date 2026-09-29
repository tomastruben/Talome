/**
 * TLS policy for proxy routes Talome creates on its own (app install, local
 * domains). Apps that declare `requiresHttps` (Umbrel manifests) break over
 * plain HTTP, so their routes are always served with TLS — Caddy's internal
 * CA (`tls internal`) when the configured default would be HTTP-only — and an
 * install that cannot get a TLS route says so instead of silently serving
 * HTTP.
 *
 * Pure policy + settings/DB reads only: no Docker, no Caddy reloads, so the
 * install pipeline and the proxy layer can both import it without cycles.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { getSetting } from "../utils/settings.js";

export const PROXY_TLS_MODES = ["auto", "selfsigned", "manual", "off"] as const;
export type ProxyTlsMode = (typeof PROXY_TLS_MODES)[number];

function isProxyTlsMode(value: string | undefined): value is ProxyTlsMode {
  return value !== undefined && (PROXY_TLS_MODES as readonly string[]).includes(value);
}

/** Domains Let's Encrypt can never issue for — Caddy's internal CA is the only TLS option. */
export function isLocalProxyDomain(baseDomain: string): boolean {
  return baseDomain.endsWith(".local") || baseDomain.endsWith(".lan") || baseDomain.endsWith(".home");
}

/**
 * TLS mode for an automatically created app route.
 * - local-only base domains always use Caddy's internal CA
 * - otherwise the configured default (`proxy_default_tls`, "auto" when unset/invalid)
 * - …except that an app requiring HTTPS is never registered with TLS off:
 *   it falls back to the internal CA, which works on every host.
 */
export function resolveAppTlsMode(
  baseDomain: string,
  defaultTls: string | undefined,
  requiresHttps: boolean,
): ProxyTlsMode {
  if (isLocalProxyDomain(baseDomain)) return "selfsigned";
  const mode: ProxyTlsMode = isProxyTlsMode(defaultTls) ? defaultTls : "auto";
  if (mode === "off" && requiresHttps) return "selfsigned";
  return mode;
}

export type AppHttpsRoute =
  | { available: true; domain: string; tlsMode: ProxyTlsMode }
  | { available: false; reason: "proxy-disabled" | "no-web-port" };

/**
 * Where an app is (or will be, once auto-registration runs) served over TLS
 * by Talome's reverse proxy. Reads settings and existing routes only.
 */
export function getAppHttpsRoute(appId: string, opts: { webPort: number | null | undefined; requiresHttps: boolean }): AppHttpsRoute {
  const existing = readAppRoute(appId);
  if (existing && existing.tls_mode !== "off") {
    return { available: true, domain: existing.domain, tlsMode: existing.tls_mode };
  }

  const baseDomain = getSetting("proxy_base_domain")?.trim();
  if (getSetting("proxy_enabled") !== "true" || !baseDomain) return { available: false, reason: "proxy-disabled" };
  if (!opts.webPort) return { available: false, reason: "no-web-port" };

  // Auto-registration upgrades an existing HTTP-only route for such apps.
  const tlsMode = resolveAppTlsMode(baseDomain, getSetting("proxy_default_tls"), opts.requiresHttps);
  if (tlsMode === "off") return { available: false, reason: "proxy-disabled" };
  return { available: true, domain: existing?.domain ?? `${appId}.${baseDomain}`, tlsMode };
}

/**
 * The warning an install result carries when an app requires HTTPS but
 * Talome has no TLS route for it. Null when HTTPS is not required or a TLS
 * route is (or will be) available.
 */
export function requiresHttpsInstallWarning(
  appId: string,
  appName: string,
  opts: { webPort: number | null | undefined; requiresHttps: boolean },
): string | null {
  if (!opts.requiresHttps) return null;
  const route = getAppHttpsRoute(appId, opts);
  if (route.available) return null;
  if (route.reason === "no-web-port") {
    return `${appName} requires HTTPS, but it has no web port Talome's reverse proxy can serve over TLS, so it is only reachable over plain HTTP and may not work.`;
  }
  const where = opts.webPort ? `http://<server>:${opts.webPort}` : "its host port";
  return `${appName} requires HTTPS, but Talome's reverse proxy is not enabled, so it is only reachable over plain HTTP (${where}) and may not work. Turn on Local Domains in Settings → Networking to serve it over HTTPS with Talome's internal certificate.`;
}

interface AppRouteRow {
  domain: string;
  tls_mode: ProxyTlsMode;
}

function readAppRoute(appId: string): AppRouteRow | undefined {
  try {
    return db.get(sql`SELECT domain, tls_mode FROM proxy_routes WHERE app_id = ${appId} AND enabled = 1 LIMIT 1`) as AppRouteRow | undefined;
  } catch {
    return undefined;
  }
}
