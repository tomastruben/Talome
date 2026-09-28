/**
 * Read-only app API access for probes.
 *
 * Connection details come from the app-registry (settings keys for URL and
 * credential, auth scheme, settings fallbacks), so every probe talks to an
 * app with the same settings and auth scheme as Talome's AI tools. This layer
 * only adds what probes need on top: abort signals, per-run caching and
 * secret-safe error descriptions.
 */

import { APP_AUTH_SCHEMES, APP_SETTINGS_FALLBACK, getConnectableApp } from "../app-registry/index.js";
import type { HttpResult, ProbeEnv, QbtSession } from "./env.js";
import { clip } from "./redact.js";

export interface ProbeCallContext {
  env: ProbeEnv;
  signal: AbortSignal;
}

export interface AppConnection {
  appId: string;
  baseUrl: string;
  /** Settings key the URL was read from (for remediation text). */
  urlSettingKey: string;
  /** Settings key the credential was read from. */
  keySettingKey: string;
  apiKey?: string;
  username?: string;
  password?: string;
}

export function getAppName(appId: string): string {
  return getConnectableApp(appId)?.name ?? appId;
}

export function resolveConnection(env: ProbeEnv, appId: string): AppConnection | null {
  const caps = getConnectableApp(appId);
  if (!caps) return null;

  let urlKey = caps.apiBaseSettingKey;
  let keyKey = caps.apiKeySettingKey;
  let url = env.getSetting(urlKey);
  const fallback = Object.hasOwn(APP_SETTINGS_FALLBACK, appId) ? getConnectableApp(APP_SETTINGS_FALLBACK[appId]) : undefined;
  if (!url && fallback) {
    urlKey = fallback.apiBaseSettingKey;
    keyKey = fallback.apiKeySettingKey;
    url = env.getSetting(urlKey);
  }
  if (!url) return null;

  const baseUrl = url.trim().replace(/\/+$/, "");
  if (appId === "qbittorrent") {
    return {
      appId,
      baseUrl,
      urlSettingKey: urlKey,
      keySettingKey: keyKey,
      username: env.getSetting("qbittorrent_username") ?? "admin",
      password: env.getSetting(keyKey) ?? "",
    };
  }
  return { appId, baseUrl, urlSettingKey: urlKey, keySettingKey: keyKey, apiKey: env.getSetting(keyKey) };
}

function describeNetworkError(err: unknown, signal: AbortSignal): string {
  if (signal.aborted) return "request aborted (timed out)";
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string } }).cause;
    const code = cause?.code;
    if (code === "ECONNREFUSED") return "connection refused — is the container running?";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "host name could not be resolved";
    if (code === "ECONNRESET") return "connection reset by the app";
    if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "host unreachable";
    if (err.name === "AbortError" || err.name === "TimeoutError") return "request aborted (timed out)";
    return clip(err.message, 160);
  }
  return clip(String(err), 160);
}

function describeBody(data: unknown): string {
  if (data === undefined || data === null || data === "") return "";
  if (typeof data === "string") return clip(data, 160);
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const message = obj.message ?? obj.error ?? obj.title;
    if (typeof message === "string") return clip(message, 160);
    if (Array.isArray(data)) {
      const msgs = data
        .map((d) => (d && typeof d === "object" ? (d as Record<string, unknown>).errorMessage ?? (d as Record<string, unknown>).message : undefined))
        .filter((m): m is string => typeof m === "string");
      if (msgs.length > 0) return clip(msgs.join("; "), 160);
    }
    try {
      return clip(JSON.stringify(data), 160);
    } catch {
      return "";
    }
  }
  return "";
}

/** Low-level fetch that never throws and always honours the check's abort signal. */
export async function probeFetch(
  ctx: ProbeCallContext,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  try {
    const res = await ctx.env.fetch(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      signal: ctx.signal,
    });
    const contentType = res.headers.get("content-type") ?? "";
    let data: unknown;
    try {
      data = contentType.includes("json") ? await res.json() : await res.text();
    } catch {
      data = undefined;
    }
    const setCookie = res.headers.get("set-cookie") ?? undefined;
    if (!res.ok) {
      const detail = describeBody(data);
      return { ok: false, status: res.status, data, error: `HTTP ${res.status}${detail ? ` — ${detail}` : ""}`, setCookie };
    }
    return { ok: true, status: res.status, data, setCookie };
  } catch (err: unknown) {
    return { ok: false, status: 0, error: describeNetworkError(err, ctx.signal) };
  }
}

// ── qBittorrent session ─────────────────────────────────────────────────────

/**
 * Log in to qBittorrent. Cached per verification run (not across runs) so
 * every check reuses one session and a stale cookie can never leak between runs.
 */
