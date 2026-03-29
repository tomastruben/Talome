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

function getServiceUrl(service: string): string {
  const custom = getSetting(`${service}_url`);
  if (custom) return custom;
  const defaults: Record<string, string> = {
    sonarr: "http://localhost:8989",
    radarr: "http://localhost:7878",
    prowlarr: "http://localhost:9696",
    qbittorrent: "http://localhost:8080",
  };
  return defaults[service] ?? "";
}

function getApiKey(service: string): string {
  return getSetting(`${service}_api_key`) ?? "";
}

async function arrGet(service: string, path: string): Promise<unknown> {
  const baseUrl = getServiceUrl(service);
  const apiKey = getApiKey(service);
  const res = await fetch(`${baseUrl}/api/v3${path}`, {
    headers: apiKey ? { "X-Api-Key": apiKey } : {},
  });
  if (!res.ok) throw new Error(`${service} API ${res.status}`);
  return res.json();
}

async function arrPost(service: string, path: string, body: unknown): Promise<unknown> {
  const baseUrl = getServiceUrl(service);
  const apiKey = getApiKey(service);
  const res = await fetch(`${baseUrl}/api/v3${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "X-Api-Key": apiKey } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${service} API ${res.status}: ${text}`);
  }
  return res.json();
}

import { type QualityTier, normalizeTier, matchProfile } from "@talome/types";

// ── Minimal interfaces for *arr API responses ─────────────────────────────────

interface SonarrSeries {
  title: string;
  year: number;
  tvdbId: number;
  seasonCount: number;
  status: string;
  monitored: boolean;
  statistics?: { sizeOnDisk?: number };
  added?: string;
}

interface RadarrMovie {
  title: string;
  year: number;
  tmdbId: number;
  hasFile: boolean;
  monitored: boolean;
  sizeOnDisk?: number;
  added?: string;
  movieFile?: { quality?: { quality?: { name?: string } } };
}

interface SonarrLookupResult {
  tvdbId: number;
  title: string;
  year: number;
  overview?: string;
  seasonCount: number;
}

interface RadarrLookupResult {
  tmdbId: number;
  title: string;
  year: number;
  overview?: string;
}

interface ArrQueueResponse {
  records?: Array<{ title: string; status: string }>;
}

interface QBitTorrent {
  name: string;
  progress: number;
  state: string;
  size: number;
}

interface SonarrCalendarEntry {
  series?: { title: string };
  title: string;
  seasonNumber: number;
  episodeNumber: number;
  airDateUtc: string;
}

interface RadarrCalendarEntry {
  title: string;
  digitalRelease?: string;
  physicalRelease?: string;
  inCinemas?: string;
}

interface ArrAddResult {
  id: number;
}

async function resolveQualityProfileId(
  service: "sonarr" | "radarr",
  requestedProfileId?: number,
  tierOrIntent: string = "standard",
): Promise<{ profileId: number; profileName: string | null; fallbackUsed: boolean; reason: string }> {
  const tier = normalizeTier(tierOrIntent);
  const profiles = await arrGet(service, "/qualityprofile") as Array<{ id: number; name?: string | null }>;

  if (requestedProfileId != null) {
    const explicit = profiles.find((p) => p.id === requestedProfileId);
    if (explicit) {
      return { profileId: explicit.id, profileName: explicit.name ?? null, fallbackUsed: false, reason: "Explicit profile ID" };
    }
  }

  const result = matchProfile(profiles, tier);
  return { profileId: result.profileId, profileName: result.profileName, fallbackUsed: result.fallbackUsed, reason: result.reason };
}

