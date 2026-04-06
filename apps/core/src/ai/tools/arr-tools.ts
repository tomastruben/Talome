import { tool } from "ai";
import { z } from "zod";
import { parseContainerFormat } from "../../utils/media-format.js";
import { getSetting } from "../../utils/settings.js";

interface ArrConfig {
  baseUrl: string;
  apiKey: string;
}

type ArrApp = "sonarr" | "radarr" | "prowlarr" | "readarr";
type MediaArrApp = "sonarr" | "radarr";
import { normalizeTier, getMaxSizeGb, scoreRelease, type MediaCategory } from "@talome/types";

function getArrConfig(app: ArrApp): ArrConfig | null {
  const baseUrl = getSetting(`${app}_url`);
  const apiKey = getSetting(`${app}_api_key`);
  if (!baseUrl || !apiKey) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

// ── Minimal interfaces for *arr API responses ─────────────────────────────────

interface ArrRelease {
  title?: string;
  quality?: { quality?: { name?: string }; name?: string };
  size?: number;
  ageHours?: number;
  seeders?: number | null;
  indexer?: string;
  seriesTitle?: string;
  seasonNumber?: number;
  mappedMovieId?: number;
  downloadUrl?: string;
  leechers?: number;
  categories?: Array<{ id?: number; name?: string }>;
  publishDate?: string;
  protocol?: string;
  guid?: string;
  infoUrl?: string;
}

interface ArrMediaItem {
  title?: string;
}

interface ArrQueueRecord {
  id: number;
  title?: string;
  series?: { title?: string };
  seasonNumber?: number;
  episodeNumber?: number;
}

interface ArrPaginatedResponse {
  records?: ArrQueueRecord[];
}

interface IndexerSchemaItem {
  implementation?: string;
  implementationName?: string;
  configContract?: string;
  protocol?: string;
  fields?: IndexerSchemaField[];
}

interface IndexerSchemaField {
  name?: string;
  label?: string;
  type?: string;
  value?: unknown;
  advanced?: boolean;
}

const API_VERSION: Record<ArrApp, string> = {
  sonarr: "v3",
  radarr: "v3",
  prowlarr: "v1",
  readarr: "v1",
};

async function arrFetch(app: ArrApp, path: string, options?: RequestInit) {
  const config = getArrConfig(app);
  if (!config) {
    return {
      success: false as const,
      error: `${app} is not configured. Add ${app}_url and ${app}_api_key in Settings.`,
      hint: `Go to Settings → Media Connections and add your ${app.charAt(0).toUpperCase() + app.slice(1)} URL and API key.`,
    };
  }
  const ver = API_VERSION[app];
  const url = `${config.baseUrl}/api/${ver}${path}`;
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        "X-Api-Key": config.apiKey,
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false as const, error: `${app} API error ${res.status}: ${text}` };
    }

    const data = await res.json();
    return { success: true as const, data };
  } catch (err: unknown) {
    return { success: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

// Quality scoring functions imported from @talome/types: normalizeTier, getMaxSizeGb, scoreRelease

// ── Title matching helpers (for release filtering) ────────────────────────────

function normaliseTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/s\d{1,2}e\d{1,2}.*/gi, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleMatchScore(candidate: string, target: string): number {
  const c = normaliseTitle(candidate);
  const t = normaliseTitle(target);
  if (!c || !t) return 0;
  if (c === t) return 100;
  if (c.startsWith(t) || t.startsWith(c)) return 80;
  if (c.includes(t) || t.includes(c)) return 65;
  const cTokens = new Set(c.split(" ").filter(Boolean));
  const tTokens = t.split(" ").filter(Boolean);
  if (!tTokens.length) return 0;
  const overlap = tTokens.filter((token) => cTokens.has(token)).length;
  return Math.round((overlap / tTokens.length) * 60);
}

// ── arr_get_status ────────────────────────────────────────────────────────────

export const arrGetStatusTool = tool({
  description: "Check the health and system status of Sonarr, Radarr, or Prowlarr. Returns version, health checks, and any warnings.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr", "prowlarr"]).describe("Which *arr app to check"),
  }),
  execute: async ({ app }) => {
    const statusEndpoint = app === "prowlarr" ? "/health" : "/system/status";
    const [status, health] = await Promise.all([
      arrFetch(app, statusEndpoint),
      arrFetch(app, "/health"),
    ]);
    if (!status.success) return status;
    const version = app === "prowlarr" ? undefined : (status.data as Record<string, unknown>).version;
    return { success: true, app, version, health: health.success ? health.data : [] };
  },
});

// ── arr_list_root_folders ─────────────────────────────────────────────────────

export const arrListRootFoldersTool = tool({
  description: "List the root folders (media library paths) configured in Sonarr or Radarr.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr"]).describe("sonarr, radarr, or readarr"),
  }),
  execute: async ({ app }) => {
    const result = await arrFetch(app, "/rootfolder");
    if (!result.success) return result;
    return { success: true, app, rootFolders: result.data };
  },
});

// ── arr_add_root_folder ───────────────────────────────────────────────────────

