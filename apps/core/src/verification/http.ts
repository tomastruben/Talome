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
  /** Saved URL without userinfo — safe to show and to hand to fetch. */
  baseUrl: string;
  /** Settings key the URL was read from (for remediation text). */
  urlSettingKey: string;
  /** Settings key the credential was read from. */
  keySettingKey: string;
  apiKey?: string;
  username?: string;
  password?: string;
  /** Credentials that were embedded in the saved URL (user:pass@host), sent as HTTP Basic auth. */
  urlCredentials?: { username: string; password: string };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Split `scheme://user:pass@host…` into the URL without userinfo and the
 * credentials. fetch refuses URLs with credentials — and puts the whole URL,
 * password included, into its error message.
 */
export function splitUrlCredentials(raw: string): { url: string; credentials?: { username: string; password: string } } {
  try {
    const parsed = new URL(raw);
    if (!parsed.username && !parsed.password) return { url: raw };
  } catch {
    // Not a valid URL (e.g. a raw "/" in the password): split it by hand.
  }
  const schemeEnd = raw.indexOf("://");
  if (schemeEnd < 0) return { url: raw };
  const rest = raw.slice(schemeEnd + 3);
  const authorityEnd = rest.search(/[/?#]/);
  let authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
  // A password with a raw "/" (not percent-encoded) ends the authority early;
  // the userinfo then runs to the last "@" before any query or fragment.
  if (!authority.includes("@")) {
    const head = rest.split(/[?#]/, 1)[0] ?? "";
    if (!head.includes("@")) return { url: raw };
    authority = head.slice(0, head.lastIndexOf("@") + 1);
  }
  const at = authority.lastIndexOf("@");
  const userinfo = authority.slice(0, at);
  const url = `${raw.slice(0, schemeEnd + 3)}${rest.slice(at + 1)}`;
  const colon = userinfo.indexOf(":");
  const username = safeDecode(colon < 0 ? userinfo : userinfo.slice(0, colon));
  const password = colon < 0 ? "" : safeDecode(userinfo.slice(colon + 1));
  return { url, credentials: { username, password } };
}

/** Remove `user:pass@` from every URL in free text (error messages that echo a URL). */
export function stripUrlCredentials(text: string): string {
  return text.replace(/\/\/[^\s"'<>]*@/g, "//");
}

function remember(env: ProbeEnv, credentials: { username: string; password: string } | undefined): void {
  if (!credentials?.password) return;
  env.secrets.add(credentials.password);
  env.secrets.add(encodeURIComponent(credentials.password));
  env.secrets.add(Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64"));
}

function basicAuthHeader(credentials: { username: string; password: string }): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
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

  // A URL with user:pass@ (an app behind a basic-auth proxy): the password is
  // a secret for this run, and never part of the URL we fetch or show.
  const split = splitUrlCredentials(url.trim());
  remember(env, split.credentials);
  const baseUrl = split.url.replace(/\/+$/, "");
  const urlCredentials = split.credentials ? { urlCredentials: split.credentials } : {};
  if (appId === "qbittorrent") {
    return {
      appId,
      baseUrl,
      urlSettingKey: urlKey,
      keySettingKey: keyKey,
      username: env.getSetting("qbittorrent_username") ?? "admin",
      password: env.getSetting(keyKey) ?? "",
      ...urlCredentials,
    };
  }
  return { appId, baseUrl, urlSettingKey: urlKey, keySettingKey: keyKey, apiKey: env.getSetting(keyKey), ...urlCredentials };
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
    return clip(stripUrlCredentials(err.message), 160);
  }
  return clip(stripUrlCredentials(String(err)), 160);
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
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      // qBittorrent's CSRF protection rejects logins without a matching Referer/Origin.
      Referer: conn.baseUrl,
      Origin: conn.baseUrl,
    };
    if (conn.urlCredentials) headers.Authorization = basicAuthHeader(conn.urlCredentials);
    const res = await probeFetch(ctx, `${conn.baseUrl}/api/v2/auth/login`, {
      method: "POST",
      headers,
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
  const override = opts.baseUrl !== undefined ? splitUrlCredentials(opts.baseUrl.trim()) : undefined;
  remember(ctx.env, override?.credentials);
  const baseUrl = (override?.url ?? conn.baseUrl).replace(/\/+$/, "");
  const urlCredentials = override ? override.credentials : conn.urlCredentials;
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
    // Basic auth for a proxy in front of the app, unless the app's own scheme
    // already uses the Authorization header.
    if (urlCredentials && !headers.Authorization) headers.Authorization = basicAuthHeader(urlCredentials);

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
