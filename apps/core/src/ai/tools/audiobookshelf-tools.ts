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

interface AudiobookshelfConfig {
  baseUrl: string;
  token: string;
}

function getAudiobookshelfConfig(): AudiobookshelfConfig | null {
  const baseUrl = getSetting("audiobookshelf_url");
  const token = getSetting("audiobookshelf_api_key");
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), token };
}

async function absFetch(path: string, options?: RequestInit): Promise<{ success: boolean; data?: unknown; error?: string; hint?: string }> {
  const config = getAudiobookshelfConfig();
  if (!config) {
    return {
      success: false,
      error: "Audiobookshelf is not configured. Add audiobookshelf_url and audiobookshelf_api_key in Settings.",
      hint: "Go to Settings → Connections. Get your API token from Audiobookshelf's web UI: Config → Users → click your user → copy the Token.",
    };
  }
  try {
    const res = await fetch(`${config.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: `Audiobookshelf API error ${res.status}: ${text}` };
    }
    const ct = res.headers.get("content-type") ?? "";
    const data = ct.includes("application/json") ? await res.json() : await res.text();
    return { success: true, data };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── audiobookshelf_get_status ─────────────────────────────────────────────────

export const audiobookshelfGetStatusTool = tool({
  description: "Check Audiobookshelf health and get server status (version, uptime).",
  inputSchema: z.object({}),
  execute: async () => {
    const [health, status] = await Promise.all([
      absFetch("/healthcheck"),
      absFetch("/api/status"),
    ]);
    if (!health.success) return health;
    return { success: true, healthy: true, status: status.success ? status.data : {} };
  },
});

// ── audiobookshelf_list_libraries ─────────────────────────────────────────────

export const audiobookshelfListLibrariesTool = tool({
  description: "List all libraries in Audiobookshelf (audiobooks, podcasts).",
  inputSchema: z.object({}),
  execute: async () => {
    const result = await absFetch("/api/libraries");
    if (!result.success) return result;
    const raw = result.data as { libraries: Array<Record<string, unknown>> };
    const libraries = (raw.libraries ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      mediaType: l.mediaType,
      folders: l.folders,
      stats: l.stats,
    }));
    return { success: true, libraries };
  },
});

// ── audiobookshelf_get_library_items ──────────────────────────────────────────

export const audiobookshelfGetLibraryItemsTool = tool({
  description: "Get audiobooks/podcasts from a library with optional sorting, filtering, and pagination.",
  inputSchema: z.object({
    libraryId: z.string().describe("Library ID to fetch items from"),
    limit: z.number().optional().default(25).describe("Number of items to return (default 25)"),
    page: z.number().optional().default(0).describe("Page number (0-indexed)"),
    sort: z.string().optional().default("media.metadata.title").describe("Sort field (e.g. media.metadata.title, addedAt, media.duration)"),
    desc: z.boolean().optional().default(false).describe("Sort descending"),
    filter: z.string().optional().describe("Filter string (e.g. 'progress' for in-progress, 'finished' for completed)"),
  }),
  execute: async ({ libraryId, limit, page, sort, desc, filter }) => {
    const params = new URLSearchParams({
      limit: String(limit),
      page: String(page),
      sort: sort ?? "media.metadata.title",
      desc: desc ? "1" : "0",
    });
    if (filter) params.set("filter", filter);
    const result = await absFetch(`/api/libraries/${libraryId}/items?${params}`);
    if (!result.success) return result;
    const raw = result.data as { results: Array<Record<string, unknown>>; total: number };
    const items = (raw.results ?? []).map((item) => {
      const media = item.media as Record<string, unknown> | undefined;
      const metadata = (media?.metadata ?? {}) as Record<string, unknown>;
      return {
        id: item.id,
        title: metadata.title,
        author: metadata.authorName,
        narrator: metadata.narratorName,
        series: metadata.seriesName,
        duration: media?.duration,
        numChapters: media?.numChapters,
        publishedYear: metadata.publishedYear,
        addedAt: item.addedAt,
      };
    });
    return { success: true, items, total: raw.total, page, limit };
  },
});

// ── audiobookshelf_search ─────────────────────────────────────────────────────

export const audiobookshelfSearchTool = tool({
  description: "Search for audiobooks, podcasts, authors, or series in Audiobookshelf.",
  inputSchema: z.object({
    libraryId: z.string().describe("Library ID to search within"),
    query: z.string().describe("Search query"),
    limit: z.number().optional().default(10).describe("Max results (default 10)"),
  }),
  execute: async ({ libraryId, query, limit }) => {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    const result = await absFetch(`/api/libraries/${libraryId}/search?${params}`);
    if (!result.success) return result;
    const raw = result.data as Record<string, unknown>;
    return {
      success: true,
      book: raw.book,
      podcast: raw.podcast,
      authors: raw.authors,
      series: raw.series,
    };
  },
});

// ── audiobookshelf_get_item ───────────────────────────────────────────────────

export const audiobookshelfGetItemTool = tool({
  description: "Get full audiobook/podcast details including metadata, chapters, and audio files.",
  inputSchema: z.object({
    itemId: z.string().describe("Library item ID"),
    expanded: z.boolean().optional().default(true).describe("Include full details (chapters, audio files)"),
  }),
  execute: async ({ itemId, expanded }) => {
    const params = expanded ? "?expanded=1" : "";
    const result = await absFetch(`/api/items/${itemId}${params}`);
    if (!result.success) return result;
    const item = result.data as Record<string, unknown>;
    const media = item.media as Record<string, unknown> | undefined;
    const metadata = (media?.metadata ?? {}) as Record<string, unknown>;
    return {
      success: true,
      item: {
        id: item.id,
        mediaType: item.mediaType,
        title: metadata.title,
        subtitle: metadata.subtitle,
        author: metadata.authorName,
        narrator: metadata.narratorName,
        description: metadata.description,
        genres: metadata.genres,
        publishedYear: metadata.publishedYear,
        series: metadata.seriesName,
        isbn: metadata.isbn,
        asin: metadata.asin,
        duration: media?.duration,
        size: media?.size,
        numChapters: media?.numChapters,
        numAudioFiles: media?.numAudioFiles,
        chapters: media?.chapters,
        audioFiles: media?.audioFiles,
      },
    };
  },
});

// ── audiobookshelf_add_library ────────────────────────────────────────────────

export const audiobookshelfAddLibraryTool = tool({
  description:
    "Create a new library in Audiobookshelf. Folder paths must be CONTAINER paths (e.g. /audiobooks), not host paths. Use inspect_container first to see what volumes are mounted and use those destination paths.",
  inputSchema: z.object({
    name: z.string().describe("Display name for the library, e.g. 'Audiobooks'"),
    folders: z.array(z.string()).describe("Absolute container paths containing media (e.g. ['/media-vault-audiobooks', '/nas-audiobooks']). Must be mount destinations, NOT host paths."),
    mediaType: z.enum(["book", "podcast"]).default("book").describe("Type of media: 'book' for audiobooks, 'podcast' for podcasts"),
    provider: z.string().optional().default("google").describe("Metadata provider (google, audible, openlibrary, itunes for podcasts)"),
  }),
  execute: async ({ name, folders, mediaType, provider }) => {
    const body = {
      name,
      folders: folders.map((fullPath) => ({ fullPath })),
      mediaType,
      provider,
      icon: mediaType === "podcast" ? "podcast" : "audiobookshelf",
      settings: {
        coverAspectRatio: 1,
        disableWatcher: false,
      },
    };
    const result = await absFetch("/api/libraries", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!result.success) return result;
    const lib = result.data as Record<string, unknown>;

    // Trigger a scan on the new library
    if (lib.id) {
      await absFetch(`/api/libraries/${lib.id}/scan`, { method: "POST" });
    }

    return {
      success: true,
      library: { id: lib.id, name: lib.name, mediaType: lib.mediaType, folders: lib.folders },
      message: `Library '${name}' created with ${folders.length} folder(s) and scan started. Items will appear shortly.`,
    };
  },
});

// ── audiobookshelf_scan_library ──────────────────────────────────────────────

export const audiobookshelfScanLibraryTool = tool({
  description: "Trigger a metadata scan on an Audiobookshelf library to pick up new files and refresh metadata.",
  inputSchema: z.object({
    libraryId: z.string().describe("Library ID to scan"),
    force: z.boolean().optional().default(false).describe("Force re-scan all items (not just new ones)"),
  }),
  execute: async ({ libraryId, force }) => {
    const path = force ? `/api/libraries/${libraryId}/scan?force=1` : `/api/libraries/${libraryId}/scan`;
    const result = await absFetch(path, { method: "POST" });
    if (!result.success) return result;
    return { success: true, message: `Library scan started${force ? " (force)" : ""}. New items will appear shortly.` };
  },
});

// ── audiobookshelf_get_progress ───────────────────────────────────────────────

export const audiobookshelfGetProgressTool = tool({
  description: "Get listening progress for an audiobook or podcast episode.",
  inputSchema: z.object({
    itemId: z.string().describe("Library item ID"),
  }),
  execute: async ({ itemId }) => {
    const result = await absFetch(`/api/me/progress/${itemId}`);
    if (!result.success) return result;
    const progress = result.data as Record<string, unknown>;
    return {
      success: true,
      progress: {
        currentTime: progress.currentTime,
        progress: progress.progress,
        isFinished: progress.isFinished,
        lastUpdate: progress.lastUpdate,
        startedAt: progress.startedAt,
        finishedAt: progress.finishedAt,
        duration: progress.duration,
      },
    };
  },
});

// ── audiobookshelf_update_progress ────────────────────────────────────────────

export const audiobookshelfUpdateProgressTool = tool({
  description: "Update listening progress for an audiobook (sync playback position).",
  inputSchema: z.object({
    itemId: z.string().describe("Library item ID"),
    currentTime: z.number().describe("Current playback position in seconds"),
    duration: z.number().describe("Total duration of the audiobook in seconds"),
    isFinished: z.boolean().optional().default(false).describe("Whether the audiobook is finished"),
  }),
  execute: async ({ itemId, currentTime, duration, isFinished }) => {
    const progress = duration > 0 ? currentTime / duration : 0;
    const result = await absFetch(`/api/me/progress/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({ currentTime, progress, isFinished, duration }),
    });
    if (!result.success) return result;
    return { success: true, message: `Progress updated: ${Math.round(progress * 100)}% (${Math.floor(currentTime / 60)}m / ${Math.floor(duration / 60)}m)` };
  },
});