export const arrAddRootFolderTool = tool({
  description: "Add a root folder (media library path) to Sonarr or Radarr. The path must exist on the server.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr"]).describe("sonarr, radarr, or readarr"),
    path: z.string().describe("Absolute path to the media folder, e.g. /data/media/tv"),
  }),
  execute: async ({ app, path }) => {
    const result = await arrFetch(app, "/rootfolder", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    if (!result.success) return result;
    return { success: true, app, rootFolder: result.data, message: `Root folder ${path} added to ${app}.` };
  },
});

// ── arr_list_download_clients ─────────────────────────────────────────────────

export const arrListDownloadClientsTool = tool({
  description: "List the download clients configured in Sonarr, Radarr, or Prowlarr.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr", "prowlarr"]).describe("Which *arr app"),
  }),
  execute: async ({ app }) => {
    const result = await arrFetch(app, "/downloadclient");
    if (!result.success) return result;
    return { success: true, app, downloadClients: result.data };
  },
});

// ── arr_add_download_client ───────────────────────────────────────────────────

export const arrAddDownloadClientTool = tool({
  description: "Add qBittorrent (or another download client) to Sonarr or Radarr. Provide the host, port, and credentials.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr"]).describe("sonarr, radarr, or readarr"),
    name: z.string().default("qBittorrent").describe("Display name for this client"),
    host: z.string().default("qbittorrent").describe("Hostname or IP of the download client (use Docker service name for same-network containers)"),
    port: z.number().default(8080).describe("Port of the download client web UI"),
    username: z.string().default("admin").describe("Username"),
    password: z.string().default("").describe("Password"),
    category: z.string().optional().describe("Download category (e.g. tv-sonarr, radarr)"),
    useSsl: z.boolean().default(false).describe("Use HTTPS"),
  }),
  execute: async ({ app, name, host, port, username, password, category, useSsl }) => {
    const body = {
      enable: true,
      protocol: "torrent",
      priority: 1,
      removeCompletedDownloads: true,
      removeFailedDownloads: true,
      name,
      fields: [
        { name: "host", value: host },
        { name: "port", value: port },
        { name: "useSsl", value: useSsl },
        { name: "username", value: username },
        { name: "password", value: password },
        ...(category ? [{ name: "tvCategory", value: category }, { name: "movieCategory", value: category }] : []),
      ],
      implementationName: "qBittorrent",
      implementation: "QBittorrent",
      configContract: "QBittorrentSettings",
    };

    const result = await arrFetch(app, "/downloadclient", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!result.success) return result;
    return { success: true, app, client: result.data, message: `${name} added as download client in ${app}.` };
  },
});

// ── arr_test_download_client ──────────────────────────────────────────────────

export const arrTestDownloadClientTool = tool({
  description: "Test the connection to a download client configured in Sonarr or Radarr by ID.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr"]).describe("sonarr, radarr, or readarr"),
    clientId: z.number().describe("The download client ID (from arr_list_download_clients)"),
  }),
  execute: async ({ app, clientId }) => {
    const result = await arrFetch(app, `/downloadclient/test`, {
      method: "POST",
      body: JSON.stringify({ id: clientId }),
    });
    if (!result.success) return result;
    return { success: true, app, message: "Download client test succeeded." };
  },
});

// ── arr_list_indexers ─────────────────────────────────────────────────────────

export const arrListIndexersTool = tool({
  description: "List the indexers configured in Sonarr, Radarr, or Prowlarr.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr", "prowlarr"]).describe("Which *arr app"),
  }),
  execute: async ({ app }) => {
    const result = await arrFetch(app, "/indexer");
    if (!result.success) return result;
    return { success: true, app, indexers: result.data };
  },
});

// ── arr_sync_indexers_from_prowlarr ───────────────────────────────────────────

export const arrSyncIndexersFromProwlarrTool = tool({
  description: "Tell Prowlarr to push its indexers to all connected apps (Sonarr, Radarr). This is the equivalent of clicking 'Sync App Indexers' in Prowlarr.",
  inputSchema: z.object({}),
  execute: async () => {
    const result = await arrFetch("prowlarr", "/application", { method: "GET" });
    if (!result.success) return result;
    const apps = result.data as Array<{ id: number; name: string }>;
    const syncResults = await Promise.all(
      apps.map((a) =>
        arrFetch("prowlarr", `/indexerproxy/${a.id}/api?t=caps`, { method: "GET" }).then(() => ({
          app: a.name,
          synced: true,
        })).catch(() => ({ app: a.name, synced: false }))
      )
    );
    return { success: true, syncResults, message: "Prowlarr indexer sync triggered for all connected apps." };
  },
});

// ── arr_list_quality_profiles ─────────────────────────────────────────────────

export const arrListQualityProfilesTool = tool({
  description: "List quality profiles in Sonarr or Radarr. Use this to inspect available profile IDs before applying one.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr"]).describe("sonarr, radarr, or readarr"),
  }),
  execute: async ({ app }) => {
    const result = await arrFetch(app, "/qualityprofile");
    if (!result.success) return result;
    const profiles = (result.data as Array<{ id: number; name: string }>).map((p) => ({ id: p.id, name: p.name }));
    return { success: true, app, qualityProfiles: profiles };
  },
});

// ── arr_apply_quality_profile ─────────────────────────────────────────────────