export const getLibraryTool = tool({
  description:
    "Get the user's existing media library — all TV shows and movies already in Sonarr/Radarr. Use this to answer questions like 'what movies do I have?', 'do I own season 2 of X?', 'what was recently added?', 'how many shows am I monitoring?'.",
  inputSchema: z.object({
    type: z
      .enum(["all", "tv", "movies"])
      .optional()
      .describe("Filter to TV shows, movies, or both. Defaults to both."),
    search: z
      .string()
      .optional()
      .describe("Optional title filter applied client-side"),
  }),
  execute: async ({ type = "all", search }) => {
    const [sonarr, radarr] = await Promise.allSettled([
      type !== "movies" ? arrGet("sonarr", "/series") : Promise.resolve([]),
      type !== "tv" ? arrGet("radarr", "/movie") : Promise.resolve([]),
    ]);

    let tv =
      sonarr.status === "fulfilled"
        ? (sonarr.value as SonarrSeries[]).map((s) => ({
            title: s.title,
            year: s.year,
            tvdbId: s.tvdbId,
            seasons: s.seasonCount,
            status: s.status,
            monitored: s.monitored,
            sizeOnDisk: `${((s.statistics?.sizeOnDisk ?? 0) / 1073741824).toFixed(1)} GB`,
            added: s.added?.split("T")[0],
          }))
        : [];

    let movies =
      radarr.status === "fulfilled"
        ? (radarr.value as RadarrMovie[]).map((m) => ({
            title: m.title,
            year: m.year,
            tmdbId: m.tmdbId,
            hasFile: m.hasFile,
            monitored: m.monitored,
            sizeOnDisk: `${((m.sizeOnDisk ?? 0) / 1073741824).toFixed(1)} GB`,
            added: m.added?.split("T")[0],
            quality: m.movieFile?.quality?.quality?.name,
          }))
        : [];

    if (search) {
      const q = search.toLowerCase();
      tv = tv.filter((s) => s.title.toLowerCase().includes(q));
      movies = movies.filter((m) => m.title.toLowerCase().includes(q));
    }

    return {
      tv: tv.sort((a, b) => (b.added ?? "").localeCompare(a.added ?? "")),
      movies: movies.sort((a, b) =>
        (b.added ?? "").localeCompare(a.added ?? "")
      ),
      totals: { tvShows: tv.length, movies: movies.length },
    };
  },
});

export const searchMediaTool = tool({
  description: "Search for TV shows and movies across Sonarr and Radarr. Use this to find media before requesting downloads.",
  inputSchema: z.object({
    query: z.string().describe("Title to search for"),
  }),
  execute: async ({ query }) => {
    const [sonarr, radarr] = await Promise.allSettled([
      arrGet("sonarr", `/series/lookup?term=${encodeURIComponent(query)}`),
      arrGet("radarr", `/movie/lookup?term=${encodeURIComponent(query)}`),
    ]);

    const tv = sonarr.status === "fulfilled"
      ? (sonarr.value as SonarrLookupResult[]).slice(0, 5).map((s) => ({
          tvdbId: s.tvdbId,
          title: s.title,
          year: s.year,
          overview: s.overview?.slice(0, 150),
          seasons: s.seasonCount,
        }))
      : [];

    const movies = radarr.status === "fulfilled"
      ? (radarr.value as RadarrLookupResult[]).slice(0, 5).map((m) => ({
          tmdbId: m.tmdbId,
          title: m.title,
          year: m.year,
          overview: m.overview?.slice(0, 150),
        }))
      : [];

    return { tv, movies };
  },
});

export const getDownloadsTool = tool({
  description: "Get current download queue from qBittorrent and Sonarr/Radarr import queues",
  inputSchema: z.object({}),
  execute: async () => {
    const [sonarrQ, radarrQ, qbit] = await Promise.allSettled([
      arrGet("sonarr", "/queue?includeUnknownSeriesItems=true"),
      arrGet("radarr", "/queue?includeUnknownMovieItems=true"),
      fetch(`${getServiceUrl("qbittorrent")}/api/v2/torrents/info`).then((r) => r.json()),
    ]);

    const queue = [
      ...(sonarrQ.status === "fulfilled" ? ((sonarrQ.value as ArrQueueResponse).records ?? []).map((q) => ({ title: q.title, status: q.status, type: "tv" })) : []),
      ...(radarrQ.status === "fulfilled" ? ((radarrQ.value as ArrQueueResponse).records ?? []).map((q) => ({ title: q.title, status: q.status, type: "movie" })) : []),
    ];

    const torrents = qbit.status === "fulfilled"
      ? (qbit.value as QBitTorrent[]).map((t) => ({
          name: t.name,
          progress: `${Math.round(t.progress * 100)}%`,
          state: t.state,
          size: `${(t.size / 1073741824).toFixed(1)} GB`,
        }))
      : [];

    return { queue, torrents };
  },
});

