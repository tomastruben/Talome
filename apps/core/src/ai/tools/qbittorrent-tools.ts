import { tool } from "ai";
import { z } from "zod";
import { getSetting } from "../../utils/settings.js";

interface QbtConfig {
  baseUrl: string;
  username: string;
  password: string;
}

function getQbtConfig(): QbtConfig | null {
  const baseUrl = getSetting("qbittorrent_url");
  if (!baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    username: getSetting("qbittorrent_username") ?? "admin",
    password: getSetting("qbittorrent_password") ?? "",
  };
}

// ── Session management ──────────────────────────────────────────────────────
// qBittorrent requires cookie-based auth (SID). We cache the session and
// re-authenticate automatically when it expires.

let cachedSid: string | null = null;
let sidExpiresAt = 0;

async function authenticate(config: QbtConfig): Promise<string | null> {
  try {
    const body = new URLSearchParams({
      username: config.username,
      password: config.password,
    });
    const res = await fetch(`${config.baseUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    // Extract SID from Set-Cookie header
    const setCookie = res.headers.get("set-cookie") ?? "";
    const match = setCookie.match(/SID=([^;]+)/);
    if (match) {
      cachedSid = match[1];
      // qBittorrent sessions last ~3600s by default; refresh at 50 min
      sidExpiresAt = Date.now() + 50 * 60 * 1000;
      return cachedSid;
    }

    // Some versions return "Ok." in body on success without Set-Cookie
    const text = await res.text().catch(() => "");
    if (text.includes("Ok")) {
      // Try to extract from any cookie jar behavior
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

async function getSid(config: QbtConfig): Promise<string | null> {
  if (cachedSid && Date.now() < sidExpiresAt) return cachedSid;
  return authenticate(config);
}

async function qbtFetch(path: string, options?: RequestInit): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const config = getQbtConfig();
  if (!config) {
    return { success: false, error: "qBittorrent is not configured. Add qbittorrent_url in Settings." };
  }

  const sid = await getSid(config);
  const url = `${config.baseUrl}${path}`;
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string> ?? {}),
  };
  if (sid) {
    headers["Cookie"] = `SID=${sid}`;
  }

  try {
    let res = await fetch(url, {
      ...options,
      headers,
      signal: AbortSignal.timeout(8000),
    });

    // If 403, session may have expired — re-authenticate once and retry
    if (res.status === 403 && sid) {
      cachedSid = null;
      const newSid = await authenticate(config);
      if (newSid) {
        headers["Cookie"] = `SID=${newSid}`;
        res = await fetch(url, {
          ...options,
          headers,
          signal: AbortSignal.timeout(8000),
        });
      }
    }

    if (!res.ok) {
      return { success: false, error: `qBittorrent API error ${res.status}` };
    }
    const ct = res.headers.get("content-type") ?? "";
    const data = ct.includes("application/json") ? await res.json() : await res.text();
    return { success: true, data };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── qbt_get_version ───────────────────────────────────────────────────────────

export const qbtGetVersionTool = tool({
  description: "Get the qBittorrent version and connection status.",
  inputSchema: z.object({}),
  execute: async () => {
    const result = await qbtFetch("/api/v2/app/version");
    if (!result.success) return result;
    const buildInfo = await qbtFetch("/api/v2/app/buildInfo");
    return { success: true, version: result.data, buildInfo: buildInfo.success ? buildInfo.data : {} };
  },
});

// ── qbt_get_preferences ───────────────────────────────────────────────────────

export const qbtGetPreferencesTool = tool({
  description: "Get qBittorrent preferences including download paths, speed limits, connection settings, and more.",
  inputSchema: z.object({}),
  execute: async () => {
    const result = await qbtFetch("/api/v2/app/preferences");
    if (!result.success) return result;
    return { success: true, preferences: result.data };
  },
});

// ── qbt_set_preferences ───────────────────────────────────────────────────────

export const qbtSetPreferencesTool = tool({
  description:
    "Update qBittorrent preferences. Common settings: save_path (default download dir), incomplete_files_ext (e.g. .!qb), max_ratio (seeding ratio), upload_limit / download_limit (bytes/s, 0 = unlimited).",
  inputSchema: z.object({
    preferences: z.record(z.string(), z.unknown()).describe("Object of preference key-value pairs to update"),
  }),
  execute: async ({ preferences }) => {
    const body = new URLSearchParams({ json: JSON.stringify(preferences) });
    const result = await qbtFetch("/api/v2/app/setPreferences", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!result.success) return result;
    return { success: true, message: "qBittorrent preferences updated.", updated: preferences };
  },
});

// ── qbt_set_download_path ─────────────────────────────────────────────────────

export const qbtSetDownloadPathTool = tool({
  description: "Set the default download directory for qBittorrent.",
  inputSchema: z.object({
    path: z.string().describe("Absolute path to the download directory, e.g. /data/downloads"),
  }),
  execute: async ({ path }) => {
    const body = new URLSearchParams({ json: JSON.stringify({ save_path: path }) });
    const result = await qbtFetch("/api/v2/app/setPreferences", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!result.success) return result;
    return { success: true, message: `Default download path set to ${path}.` };
  },
});

// ── qbt_set_speed_limits ──────────────────────────────────────────────────────

export const qbtSetSpeedLimitsTool = tool({
  description: "Set global upload and download speed limits for qBittorrent. Use 0 for unlimited.",
  inputSchema: z.object({
    uploadLimit: z.number().describe("Upload limit in bytes/s (0 = unlimited)"),
    downloadLimit: z.number().describe("Download limit in bytes/s (0 = unlimited)"),
  }),
  execute: async ({ uploadLimit, downloadLimit }) => {
    const body = new URLSearchParams({
      json: JSON.stringify({ up_limit: uploadLimit, dl_limit: downloadLimit }),
    });
    const result = await qbtFetch("/api/v2/app/setPreferences", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!result.success) return result;
    const toMB = (b: number) => (b === 0 ? "unlimited" : `${(b / 1024 / 1024).toFixed(1)} MB/s`);
    return { success: true, message: `Speed limits set: ↑ ${toMB(uploadLimit)} / ↓ ${toMB(downloadLimit)}.` };
  },
});

// ── qbt_list_torrents ─────────────────────────────────────────────────────────

export const qbtListTorrentsTool = tool({
  description: "List active torrents in qBittorrent with their progress, state, and sizes.",
  inputSchema: z.object({
    filter: z.enum(["all", "downloading", "seeding", "completed", "paused", "stalled"]).default("all"),
  }),
  execute: async ({ filter }) => {
    const result = await qbtFetch(`/api/v2/torrents/info?filter=${filter}`);
    if (!result.success) return result;
    const torrents = (result.data as Array<Record<string, unknown>>).map((t) => ({
      hash: t.hash,
      name: t.name,
      state: t.state,
      progress: Math.round((t.progress as number) * 100),
      size: t.size,
      dlspeed: t.dlspeed,
      upspeed: t.upspeed,
      category: t.category,
    }));
    return { success: true, filter, count: torrents.length, torrents };
  },
});