export const arrApplyQualityProfileTool = tool({
  description:
    "Apply a quality profile to one or more Sonarr series or Radarr movies. This updates the selected items in bulk via the Arr editor endpoints.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr"]).describe("sonarr, radarr, or readarr"),
    qualityProfileId: z.number().int().positive().describe("Target quality profile ID"),
    mediaIds: z.array(z.number().int().positive()).min(1).describe("Series IDs (Sonarr) or movie IDs (Radarr)"),
  }),
  execute: async ({ app, qualityProfileId, mediaIds }) => {
    if (!mediaIds.length) {
      return { success: false as const, error: "At least one media ID is required." };
    }

    const path = app === "sonarr" ? "/series/editor" : "/movie/editor";
    const payload = app === "sonarr"
      ? { seriesIds: mediaIds, qualityProfileId }
      : { movieIds: mediaIds, qualityProfileId };

    const result = await arrFetch(app, path, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    if (!result.success) return result;

    return {
      success: true,
      app,
      qualityProfileId,
      updatedCount: mediaIds.length,
      message: `Applied quality profile ${qualityProfileId} to ${mediaIds.length} ${app === "sonarr" ? "series" : "movies"}.`,
    };
  },
});

// ── arr_get_wanted_missing ────────────────────────────────────────────────────

export const arrGetWantedMissingTool = tool({
  description: "List missing monitored media from Sonarr or Radarr (wanted backlog).",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr"]),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(30),
  }),
  execute: async ({ app, page, pageSize }) => {
    const include = app === "sonarr" ? "&includeSeries=true&includeImages=true" : "";
    const result = await arrFetch(app, `/wanted/missing?page=${page}&pageSize=${pageSize}${include}`);
    if (!result.success) return result;
    return { success: true, app, kind: "missing", ...(result.data as object) };
  },
});

// ── arr_get_wanted_cutoff ─────────────────────────────────────────────────────

export const arrGetWantedCutoffTool = tool({
  description: "List media that has not reached quality cutoff yet in Sonarr or Radarr.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr"]),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(30),
  }),
  execute: async ({ app, page, pageSize }) => {
    const include = app === "sonarr" ? "&includeSeries=true&includeEpisodeFile=true&includeImages=true" : "";
    const result = await arrFetch(app, `/wanted/cutoff?page=${page}&pageSize=${pageSize}${include}`);
    if (!result.success) return result;
    return { success: true, app, kind: "cutoff", ...(result.data as object) };
  },
});

// ── arr_search_releases ───────────────────────────────────────────────────────

export const arrSearchReleasesTool = tool({
  description: "Search available releases for a specific movie (Radarr) or series/season/episode (Sonarr), with ranked recommendations.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr"]),
    movieId: z.number().int().positive().optional(),
    seriesId: z.number().int().positive().optional(),
    seasonNumber: z.number().int().optional(),
    episodeId: z.number().int().positive().optional(),
    qualityTier: z.enum(["compact", "standard", "premium", "efficient", "balanced", "cinephile"]).default("standard")
      .describe("Quality tier: compact (~4GB), standard (~12GB, default), premium (~40GB). Legacy names also accepted."),
    maxSizeGb: z.number().positive().optional(),
  }),
  execute: async ({ app, movieId, seriesId, seasonNumber, episodeId, qualityTier: rawTier, maxSizeGb }) => {
    const params = new URLSearchParams();
    if (app === "radarr") {
      if (!movieId) return { success: false as const, error: "movieId is required for radarr release search" };
      params.set("movieId", String(movieId));
    } else {
      if (!seriesId) return { success: false as const, error: "seriesId is required for sonarr release search" };
      params.set("seriesId", String(seriesId));
      if (seasonNumber != null) params.set("seasonNumber", String(seasonNumber));
      if (episodeId != null) params.set("episodeId", String(episodeId));
    }

    const result = await arrFetch(app, `/release?${params.toString()}`);
    if (!result.success) return result;

    const tier = normalizeTier(rawTier);
    const category: MediaCategory = movieId ? "movie" : "episode";
    const effectiveMaxSizeGb = maxSizeGb ?? getMaxSizeGb(tier, category);
    const allReleases = ((result.data as ArrRelease[]) ?? []);

    // Two-pass filtering: seriesTitle match first, release title fallback second
    // Sonarr releases have `seriesTitle` (string), NOT `mappedSeriesId`.
    let filtered: any[];
    if (app === "sonarr" && seriesId) {
      const seriesData = await arrFetch(app, `/series/${seriesId}`);
      const seriesName = seriesData.success ? (seriesData.data as ArrMediaItem)?.title ?? "" : "";
      const normSeriesName = seriesName ? normaliseTitle(seriesName) : "";

      // Pass 1: match on seriesTitle field
      const strict = normSeriesName
        ? allReleases.filter((r: any) => {
            const relSeries = normaliseTitle(String(r?.seriesTitle ?? ""));
            if (!relSeries || relSeries !== normSeriesName) return false;
            if (seasonNumber != null && typeof r?.seasonNumber === "number" && r.seasonNumber !== seasonNumber) return false;
            return true;
          })
        : [];

      if (strict.length > 0) {
        filtered = strict;
      } else if (seriesName) {
        // Pass 2: match on full release title
        filtered = allReleases.filter((r: any) => {
          if (titleMatchScore(String(r?.title ?? ""), seriesName) < 40) return false;
          if (seasonNumber != null && typeof r?.seasonNumber === "number" && r.seasonNumber !== seasonNumber) return false;
          return true;
        });
      } else {
        filtered = [];
      }
    } else if (app === "radarr" && movieId) {
      const strict = allReleases.filter((r: any) => {
        const mapped = r?.mappedMovieId;
        return typeof mapped === "number" && mapped === movieId;
      });
      if (strict.length > 0) {
        filtered = strict;
      } else {
        const movieData = await arrFetch(app, `/movie/${movieId}`);
        const movieTitle = movieData.success ? (movieData.data as ArrMediaItem)?.title ?? "" : "";
        if (movieTitle) {
          filtered = allReleases.filter((r: any) => {
            const mapped = r?.mappedMovieId;
            if (typeof mapped === "number" && mapped > 0 && mapped !== movieId) return false;
            return titleMatchScore(String(r?.title ?? ""), movieTitle) >= 40;
          });
        } else {
          filtered = [];
        }
      }
    } else {
      filtered = allReleases;
    }

    const maxSizeBytes = effectiveMaxSizeGb * 1024 * 1024 * 1024;
    const releases = filtered
      .map((r: any) => {
        const size = Number(r.size ?? 0);
        const scored = scoreRelease(
          {
            title: String(r.title ?? ""),
            qualityName: String(r?.quality?.quality?.name ?? r?.quality?.name ?? ""),
            size,
            ageHours: Number(r.ageHours ?? 0),
            seeders: typeof r.seeders === "number" ? r.seeders : null,
          },
          tier,
          category,
        );
        const oversized = size > maxSizeBytes && size > 0;
        return {
          title: r.title ?? "Unknown release",
          quality: r.quality?.quality?.name ?? r.quality?.name ?? null,
          containerFormat: parseContainerFormat(String(r.title ?? "")),
          size,
          ageHours: r.ageHours ?? null,
          seeders: r.seeders ?? null,
          indexer: r.indexer ?? null,
          score: scored.total,
          scoreBreakdown: scored.breakdown,
          sizeRisk: oversized ? "oversized" : "ok",
          whyRecommended: oversized ? `Large file for ${tier} tier` : `Good fit for ${tier} tier`,
          rawRelease: r,
        };
      })
      .sort((a, b) => b.score - a.score);

    return {
      success: true,
      app,
      qualityTier: tier,
      maxSizeGb: effectiveMaxSizeGb,
      releases,
      recommendation: releases[0] ?? null,
      fallbackLevel: releases.length > 0 ? "preferred-or-best-available" : "none",
    };
  },
});