export const getCalendarTool = tool({
  description: "Get upcoming TV episodes and movie releases for the next 14 days",
  inputSchema: z.object({}),
  execute: async () => {
    const start = new Date().toISOString().split("T")[0];
    const end = new Date(Date.now() + 14 * 86400000).toISOString().split("T")[0];

    const [sonarrCal, radarrCal] = await Promise.allSettled([
      arrGet("sonarr", `/calendar?start=${start}&end=${end}`),
      arrGet("radarr", `/calendar?start=${start}&end=${end}`),
    ]);

    const episodes = sonarrCal.status === "fulfilled"
      ? (sonarrCal.value as SonarrCalendarEntry[]).map((e) => ({
          series: e.series?.title,
          title: e.title,
          season: e.seasonNumber,
          episode: e.episodeNumber,
          airDate: e.airDateUtc,
        }))
      : [];

    const movies = radarrCal.status === "fulfilled"
      ? (radarrCal.value as RadarrCalendarEntry[]).map((m) => ({
          title: m.title,
          releaseDate: m.digitalRelease ?? m.physicalRelease ?? m.inCinemas,
        }))
      : [];

    return { episodes, movies };
  },
});

export const requestMediaTool = tool({
  description: "Add a TV show or movie to Sonarr/Radarr for automatic downloading. Supports optional quality overrides via qualityProfileId or qualityTier. For TV shows, provide tvdbId. For movies, provide tmdbId. Use search_media first to find the correct ID.",
  inputSchema: z.object({
    type: z.enum(["tv", "movie"]).describe("Whether this is a TV show or movie"),
    tvdbId: z.number().optional().describe("TVDB ID for TV shows (from search_media results)"),
    tmdbId: z.number().optional().describe("TMDB ID for movies (from search_media results)"),
    title: z.string().describe("Title of the show/movie for confirmation"),
    qualityProfileId: z.number().optional().describe("Optional quality profile ID override"),
    qualityTier: z.enum(["compact", "standard", "premium", "efficient", "balanced", "cinephile"]).default("standard")
      .describe("Quality tier: compact (~4GB), standard (~12GB, default), premium (~40GB). Legacy names efficient/balanced/cinephile also accepted."),
  }),
  execute: async ({ type, tvdbId, tmdbId, title, qualityProfileId, qualityTier }) => {
    if (type === "tv") {
      if (!tvdbId) return { success: false, error: "tvdbId required for TV shows" };

      const rootFolders = await arrGet("sonarr", "/rootfolder") as Array<{ path: string }>;
      const rootPath = rootFolders[0]?.path ?? "/tv";
      const tier = normalizeTier(qualityTier);
      const selected = await resolveQualityProfileId("sonarr", qualityProfileId, qualityTier);

      const result = await arrPost("sonarr", "/series", {
        tvdbId,
        title,
        rootFolderPath: rootPath,
        qualityProfileId: selected.profileId,
        monitored: true,
        addOptions: { searchForMissingEpisodes: true },
      }) as ArrAddResult;

      return {
        success: true,
        message: `Added "${title}" to Sonarr`,
        id: result.id,
        quality: {
          requestedProfileId: qualityProfileId ?? null,
          qualityTier: tier,
          appliedProfileId: selected.profileId,
          appliedProfileName: selected.profileName ?? null,
          fallbackUsed: selected.fallbackUsed,
          reason: selected.reason,
        },
      };
    } else {
      if (!tmdbId) return { success: false, error: "tmdbId required for movies" };

      const rootFolders = await arrGet("radarr", "/rootfolder") as Array<{ path: string }>;
      const rootPath = rootFolders[0]?.path ?? "/movies";
      const tier = normalizeTier(qualityTier);
      const selected = await resolveQualityProfileId("radarr", qualityProfileId, qualityTier);

      const result = await arrPost("radarr", "/movie", {
        tmdbId,
        title,
        rootFolderPath: rootPath,
        qualityProfileId: selected.profileId,
        monitored: true,
        addOptions: { searchForMovie: true },
      }) as ArrAddResult;

      return {
        success: true,
        message: `Added "${title}" to Radarr`,
        id: result.id,
        quality: {
          requestedProfileId: qualityProfileId ?? null,
          qualityTier: tier,
          appliedProfileId: selected.profileId,
          appliedProfileName: selected.profileName ?? null,
          fallbackUsed: selected.fallbackUsed,
          reason: selected.reason,
        },
      };
    }
  },
});