// ── Prowlarr + qBittorrent response interfaces ───────────────────────────────

interface ProwlarrRelease {
  title?: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  indexer?: string;
  downloadUrl?: string | null;
  categories?: Array<{ id?: number; name?: string }>;
  infoUrl?: string;
  publishDate?: string;
  guid?: string;
  protocol?: string;
}

interface QBitTorrent {
  name?: string;
  state?: string;
  progress?: number;
  total_size?: number;
  size?: number;
  dlspeed?: number;
  hash?: string;
}

// ── Prowlarr + qBittorrent helpers for audiobook downloads ────────────────────

function getProwlarrConfig() {
  const baseUrl = getSetting("prowlarr_url")?.replace(/\/$/, "");
  const apiKey = getSetting("prowlarr_api_key");
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

function getQbtConfig() {
  const baseUrl = getSetting("qbittorrent_url")?.replace(/\/$/, "");
  if (!baseUrl) return null;
  return {
    baseUrl,
    username: getSetting("qbittorrent_username") ?? "admin",
    password: getSetting("qbittorrent_password") ?? "",
  };
}

let qbtCookie: string | null = null;

async function qbtLogin(): Promise<void> {
  const config = getQbtConfig();
  if (!config) return;
  const res = await fetch(`${config.baseUrl}/api/v2/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `username=${encodeURIComponent(config.username)}&password=${encodeURIComponent(config.password)}`,
    signal: AbortSignal.timeout(10000),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) qbtCookie = setCookie.split(";")[0];
}

async function qbtFetch(path: string, init?: RequestInit): Promise<Response> {
  const config = getQbtConfig();
  if (!config) throw new Error("qBittorrent not configured");
  if (!qbtCookie) await qbtLogin();

  const doFetch = () =>
    fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(qbtCookie ? { Cookie: qbtCookie } : {}),
        ...(init?.headers as Record<string, string> ?? {}),
      },
      signal: init?.signal ?? AbortSignal.timeout(10000),
    });

  let res = await doFetch();
  if (res.status === 403) {
    await qbtLogin();
    res = await doFetch();
  }
  return res;
}

// ── Language detection helpers ────────────────────────────────────────────────

const LANGUAGE_PATTERNS: Array<{ lang: string; patterns: RegExp[] }> = [
  { lang: "CZ", patterns: [/\bCZ\b/, /\bczech\b/i, /\bčesk/i, /\baudiokniha\b/i, /\bčeština\b/i] },
  { lang: "SK", patterns: [/\bSK\b/, /\bslovak\b/i, /\bslovens/i, /\baudiokniha\b/i] },
  { lang: "EN", patterns: [/\bEN\b/, /\benglish\b/i, /\baudiobook\b/i] },
  { lang: "DE", patterns: [/\bDE\b/, /\bgerman\b/i, /\bdeutsch\b/i, /\bhörbuch\b/i] },
  { lang: "PL", patterns: [/\bPL\b/, /\bpolish\b/i, /\bpolsk/i] },
  { lang: "RU", patterns: [/\bRU\b/, /\brussian\b/i, /\bрус/i] },
  { lang: "FR", patterns: [/\bFR\b/, /\bfrench\b/i, /\bfrançais/i] },
];

function detectLanguage(title: string): string | null {
  // "audiokniha" is CZ/SK — check for SK markers first, then default to CZ
  const lower = title.toLowerCase();
  if (/\baudiokniha\b/i.test(title)) {
    if (/\bSK\b/.test(title) || /\bslovak/i.test(title) || /\bslovens/i.test(title)) return "SK";
    return "CZ";
  }
  for (const { lang, patterns } of LANGUAGE_PATTERNS) {
    if (lang === "EN") continue; // EN is fallback
    if (patterns.some((p) => p.test(title))) return lang;
  }
  // Default to EN for titles with "audiobook"
  if (/\baudiobook\b/i.test(title)) return "EN";
  return null;
}

// ── audiobook_search_releases ─────────────────────────────────────────────────

export const audiobookSearchReleasesTool = tool({
  description:
    "Search for audiobook torrent releases across all indexers via Prowlarr (category 3030 = Audio/Audiobook). Returns downloadable releases sorted by seeders. Detects language from release titles. Use this when the user wants to find and download audiobooks.",
  inputSchema: z.object({
    query: z.string().describe("Search query, e.g. 'Harry Potter audiobook', 'Stephen King IT audiobook'"),
    language: z.string().optional().describe("Filter results by language (e.g. 'SK', 'CZ', 'EN', 'DE'). Only returns releases matching this language. Without this, returns all results with detected language shown."),
    limit: z.number().optional().default(15).describe("Max results to return (default 15)"),
  }),
  execute: async ({ query, language, limit }) => {
    const config = getProwlarrConfig();
    if (!config) {
      return { success: false, error: "Prowlarr is not configured. Add prowlarr_url and prowlarr_api_key in Settings." };
    }
    try {
      // Search broadly — don't append language to query (it excludes valid results).
      // Instead, post-filter by detected language.
      const params = new URLSearchParams({ query, type: "search" });
      const res = await fetch(`${config.baseUrl}/api/v1/search?${params}`, {
        headers: { "X-Api-Key": config.apiKey },
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) return { success: false, error: `Prowlarr ${res.status}` };
      const raw = (await res.json()) as ProwlarrRelease[];

      const langFilter = language?.toUpperCase() ?? null;

      const AUDIO_CATS = new Set([3000, 3010, 3020, 3030, 3040]);
      const releases = raw
        .map((r) => {
          const title = r.title ?? "Unknown";
          const cats: number[] = (r.categories ?? []).map((c) => c.id ?? 0);
          return {
            title,
            size: Number(r.size ?? 0),
            sizeFormatted: Number(r.size ?? 0) >= 1073741824
              ? `${(Number(r.size) / 1073741824).toFixed(1)} GB`
              : `${Math.round(Number(r.size ?? 0) / 1048576)} MB`,
            seeders: r.seeders ?? 0,
            leechers: r.leechers ?? 0,
            indexer: r.indexer ?? null,
            language: detectLanguage(title),
            downloadUrl: r.downloadUrl ?? null,
            _isAudioCat: cats.some((id) => AUDIO_CATS.has(id)),
          };
        })
        .filter((r) => {
          const titleMatch = /audiobook|audiokniha|hörbuch|mp3.*knih|knih.*mp3/i.test(r.title);
          if (!r._isAudioCat && !titleMatch && raw.length > 5) return false;
          if (langFilter && r.language && r.language !== langFilter) return false;
          return true;
        })
        .map(({ _isAudioCat, ...r }) => r)
        .sort((a, b) => b.seeders - a.seeders)
        .slice(0, limit);

      return {
        success: true,
        query,
        languageFilter: langFilter,
        totalFound: raw.length,
        releases,
      };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── audiobook_download ────────────────────────────────────────────────────────

export const audiobookDownloadTool = tool({
  description:
    "Download an audiobook release via qBittorrent. Takes a download URL from audiobook_search_releases results and sends it to qBittorrent with the 'audiobooks' category. After downloading completes, trigger an Audiobookshelf library scan to pick up the new files.",
  inputSchema: z.object({
    downloadUrl: z.string().describe("The downloadUrl from audiobook_search_releases results"),
    title: z.string().optional().describe("Release title for confirmation message"),
  }),
  execute: async ({ downloadUrl, title }) => {
    const qbtConfig = getQbtConfig();
    if (!qbtConfig) {
      return { success: false, error: "qBittorrent is not configured. Add qbittorrent_url in Settings." };
    }
    try {
      const formData = new URLSearchParams();
      formData.set("urls", downloadUrl);
      formData.set("category", "audiobooks");

      const res = await qbtFetch("/api/v2/torrents/add", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { success: false, error: text || `qBittorrent ${res.status}` };
      }

      return {
        success: true,
        message: `"${title ?? "Audiobook"}" sent to qBittorrent with category "audiobooks". Once downloaded, run audiobookshelf_scan_library to pick up the new files.`,
      };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── audiobook_list_downloads ──────────────────────────────────────────────────

export const audiobookListDownloadsTool = tool({
  description:
    "List active and completed audiobook downloads from qBittorrent (category 'audiobooks'). Shows progress, speed, and ETA for active downloads.",
  inputSchema: z.object({}),
  execute: async () => {
    const qbtConfig = getQbtConfig();
    if (!qbtConfig) {
      return { success: false, error: "qBittorrent is not configured." };
    }
    try {
      const res = await qbtFetch("/api/v2/torrents/info?category=audiobooks");
      if (!res.ok) return { success: false, error: `qBittorrent ${res.status}` };
      const torrents = (await res.json()) as QBitTorrent[];

      const downloads = torrents.map((t) => ({
        name: t.name ?? "Unknown",
        state: t.state ?? "unknown",
        progress: `${Math.round((t.progress ?? 0) * 100)}%`,
        size: Number(t.total_size ?? t.size ?? 0) >= 1073741824
          ? `${(Number(t.total_size ?? t.size ?? 0) / 1073741824).toFixed(1)} GB`
          : `${Math.round(Number(t.total_size ?? t.size ?? 0) / 1048576)} MB`,
        dlspeed: (t.dlspeed ?? 0) > 0 ? `${((t.dlspeed ?? 0) / 1048576).toFixed(1)} MB/s` : "0",
        hash: t.hash,
      }));

      const active = downloads.filter((d) => d.progress !== "100%").length;
      return { success: true, totalDownloads: downloads.length, activeDownloads: active, downloads };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── audiobook_request ────────────────────────────────────────────────────────

export const audiobookRequestTool = tool({
  description:
    "Request an audiobook — searches Prowlarr for the best available release and auto-downloads it via qBittorrent. Similar to requesting a movie via Overseerr, but for audiobooks. Picks the release with the most seeders matching the language filter. After download completes, trigger audiobookshelf_scan_library.",
  inputSchema: z.object({
    title: z.string().describe("Audiobook title to search for, e.g. 'The Hobbit', 'Zaklínač'"),
    author: z.string().optional().describe("Author name to narrow results (e.g. 'Tolkien', 'Sapkowski')"),
    language: z.string().optional().describe("Filter results by detected language (e.g. 'SK', 'CZ', 'EN', 'DE'). Uses post-filtering on release title language detection."),
    minSeeders: z.number().optional().default(1).describe("Minimum seeders required (default 1)"),
  }),
  execute: async ({ title, author, language, minSeeders }) => {
    const prowlarr = getProwlarrConfig();
    if (!prowlarr) {
      return { success: false, error: "Prowlarr is not configured. Add prowlarr_url and prowlarr_api_key in Settings." };
    }
    const qbt = getQbtConfig();
    if (!qbt) {
      return { success: false, error: "qBittorrent is not configured. Add qbittorrent_url in Settings." };
    }

    try {
      // Search broadly — don't append language to query (it excludes valid results).
      // Instead, post-filter by detected language.
      let searchQuery = title;
      if (author) searchQuery += ` ${author}`;
      searchQuery += " audiobook";

      const langFilter = language?.toUpperCase() ?? null;

      const params = new URLSearchParams({ query: searchQuery, type: "search" });
      const res = await fetch(`${prowlarr.baseUrl}/api/v1/search?${params}`, {
        headers: { "X-Api-Key": prowlarr.apiKey },
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) return { success: false, error: `Prowlarr search failed: ${res.status}` };
      const raw = (await res.json()) as ProwlarrRelease[];

      // Filter by seeders, audiobook content, and language
      const AUDIO_CATS = new Set([3000, 3010, 3020, 3030, 3040]);
      const candidates = raw
        .filter((r) => {
          if ((r.seeders ?? 0) < minSeeders || !r.downloadUrl) return false;
          const rTitle = r.title ?? "";
          const cats: number[] = (r.categories ?? []).map((c) => c.id ?? 0);
          const isAudioCat = cats.some((id) => AUDIO_CATS.has(id));
          const titleMatch = /audiobook|audiokniha|hörbuch|mp3.*knih|knih.*mp3/i.test(rTitle);
          if (!isAudioCat && !titleMatch && raw.length > 5) return false;
          if (langFilter) {
            const detected = detectLanguage(rTitle);
            if (detected && detected !== langFilter) return false;
          }
          return true;
        })
        .map((r) => ({
          ...r,
          detectedLang: detectLanguage(r.title ?? ""),
        }))
        .sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));

      if (candidates.length === 0) {
        return {
          success: false,
          error: `No audiobook releases found for "${title}"${langFilter ? ` in ${langFilter}` : ""} with at least ${minSeeders} seeder(s).`,
          hint: "Try broadening the search: remove language filter, check spelling, or use audiobook_search_releases for manual selection.",
          totalSearchResults: raw.length,
        };
      }

      const best = candidates[0];
      const bestTitle = best.title ?? "Unknown";
      const bestSize = Number(best.size ?? 0) >= 1073741824
        ? `${(Number(best.size) / 1073741824).toFixed(1)} GB`
        : `${Math.round(Number(best.size ?? 0) / 1048576)} MB`;

      // Download via qBittorrent
      const formData = new URLSearchParams();
      formData.set("urls", best.downloadUrl ?? "");
      formData.set("category", "audiobooks");

      const dlRes = await qbtFetch("/api/v2/torrents/add", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      });

      if (!dlRes.ok) {
        const text = await dlRes.text().catch(() => "");
        return { success: false, error: `qBittorrent rejected download: ${text || dlRes.status}` };
      }

      return {
        success: true,
        message: `Downloading "${bestTitle}" (${bestSize}, ${best.seeders} seeders) via qBittorrent.`,
        release: {
          title: bestTitle,
          size: bestSize,
          seeders: best.seeders ?? 0,
          language: best.detectedLang ?? null,
          indexer: best.indexer ?? null,
        },
        searchStats: {
          totalFound: raw.length,
          matchingFilter: candidates.length,
        },
        nextStep: "Run audiobookshelf_scan_library once the download completes to pick up the new files.",
      };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});