// ── arr_grab_release ───────────────────────────────────────────────────────────

export const arrGrabReleaseTool = tool({
  description: "Manually grab a specific release in Sonarr or Radarr.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr"]),
    release: z.object({}).passthrough().describe("Release payload returned from arr_search_releases rawRelease"),
  }),
  execute: async ({ app, release }) => {
    const result = await arrFetch(app, "/release", {
      method: "POST",
      body: JSON.stringify(release),
    });
    if (!result.success) return result;
    return { success: true, app, message: "Release grab submitted." };
  },
});

// ── arr_get_queue_details ─────────────────────────────────────────────────────

export const arrGetQueueDetailsTool = tool({
  description: "Get detailed queue records with status and error messages for Sonarr or Radarr.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr"]),
    seriesId: z.number().int().positive().optional(),
    movieId: z.number().int().positive().optional(),
  }),
  execute: async ({ app, seriesId, movieId }) => {
    const params = new URLSearchParams();
    if (app === "sonarr") {
      if (seriesId != null) params.set("seriesId", String(seriesId));
      params.set("includeSeries", "true");
      params.set("includeEpisode", "true");
    } else {
      if (movieId != null) params.set("movieId", String(movieId));
      params.set("includeMovie", "true");
    }
    const result = await arrFetch(app, `/queue/details?${params.toString()}`);
    if (!result.success) return result;
    return { success: true, app, records: result.data };
  },
});

// ── arr_queue_action ───────────────────────────────────────────────────────────

export const arrQueueActionTool = tool({
  description: "Run queue action for a queued item (currently supports grab by queue ID).",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr"]),
    action: z.enum(["grab"]).default("grab"),
    queueId: z.number().int().positive(),
  }),
  execute: async ({ app, action, queueId }) => {
    if (action !== "grab") return { success: false as const, error: `Unsupported action: ${action}` };
    const result = await arrFetch(app, `/queue/grab/${queueId}`, { method: "POST" });
    if (!result.success) return result;
    return { success: true, app, action, queueId, message: `Queue item ${queueId} grab triggered.` };
  },
});

// ── arr_cleanup_dry_run ───────────────────────────────────────────────────────

export const arrCleanupDryRunTool = tool({
  description: "Dry-run cleanup candidates for wanted backlogs. Does not delete anything.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr"]),
    maxItems: z.number().int().min(1).max(200).default(100),
  }),
  execute: async ({ app, maxItems }) => {
    const path = app === "sonarr"
      ? `/wanted/missing?page=1&pageSize=${maxItems}&includeSeries=true`
      : `/wanted/missing?page=1&pageSize=${maxItems}&monitored=true`;
    const result = await arrFetch(app, path);
    if (!result.success) return result;

    const candidates = (((result.data as ArrPaginatedResponse)?.records ?? []) as ArrQueueRecord[]).map((r) => ({
      id: r.id,
      title: app === "sonarr"
        ? `${r.series?.title ?? "Unknown"} S${String(r.seasonNumber ?? 0).padStart(2, "0")}E${String(r.episodeNumber ?? 0).padStart(2, "0")}`
        : (r.title ?? "Unknown"),
      reason: app === "sonarr" ? "Missing monitored episode" : "Missing monitored movie",
    }));
    return { success: true, app, mode: "dry-run", candidates };
  },
});

