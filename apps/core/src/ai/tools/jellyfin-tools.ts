import { tool } from "ai";
import { z } from "zod";
import { getSetting } from "../../utils/settings.js";

interface JellyfinConfig {
  baseUrl: string;
  apiKey: string;
}

function getJellyfinConfig(): JellyfinConfig | null {
  const baseUrl = getSetting("jellyfin_url");
  const apiKey = getSetting("jellyfin_api_key");
  if (!baseUrl || !apiKey) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

async function jellyfinFetch(path: string, options?: RequestInit): Promise<{ success: boolean; data?: unknown; error?: string; hint?: string }> {
  const config = getJellyfinConfig();
  if (!config) {
    return {
      success: false,
      error: "Jellyfin is not configured. Add jellyfin_url and jellyfin_api_key in Settings.",
      hint: "Go to Settings → Media Connections. Get your API key from Jellyfin's admin panel under API Keys.",
    };
  }
  try {
    const res = await fetch(`${config.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `MediaBrowser Token="${config.apiKey}"`,
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: `Jellyfin API error ${res.status}: ${text}` };
    }
    const ct = res.headers.get("content-type") ?? "";
    const data = ct.includes("application/json") ? await res.json() : await res.text();
    return { success: true, data };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── jellyfin_get_status ───────────────────────────────────────────────────────

export const jellyfinGetStatusTool = tool({
  description: "Check Jellyfin health and get server info (version, OS, runtime).",
  inputSchema: z.object({}),
  execute: async () => {
    const [health, info] = await Promise.all([
      jellyfinFetch("/health"),
      jellyfinFetch("/System/Info"),
    ]);
    if (!health.success) return health;
    return { success: true, health: health.data, info: info.success ? info.data : {} };
  },
});

// ── jellyfin_list_libraries ───────────────────────────────────────────────────

export const jellyfinListLibrariesTool = tool({
  description: "List all media libraries configured in Jellyfin (Movies, TV Shows, Music, etc.).",
  inputSchema: z.object({}),
  execute: async () => {
    const result = await jellyfinFetch("/Library/VirtualFolders");
    if (!result.success) return result;
    const libraries = (result.data as Array<Record<string, unknown>>).map((l) => ({
      name: l.Name,
      type: l.CollectionType,
      paths: l.Locations,
    }));
    return { success: true, libraries };
  },
});

// ── jellyfin_add_library ──────────────────────────────────────────────────────

export const jellyfinAddLibraryTool = tool({
  description: "Add a new media library to Jellyfin. For example, add a Movies library at /data/media/movies.",
  inputSchema: z.object({
    name: z.string().describe("Display name for the library, e.g. 'Movies'"),
    collectionType: z.enum(["movies", "tvshows", "music", "books", "photos", "mixed"]).describe("Type of media"),
    paths: z.array(z.string()).describe("Absolute paths on the server containing this media"),
  }),
  execute: async ({ name, collectionType, paths }) => {
    const body = {
      Name: name,
      CollectionType: collectionType,
      Paths: paths,
      RefreshLibrary: true,
      LibraryOptions: {
        EnableRealtimeMonitor: true,
        EnableAutomaticSeriesGrouping: true,
        MetadataCountryCode: "US",
        PreferredMetadataLanguage: "en",
      },
    };
    const params = new URLSearchParams({ name, collectionType });
    const result = await jellyfinFetch(`/Library/VirtualFolders?${params}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!result.success) return result;
    return { success: true, message: `Library '${name}' added to Jellyfin with paths: ${paths.join(", ")}.` };
  },
});

// ── jellyfin_scan_library ─────────────────────────────────────────────────────

export const jellyfinScanLibraryTool = tool({
  description: "Trigger a metadata scan/refresh of all Jellyfin libraries or a specific one.",
  inputSchema: z.object({
    libraryId: z.string().optional().describe("Specific library item ID to scan (omit to scan all)"),
  }),
  execute: async ({ libraryId }) => {
    const path = libraryId
      ? `/Items/${libraryId}/Refresh?Recursive=true&MetadataRefreshMode=Default&ImageRefreshMode=Default`
      : "/Library/Refresh";
    const result = await jellyfinFetch(path, { method: "POST" });
    if (!result.success) return result;
    return { success: true, message: libraryId ? `Library ${libraryId} scan started.` : "Full library scan started." };
  },
});

// ── jellyfin_get_stats ────────────────────────────────────────────────────────

export const jellyfinGetStatsTool = tool({
  description: "Get Jellyfin library statistics: total counts of movies, episodes, music tracks, etc.",
  inputSchema: z.object({}),
  execute: async () => {
    const result = await jellyfinFetch("/Items/Counts");
    if (!result.success) return result;
    return { success: true, stats: result.data };
  },
});

// ── jellyfin_create_api_key ───────────────────────────────────────────────────

export const jellyfinCreateApiKeyTool = tool({
  description: "Create a new API key in Jellyfin. Use this to generate keys for Overseerr, Sonarr, Radarr, etc.",
  inputSchema: z.object({
    name: z.string().describe("Name/description for this API key, e.g. 'Overseerr'"),
  }),
  execute: async ({ name }) => {
    const result = await jellyfinFetch(`/Auth/Keys?app=${encodeURIComponent(name)}`, {
      method: "POST",
    });
    if (!result.success) return result;
    return { success: true, message: `API key created for '${name}'.`, key: result.data };
  },
});