export function qbtLogin(ctx: ProbeCallContext): Promise<QbtSession> {
  const conn = resolveConnection(ctx.env, "qbittorrent");
  if (!conn) return Promise.resolve({ ok: false, status: 0, sid: null, error: "not configured" });

  const cached = ctx.env.qbtSessions.get(conn.baseUrl);
  if (cached) return cached;

  const pending = (async (): Promise<QbtSession> => {
    const body = new URLSearchParams({ username: conn.username ?? "admin", password: conn.password ?? "" });
    const res = await probeFetch(ctx, `${conn.baseUrl}/api/v2/auth/login`, {
      method: "POST",
      // qBittorrent's CSRF protection rejects logins without a matching Referer/Origin.
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: conn.baseUrl, Origin: conn.baseUrl },
      body: body.toString(),
    });
    if (res.status === 403) {
      return { ok: false, status: 403, sid: null, error: "qBittorrent refused the login (HTTP 403) — the IP may be banned after too many failed attempts" };
    }
    if (!res.ok) return { ok: false, status: res.status, sid: null, error: res.error };
    const text = typeof res.data === "string" ? res.data.trim() : "";
    if (text.startsWith("Fails")) return { ok: false, status: 401, sid: null, error: "username or password rejected" };
    const sid = res.setCookie?.match(/SID=([^;]+)/)?.[1] ?? null;
    if (sid) ctx.env.secrets.add(sid);
    return { ok: true, status: res.status, sid };
  })();

  ctx.env.qbtSessions.set(conn.baseUrl, pending);
  // A login aborted by this check's timeout must not be reused by the next check.
  ctx.signal.addEventListener("abort", () => {
    if (ctx.env.qbtSessions.get(conn.baseUrl) === pending) ctx.env.qbtSessions.delete(conn.baseUrl);
  }, { once: true });
  pending.then((s) => {
    if (!s.ok && s.status === 0) ctx.env.qbtSessions.delete(conn.baseUrl);
  }).catch(() => ctx.env.qbtSessions.delete(conn.baseUrl));
  return pending;
}

// ── App requests ────────────────────────────────────────────────────────────

export interface AppRequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Send credentials (default true). */
  auth?: boolean;
  /** Override the base URL (e.g. probing an external URL). */
  baseUrl?: string;
}

/**
 * Call an app's API with the credentials Talome has stored for it.
 * GET responses are cached for the duration of one verification run.
 */
export async function appRequest<T = unknown>(
  ctx: ProbeCallContext,
  appId: string,
  path: string,
  opts: AppRequestOptions = {},
): Promise<HttpResult<T>> {
  const conn = resolveConnection(ctx.env, appId);
  if (!conn) return { ok: false, status: 0, error: `${getAppName(appId)} is not configured in Talome` };

  const method = opts.method ?? "GET";
  const baseUrl = (opts.baseUrl ?? conn.baseUrl).replace(/\/+$/, "");
  const useAuth = opts.auth !== false;
  const cacheKey = method === "GET" ? `${appId} ${useAuth ? "auth" : "anon"} ${baseUrl}${path}` : null;

  if (cacheKey) {
    const hit = ctx.env.cache.get(cacheKey);
    if (hit) return (await hit) as HttpResult<T>;
  }

  const run = async (): Promise<HttpResult> => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    if (useAuth) {
      const style = Object.hasOwn(APP_AUTH_SCHEMES, appId) ? APP_AUTH_SCHEMES[appId] : "none";
      if (style === "qbt-cookie") {
        const session = await qbtLogin(ctx);
        if (!session.ok) return { ok: false, status: session.status, error: `qBittorrent login failed: ${session.error ?? "unknown error"}` };
        if (session.sid) headers.Cookie = `SID=${session.sid}`;
        headers.Referer = conn.baseUrl;
      } else if (conn.apiKey) {
        if (style === "x-api-key") headers["X-Api-Key"] = conn.apiKey;
        else if (style === "mediabrowser") headers.Authorization = `MediaBrowser Token="${conn.apiKey}"`;
        else if (style === "bearer") headers.Authorization = `Bearer ${conn.apiKey}`;
      }
    }

    return probeFetch(ctx, `${baseUrl}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  };

  const pending = run();
  if (cacheKey) {
    ctx.env.cache.set(cacheKey, pending);
    // Never keep aborted requests: a later check must be allowed to retry.
    // Evict synchronously on abort — the runner starts the next check as soon
    // as this one times out, before the aborted fetch has settled.
    const evict = () => {
      if (ctx.env.cache.get(cacheKey) === pending) ctx.env.cache.delete(cacheKey);
    };
    ctx.signal.addEventListener("abort", evict, { once: true });
    void pending.then((r) => {
      if (r.status === 0 && ctx.signal.aborted) evict();
    });
  }
  return (await pending) as HttpResult<T>;
}