// ── arr_set_naming_convention ─────────────────────────────────────────────────

// ── arr_get_history ──────────────────────────────────────────────────────────

export const arrGetHistoryTool = tool({
  description:
    "Get history of grabs, imports, renames, and failures from Sonarr, Radarr, or Prowlarr. Useful for debugging why something didn't download.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr", "prowlarr"]).describe("Which *arr app"),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(50).default(20),
    eventType: z
      .string()
      .optional()
      .describe(
        "Filter by event type. Sonarr/Radarr: grabbed, downloadFolderImported, downloadFailed, movieFileDeleted, episodeFileDeleted, movieFileRenamed, episodeFileRenamed, downloadIgnored. Prowlarr: indexerQuery, indexerRss, releaseGrabbed, indexerAuth."
      ),
    seriesId: z.number().int().positive().optional().describe("Filter by series (Sonarr only)"),
    movieId: z.number().int().positive().optional().describe("Filter by movie (Radarr only)"),
  }),
  execute: async ({ app, page, pageSize, eventType, seriesId, movieId }) => {
    if (app === "prowlarr") {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (eventType) params.set("eventType", eventType);
      const result = await arrFetch(app, `/history?${params.toString()}`);
      if (!result.success) return result;
      return { success: true, app, ...(result.data as object) };
    }
    // Sonarr: use /history/series if seriesId provided, Radarr: use /history/movie if movieId provided
    if (app === "sonarr" && seriesId) {
      const params = new URLSearchParams({ seriesId: String(seriesId) });
      if (eventType) params.set("eventType", eventType);
      const result = await arrFetch(app, `/history/series?${params.toString()}`);
      if (!result.success) return result;
      return { success: true, app, records: result.data };
    }
    if (app === "radarr" && movieId) {
      const params = new URLSearchParams({ movieId: String(movieId) });
      if (eventType) params.set("eventType", eventType);
      const result = await arrFetch(app, `/history/movie?${params.toString()}`);
      if (!result.success) return result;
      return { success: true, app, records: result.data };
    }
    // General paginated history
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      sortKey: "date",
      sortDirection: "descending",
    });
    if (eventType) params.set("eventType", eventType);
    if (app === "sonarr") {
      params.set("includeSeries", "true");
      params.set("includeEpisode", "true");
    }
    const result = await arrFetch(app, `/history?${params.toString()}`);
    if (!result.success) return result;
    return { success: true, app, ...(result.data as object) };
  },
});

// ── arr_run_command ──────────────────────────────────────────────────────────

export const arrRunCommandTool = tool({
  description:
    "Trigger a command in Sonarr, Radarr, or Prowlarr. Examples: RefreshSeries, MissingEpisodeSearch, RssSync, Backup, RenameFiles, MoviesSearch, AppIndexerSync, etc.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr", "prowlarr"]).describe("Which *arr app"),
    commandName: z
      .string()
      .describe(
        "Command name. Sonarr: RefreshSeries, RescanSeries, EpisodeSearch, SeasonSearch, SeriesSearch, MissingEpisodeSearch, CutoffUnmetEpisodeSearch, RenameFiles, RenameSeries, Backup, RssSync, DownloadedEpisodesScan. Radarr: RefreshMovie, RescanMovie, MoviesSearch, MissingMoviesSearch, RenameFiles, RenameMovie, Backup, RefreshCollections. Prowlarr: AppIndexerSync, RssSync, Backup, RefreshIndexer."
      ),
    seriesId: z.number().int().positive().optional().describe("Series ID (Sonarr commands)"),
    movieIds: z.array(z.number().int().positive()).optional().describe("Movie IDs (Radarr commands like MoviesSearch)"),
    seasonNumber: z.number().int().optional().describe("Season number (SeasonSearch)"),
    episodeIds: z.array(z.number().int().positive()).optional().describe("Episode IDs (EpisodeSearch)"),
    seriesIds: z.array(z.number().int().positive()).optional().describe("Series IDs (RenameSeries)"),
    files: z.array(z.number().int().positive()).optional().describe("File IDs (RenameFiles)"),
  }),
  execute: async ({ app, commandName, seriesId, movieIds, seasonNumber, episodeIds, seriesIds, files }) => {
    const body: Record<string, unknown> = { name: commandName };
    if (seriesId != null) body.seriesId = seriesId;
    if (movieIds?.length) body.movieIds = movieIds;
    if (seasonNumber != null) body.seasonNumber = seasonNumber;
    if (episodeIds?.length) body.episodeIds = episodeIds;
    if (seriesIds?.length) body.seriesIds = seriesIds;
    if (files?.length) body.files = files;

    const result = await arrFetch(app, "/command", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!result.success) return result;
    const data = result.data as Record<string, unknown>;
    return {
      success: true,
      app,
      commandId: data.id,
      commandName,
      status: data.status ?? "queued",
      message: `Command '${commandName}' submitted to ${app}.`,
    };
  },
});

