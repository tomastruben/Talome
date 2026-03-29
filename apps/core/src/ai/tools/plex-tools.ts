import { tool } from "ai";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";
import { isSecretSettingKey, decryptSetting } from "../../utils/crypto.js";

function getSetting(key: string): string | undefined {
  try {
    const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    if (!row?.value) return undefined;
    return isSecretSettingKey(key) ? decryptSetting(row.value) : row.value;
  } catch {
    return undefined;
  }
}

interface PlexConfig {
  baseUrl: string;
  token: string;
}

function getPlexConfig(): PlexConfig | null {
  const baseUrl = getSetting("plex_url");
  const token = getSetting("plex_token");
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), token };
}

async function plexFetch(path: string, options?: RequestInit): Promise<{ success: boolean; data?: unknown; error?: string; hint?: string }> {
  const config = getPlexConfig();
  if (!config) {
    return {
      success: false,
      error: "Plex is not configured. Add plex_url and plex_token in Settings.",
      hint: "Go to Settings → Media Connections. Get your token from Plex → Settings → Advanced → XML data.",
    };
  }
  try {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${config.baseUrl}${path}${sep}X-Plex-Token=${config.token}`, {
      ...options,
      headers: { Accept: "application/json", ...(options?.headers ?? {}) },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: `Plex API error ${res.status}: ${text}` };
    }
    const ct = res.headers.get("content-type") ?? "";
    const data = ct.includes("application/json") ? await res.json() : await res.text();
    return { success: true, data };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── plex_get_status ─────────────────────────────────────────────────────────

export const plexGetStatusTool = tool({
  description: "Get Plex server info: name, version, platform, and whether it's reachable.",
  inputSchema: z.object({}),
  execute: async () => {
    const result = await plexFetch("/identity");
    if (!result.success) return result;
    const mc = (result.data as Record<string, unknown>).MediaContainer as Record<string, unknown> | undefined;
    return {
      success: true,
      server: {
        name: mc?.friendlyName ?? mc?.machineIdentifier,
        version: mc?.version,
        platform: mc?.platform,
      },
    };
  },
});

// ── plex_get_on_deck ────────────────────────────────────────────────────────

export const plexGetOnDeckTool = tool({
  description: "Get items currently on deck (continue watching) from Plex.",
  inputSchema: z.object({}),
  execute: async () => {
    const result = await plexFetch("/library/onDeck");
    if (!result.success) return result;
    const mc = (result.data as Record<string, unknown>).MediaContainer as Record<string, unknown> | undefined;
    const items = ((mc?.Metadata ?? []) as Array<Record<string, unknown>>).map((item) => ({
      ratingKey: item.ratingKey,
      title: item.grandparentTitle ?? item.title,
      episodeTitle: item.grandparentTitle ? item.title : undefined,
      type: item.type === "movie" ? "movie" : "tv",
      year: item.year,
      viewOffset: item.viewOffset,
      duration: item.duration,
      season: item.parentIndex,
      episode: item.index,
    }));
    return { success: true, items };
  },
});

// ── plex_get_recently_watched ───────────────────────────────────────────────

export const plexGetRecentlyWatchedTool = tool({
  description: "Get recently watched items from Plex watch history.",
  inputSchema: z.object({
    limit: z.number().default(20).describe("Number of items to return"),
  }),
  execute: async ({ limit }) => {
    const result = await plexFetch(`/status/sessions/history/all?sort=viewedAt:desc&limit=${limit}`);
    if (!result.success) return result;
    const mc = (result.data as Record<string, unknown>).MediaContainer as Record<string, unknown> | undefined;
    const items = ((mc?.Metadata ?? []) as Array<Record<string, unknown>>).map((item) => ({
      ratingKey: item.ratingKey,
      title: item.grandparentTitle ?? item.title,
      episodeTitle: item.grandparentTitle ? item.title : undefined,
      type: item.type === "movie" ? "movie" : "tv",
      viewedAt: item.viewedAt ? new Date((item.viewedAt as number) * 1000).toISOString() : undefined,
      season: item.parentIndex,
      episode: item.index,
    }));
    return { success: true, items };
  },
});

// ── plex_mark_watched / plex_mark_unwatched ─────────────────────────────────

export const plexMarkWatchedTool = tool({
  description: "Mark a Plex item as watched (scrobble). Use ratingKey from on-deck or library items.",
  inputSchema: z.object({
    ratingKey: z.string().describe("The Plex ratingKey of the item"),
  }),
  execute: async ({ ratingKey }) => {
    const result = await plexFetch(`/:/scrobble?identifier=com.plexapp.plugins.library&key=${encodeURIComponent(ratingKey)}`);
    if (!result.success) return result;
    return { success: true, message: `Item ${ratingKey} marked as watched.` };
  },
});

export const plexMarkUnwatchedTool = tool({
  description: "Mark a Plex item as unwatched (unscrobble).",
  inputSchema: z.object({
    ratingKey: z.string().describe("The Plex ratingKey of the item"),
  }),
  execute: async ({ ratingKey }) => {
    const result = await plexFetch(`/:/unscrobble?identifier=com.plexapp.plugins.library&key=${encodeURIComponent(ratingKey)}`);
    if (!result.success) return result;
    return { success: true, message: `Item ${ratingKey} marked as unwatched.` };
  },
});