// ── arr_delete_queue_item ────────────────────────────────────────────────────

export const arrDeleteQueueItemTool = tool({
  description:
    "Remove an item from the Sonarr or Radarr download queue. Can optionally blocklist the release and/or remove from the download client.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr"]).describe("sonarr, radarr, or readarr"),
    queueId: z.number().int().positive().describe("Queue item ID (from arr_get_queue_details)"),
    removeFromClient: z.boolean().default(true).describe("Also remove from the download client"),
    blocklist: z.boolean().default(false).describe("Add the release to the blocklist so it won't be grabbed again"),
    skipRedownload: z.boolean().default(false).describe("Skip automatic re-download after removal"),
  }),
  execute: async ({ app, queueId, removeFromClient, blocklist, skipRedownload }) => {
    const params = new URLSearchParams({
      removeFromClient: String(removeFromClient),
      blocklist: String(blocklist),
      skipRedownload: String(skipRedownload),
    });
    const result = await arrFetch(app, `/queue/${queueId}?${params.toString()}`, {
      method: "DELETE",
    });
    if (!result.success) return result;
    return {
      success: true,
      app,
      queueId,
      blocklisted: blocklist,
      message: `Queue item ${queueId} removed from ${app}.${blocklist ? " Release added to blocklist." : ""}`,
    };
  },
});

// ── arr_manage_blocklist ─────────────────────────────────────────────────────

export const arrManageBlocklistTool = tool({
  description:
    "View or manage the blocklist in Sonarr or Radarr. Blocklisted releases won't be grabbed again.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr"]).describe("sonarr, radarr, or readarr"),
    action: z.enum(["list", "delete", "clear"]).describe("list: view blocklist, delete: remove specific entry, clear: clear entire blocklist via command"),
    blocklistId: z.number().int().positive().optional().describe("Blocklist entry ID to delete (required for action=delete)"),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(50).default(20),
  }),
  execute: async ({ app, action, blocklistId, page, pageSize }) => {
    if (action === "list") {
      const result = await arrFetch(
        app,
        `/blocklist?page=${page}&pageSize=${pageSize}&sortKey=date&sortDirection=descending`
      );
      if (!result.success) return result;
      return { success: true, app, ...(result.data as object) };
    }
    if (action === "delete") {
      if (!blocklistId) return { success: false as const, error: "blocklistId is required for action=delete" };
      const result = await arrFetch(app, `/blocklist/${blocklistId}`, { method: "DELETE" });
      if (!result.success) return result;
      return { success: true, app, message: `Blocklist entry ${blocklistId} removed.` };
    }
    if (action === "clear") {
      const result = await arrFetch(app, "/command", {
        method: "POST",
        body: JSON.stringify({ name: app === "radarr" ? "ClearBlocklist" : "ClearBlacklist" }),
      });
      if (!result.success) return result;
      return { success: true, app, message: `Blocklist clear command submitted to ${app}.` };
    }
    return { success: false as const, error: `Unknown action: ${action}` };
  },
});

// ── arr_mark_failed ──────────────────────────────────────────────────────────

export const arrMarkFailedTool = tool({
  description:
    "Mark a history item as failed in Sonarr or Radarr. This triggers a re-search for the episode/movie. Use arr_get_history to find the history ID.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr"]).describe("sonarr, radarr, or readarr"),
    historyId: z.number().int().positive().describe("The history record ID to mark as failed"),
  }),
  execute: async ({ app, historyId }) => {
    const result = await arrFetch(app, `/history/failed/${historyId}`, { method: "POST" });
    if (!result.success) return result;
    return {
      success: true,
      app,
      historyId,
      message: `History item ${historyId} marked as failed in ${app}. A re-search will be triggered automatically.`,
    };
  },
});

// ── arr_set_monitoring ──────────────────────────────────────────────────────

export const arrSetMonitoringTool = tool({
  description:
    "Change monitoring settings for series (Sonarr) or movies (Radarr). For Sonarr, you can monitor/unmonitor a whole series, set monitorNewItems to auto-monitor new seasons, or toggle specific episodes.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr"]).describe("sonarr, radarr, or readarr"),
    action: z.enum(["set_series", "set_movie", "set_episodes"]).describe(
      "set_series: update series monitoring & monitorNewItems (Sonarr). set_movie: toggle movie monitored (Radarr). set_episodes: bulk toggle episode monitored (Sonarr)."
    ),
    seriesId: z.number().int().positive().optional().describe("Series ID (required for set_series and set_episodes)"),
    movieId: z.number().int().positive().optional().describe("Movie ID (required for set_movie)"),
    monitored: z.boolean().optional().describe("Set monitored true/false for the series or movie"),
    monitorNewItems: z.enum(["all", "none"]).optional().describe("Sonarr only: auto-monitor new seasons/episodes (all) or not (none)"),
    episodeIds: z.array(z.number().int().positive()).optional().describe("Episode IDs for set_episodes action"),
  }),
  execute: async ({ app, action, seriesId, movieId, monitored, monitorNewItems, episodeIds }) => {
    if (action === "set_series") {
      if (!seriesId) return { success: false as const, error: "seriesId is required for set_series" };
      if (app !== "sonarr") return { success: false as const, error: "set_series is only for Sonarr" };

      // Fetch the current series first
      const current = await arrFetch(app, `/series/${seriesId}`);
      if (!current.success) return current;
      const series = current.data as Record<string, unknown>;

      // Update fields
      if (monitored != null) series.monitored = monitored;
      if (monitorNewItems) series.monitorNewItems = monitorNewItems;

      const result = await arrFetch(app, `/series/${seriesId}`, {
        method: "PUT",
        body: JSON.stringify(series),
      });
      if (!result.success) return result;

      const changes: string[] = [];
      if (monitored != null) changes.push(`monitored=${monitored}`);
      if (monitorNewItems) changes.push(`monitorNewItems=${monitorNewItems}`);
      return {
        success: true,
        app,
        seriesId,
        message: `Series ${seriesId} updated: ${changes.join(", ")}.`,
      };
    }

    if (action === "set_movie") {
      if (!movieId) return { success: false as const, error: "movieId is required for set_movie" };
      if (app !== "radarr") return { success: false as const, error: "set_movie is only for Radarr" };
      if (monitored == null) return { success: false as const, error: "monitored is required for set_movie" };

      // Fetch the current movie first
      const current = await arrFetch(app, `/movie/${movieId}`);
      if (!current.success) return current;
      const movie = current.data as Record<string, unknown>;
      movie.monitored = monitored;

      const result = await arrFetch(app, `/movie/${movieId}`, {
        method: "PUT",
        body: JSON.stringify(movie),
      });
      if (!result.success) return result;
      return {
        success: true,
        app,
        movieId,
        monitored,
        message: `Movie ${movieId} monitoring set to ${monitored}.`,
      };
    }

    if (action === "set_episodes") {
      if (app !== "sonarr") return { success: false as const, error: "set_episodes is only for Sonarr" };
      if (!episodeIds?.length) return { success: false as const, error: "episodeIds is required for set_episodes" };
      if (monitored == null) return { success: false as const, error: "monitored is required for set_episodes" };

      const result = await arrFetch(app, "/episode/monitor", {
        method: "PUT",
        body: JSON.stringify({ episodeIds, monitored }),
      });
      if (!result.success) return result;
      return {
        success: true,
        app,
        episodeIds,
        monitored,
        message: `${episodeIds.length} episodes set to monitored=${monitored}.`,
      };
    }

    return { success: false as const, error: `Unknown action: ${action}` };
  },
});

// ── arr_set_naming_convention ─────────────────────────────────────────────────

export const arrSetNamingConventionTool = tool({
  description: "Get or set the media file naming convention in Sonarr or Radarr. Pass 'get' to view current, or provide the naming tokens to update.",
  inputSchema: z.object({
    app: z.enum(["sonarr", "radarr", "readarr"]).describe("sonarr, radarr, or readarr"),
    action: z.enum(["get", "set"]).describe("get the current naming or set a new one"),
    standardFormat: z.string().optional().describe("Standard episode/movie format string (only for action=set)"),
  }),
  execute: async ({ app, action, standardFormat }) => {
    if (action === "get") {
      const result = await arrFetch(app, "/config/naming");
      if (!result.success) return result;
      return { success: true, app, naming: result.data };
    }
    if (!standardFormat) {
      return { success: false, error: "standardFormat is required for action=set" };
    }
    const current = await arrFetch(app, "/config/naming");
    if (!current.success) return current;
    const updated = { ...(current.data as object), standardEpisodeFormat: standardFormat, movieFolderFormat: standardFormat };
    const result = await arrFetch(app, "/config/naming", {
      method: "PUT",
      body: JSON.stringify(updated),
    });
    if (!result.success) return result;
    return { success: true, app, message: "Naming convention updated.", naming: result.data };
  },
});

// ── prowlarr_search ─────────────────────────────────────────────────────────

export const prowlarrSearchTool = tool({
  description:
    "Search across all Prowlarr indexers simultaneously. Prowlarr's key feature — queries every configured indexer and returns unified results. Supports type-specific searches (TV, movie, music, book).",
  inputSchema: z.object({
    query: z.string().describe("Search term"),
    type: z
      .enum(["search", "tvsearch", "moviesearch", "musicsearch", "booksearch"])
      .default("search")
      .describe("Search type — defaults to general search"),
    tvdbId: z.number().int().positive().optional().describe("TVDB ID for tvsearch"),
    tmdbId: z.number().int().positive().optional().describe("TMDB ID for moviesearch"),
    season: z.number().int().optional().describe("Season number for tvsearch"),
    episode: z.number().int().optional().describe("Episode number for tvsearch"),
    categories: z.array(z.number().int()).optional().describe("Newznab category IDs to filter (e.g. 2000=Movies, 5000=TV)"),
    indexerIds: z.array(z.number().int().positive()).optional().describe("Specific indexer IDs to search (omit for all)"),
    limit: z.number().int().min(1).max(100).default(25).describe("Max results to return"),
  }),
  execute: async ({ query, type, tvdbId, tmdbId, season, episode, categories, indexerIds, limit }) => {
    const params = new URLSearchParams({ query, type, limit: String(limit) });
    if (tvdbId != null) params.set("tvdbId", String(tvdbId));
    if (tmdbId != null) params.set("tmdbId", String(tmdbId));
    if (season != null) params.set("season", String(season));
    if (episode != null) params.set("episode", String(episode));
    if (categories?.length) params.set("categories", categories.join(","));
    if (indexerIds?.length) params.set("indexerIds", indexerIds.join(","));

    const result = await arrFetch("prowlarr", `/search?${params.toString()}`);
    if (!result.success) return result;

    const releases = ((result.data as ArrRelease[]) ?? []).map((r) => ({
      title: r.title ?? "Unknown",
      indexer: r.indexer ?? null,
      size: r.size ?? 0,
      publishDate: r.publishDate ?? null,
      downloadUrl: r.downloadUrl ? "[available]" : null,
      seeders: r.seeders ?? null,
      leechers: r.leechers ?? null,
      categories: r.categories?.map((c) => c.name ?? c.id) ?? [],
      protocol: r.protocol ?? null,
      guid: r.guid ?? null,
    }));

    return {
      success: true,
      app: "prowlarr",
      query,
      type,
      totalResults: releases.length,
      releases,
    };
  },
});

// ── prowlarr_manage_indexers ────────────────────────────────────────────────

export const prowlarrManageIndexersTool = tool({
  description:
    "Manage indexers in Prowlarr: list available schemas (to see what indexer types can be added), add a new indexer, update an existing one, delete one, or test one.",
  inputSchema: z.object({
    action: z.enum(["list_schemas", "add", "update", "delete", "test", "test_all"]).describe(
      "list_schemas: get all available indexer implementation types. add: add a new indexer. update: edit an existing indexer. delete: remove an indexer. test: test a specific indexer. test_all: test all indexers."
    ),
    indexerId: z.number().int().positive().optional().describe("Indexer ID (required for update, delete, test)"),
    indexerConfig: z.object({}).passthrough().optional().describe(
      "Full indexer config object for add/update. Get the schema from list_schemas first, then fill in the fields. Must include: name, implementation, configContract, fields array."
    ),
  }),
  execute: async ({ action, indexerId, indexerConfig }) => {
    if (action === "list_schemas") {
      const result = await arrFetch("prowlarr", "/indexer/schema");
      if (!result.success) return result;
      // Return simplified schemas — just name, implementation, and required fields
      const schemas = ((result.data as IndexerSchemaItem[]) ?? []).map((s) => ({
        implementation: s.implementation ?? null,
        implementationName: s.implementationName ?? null,
        configContract: s.configContract ?? null,
        protocol: s.protocol ?? null,
        fields: ((s.fields ?? []) as IndexerSchemaField[])
          .filter((f) => !f.advanced)
          .map((f) => ({
            name: f.name,
            label: f.label,
            type: f.type,
            value: f.value,
          })),
      }));
      return { success: true, app: "prowlarr", schemasCount: schemas.length, schemas };
    }

    if (action === "add") {
      if (!indexerConfig) return { success: false as const, error: "indexerConfig is required for add" };
      const result = await arrFetch("prowlarr", "/indexer", {
        method: "POST",
        body: JSON.stringify(indexerConfig),
      });
      if (!result.success) return result;
      const data = result.data as Record<string, unknown>;
      return { success: true, app: "prowlarr", indexerId: data.id, message: `Indexer '${data.name}' added.` };
    }

    if (action === "update") {
      if (!indexerId) return { success: false as const, error: "indexerId is required for update" };
      if (!indexerConfig) return { success: false as const, error: "indexerConfig is required for update" };
      const result = await arrFetch("prowlarr", `/indexer/${indexerId}`, {
        method: "PUT",
        body: JSON.stringify({ ...indexerConfig, id: indexerId }),
      });
      if (!result.success) return result;
      return { success: true, app: "prowlarr", indexerId, message: `Indexer ${indexerId} updated.` };
    }

    if (action === "delete") {
      if (!indexerId) return { success: false as const, error: "indexerId is required for delete" };
      const result = await arrFetch("prowlarr", `/indexer/${indexerId}`, { method: "DELETE" });
      if (!result.success) return result;
      return { success: true, app: "prowlarr", indexerId, message: `Indexer ${indexerId} deleted.` };
    }

    if (action === "test") {
      if (!indexerId) return { success: false as const, error: "indexerId is required for test" };
      // Fetch the indexer first, then test it
      const current = await arrFetch("prowlarr", `/indexer/${indexerId}`);
      if (!current.success) return current;
      const result = await arrFetch("prowlarr", "/indexer/test", {
        method: "POST",
        body: JSON.stringify(current.data),
      });
      if (!result.success) return result;
      return { success: true, app: "prowlarr", indexerId, message: `Indexer ${indexerId} test passed.` };
    }

    if (action === "test_all") {
      const result = await arrFetch("prowlarr", "/indexer/testall", { method: "POST" });
      if (!result.success) return result;
      return { success: true, app: "prowlarr", results: result.data, message: "All indexers tested." };
    }

    return { success: false as const, error: `Unknown action: ${action}` };
  },
});

// ── prowlarr_get_indexer_stats ──────────────────────────────────────────────

export const prowlarrGetIndexerStatsTool = tool({
  description:
    "Get performance statistics for all Prowlarr indexers — query count, grab count, average response time. Useful for identifying which indexers are working well vs poorly.",
  inputSchema: z.object({}),
  execute: async () => {
    const result = await arrFetch("prowlarr", "/indexerstats");
    if (!result.success) return result;
    return { success: true, app: "prowlarr", stats: result.data };
  },
});
