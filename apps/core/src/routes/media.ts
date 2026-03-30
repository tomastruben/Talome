import { Hono } from "hono";
import { createLogger } from "../utils/logger.js";
import { writeNotification } from "../db/notifications.js";

const log = createLogger("media");
import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { getSetting } from "../utils/settings.js";
import { inspectContainer, listContainers } from "../docker/client.js";
import { findOptimizedPath } from "../media/optimizer.js";
import {
  type PathMount,
  getArrMounts,
  containerToHostPath,
  resolveMediaFilePath,
} from "../utils/media-paths.js";
import {
  probeFile, startHls, hlsOutDirByHash, stopHls, touchJob, hasFfmpeg,
  buildStreamResponse, startTransmux, stopTransmux, transmuxJobs, TRANSMUX_ROOT,
} from "./files.js";
import { parseContainerFormat } from "../utils/media-format.js";
import {
  type QualityTier,
  type MediaCategory,
  normalizeTier,
  matchProfile,
  getMaxSizeGb,
  scoreRelease,
} from "@talome/types";

// ── External API response shapes (only fields actually accessed) ──────────

interface ArrImage {
  coverType: string;
  url?: string;
  remoteUrl?: string;
}

interface ArrRatings {
  value?: number;
  tmdb?: { value?: number };
}

interface ArrStatistics {
  seasonCount?: number;
  episodeCount?: number;
  sizeOnDisk?: number;
}

interface ArrSeason {
  seasonNumber?: number;
}

interface SonarrSeries {
  id: number;
  title: string;
  year?: number;
  tvdbId?: number;
  status?: string;
  seasonCount?: number;
  statistics?: ArrStatistics;
  seasons?: ArrSeason[];
  sizeOnDisk?: number;
  images?: ArrImage[];
  monitored?: boolean;
  added?: string;
  overview?: string;
  genres?: string[];
  ratings?: ArrRatings;
  network?: string;
  runtime?: number;
}

interface ArrMediaInfo {
  videoCodec?: string;
  audioCodec?: string;
  runTime?: string;
  containerFormat?: string;
}

interface ArrQualityDetail {
  name?: string;
  resolution?: number;
}

interface ArrQualityWrapper {
  quality?: ArrQualityDetail;
  name?: string;
}

interface ArrMovieFile {
  id?: number;
  path?: string;
  quality?: ArrQualityWrapper;
  mediaInfo?: ArrMediaInfo;
}

interface RadarrMovie {
  id: number;
  title: string;
  sortTitle?: string;
  year?: number;
  tmdbId?: number;
  status?: string;
  hasFile?: boolean;
  sizeOnDisk?: number;
  images?: ArrImage[];
  monitored?: boolean;
  runtime?: number;
  added?: string;
  overview?: string;
  genres?: string[];
  ratings?: ArrRatings;
  studio?: string;
  movieFile?: ArrMovieFile;
  /** Calendar-specific fields */
  digitalRelease?: string;
  physicalRelease?: string;
  inCinemas?: string;
}

interface SonarrEpisodeFile {
  path?: string;
  quality?: ArrQualityWrapper;
  mediaInfo?: ArrMediaInfo;
}

interface SonarrEpisode {
  id: number;
  seasonNumber?: number;
  episodeNumber?: number;
  title?: string;
  hasFile?: boolean;
  monitored?: boolean;
  airDateUtc?: string;
  episodeFileId?: number;
  episodeFile?: SonarrEpisodeFile;
  seriesId?: number;
  series?: SonarrSeries;
}

interface ArrQueueItem {
  id: number;
  title?: string;
  status?: string;
  size?: number;
  sizeleft?: number;
  estimatedCompletionTime?: string;
  downloadId?: string;
  errorMessage?: string;
  statusMessages?: unknown[];
  movieId?: number;
  movie?: RadarrMovie;
  seriesId?: number;
  series?: SonarrSeries;
  indexer?: string;
  protocol?: string;
  quality?: ArrQualityWrapper;
}

interface ArrQueueResponse {
  records?: ArrQueueItem[];
  page?: number;
  pageSize?: number;
  totalRecords?: number;
}

interface QBitTorrent {
  hash: string;
  name: string;
  size: number;
  progress: number;
  dlspeed: number;
  upspeed: number;
  state: string;
  eta: number;
}

interface ArrRelease {
  guid?: string;
  title?: string;
  quality?: ArrQualityWrapper;
  size?: number;
  ageHours?: number;
  indexer?: string;
  rejected?: boolean;
  downloadAllowed?: boolean;
  rejections?: string[];
  customFormatScore?: number;
  downloadUrl?: string;
  protocol?: string;
  seeders?: number;
  leechers?: number;
  seriesTitle?: string;
  seasonNumber?: number;
  mappedMovieId?: number;
  movieId?: number;
  seriesId?: number;
  mappedSeriesId?: number;
}

interface ArrWantedRecord {
  id: number;
  title?: string;
  sortTitle?: string;
  year?: number;
  monitored?: boolean;
  seasonNumber?: number;
  episodeNumber?: number;
  quality?: ArrQualityWrapper;
  size?: number;
  images?: ArrImage[];
  seriesId?: number;
  series?: SonarrSeries;
}

interface ArrRootFolder {
  path?: string;
}

interface ArrQualityProfile {
  id: number;
  name?: string | null;
}

interface OverseerrRequest {
  id: number;
  type?: string;
  status?: number;
  media?: {
    title?: string;
    name?: string;
    overview?: string;
    posterPath?: string;
    tmdbId?: number;
    mediaType?: string;
  };
  requestedBy?: {
    displayName?: string;
    avatar?: string;
  };
  createdAt?: string;
}

interface OverseerrResponse {
  results?: OverseerrRequest[];
  pageInfo?: { results?: number };
}

interface PlexMetadataItem {
  ratingKey?: string;
  title?: string;
  grandparentTitle?: string;
  type?: string;
  year?: number;
  parentYear?: number;
  thumb?: string;
  grandparentThumb?: string;
  viewOffset?: number;
  duration?: number;
  lastViewedAt?: number;
  viewedAt?: number;
  parentIndex?: number;
  index?: number;
  viewCount?: number;
  guid?: string;
  Guid?: Array<{ id?: string }>;
}

interface PlexMediaContainer {
  MediaContainer?: {
    Metadata?: PlexMetadataItem[];
    Directory?: Array<{ key: string; type: string }>;
  };
}

interface ArrStatusResponse {
  version?: string;
}

/** Webhook payload from Radarr/Sonarr */
interface ArrWebhookPayload {
  eventType?: string;
  movie?: { id?: number; title?: string };
  remoteMovie?: { title?: string };
  movieFile?: { quality?: ArrQualityWrapper };
  quality?: ArrQualityWrapper;
  isUpgrade?: boolean;
  series?: { id?: number; title?: string };
  episodes?: Array<{
    seasonNumber?: number;
    episodeNumber?: number;
    title?: string;
  }>;
}

/** Helper: narrow unknown error to get message string */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const POSTER_CACHE_DIR = join(homedir(), ".talome", "cache", "posters");
// Allowed widths to prevent cache-busting with arbitrary values
const ALLOWED_WIDTHS = [120, 240, 400] as const;
const ALLOWED_BACKDROP_WIDTHS = [400, 780, 1280] as const;

const media = new Hono();

function getServiceUrl(service: string): string {
  const custom = getSetting(`${service}_url`);
  if (custom) return custom;
  const defaults: Record<string, string> = {
    sonarr: "http://localhost:8989",
    radarr: "http://localhost:7878",
    prowlarr: "http://localhost:9696",
    qbittorrent: "http://localhost:8080",
    overseerr: "http://localhost:5055",
    plex: "http://localhost:32400",
  };
  return defaults[service] ?? "";
}

function getApiKey(service: string): string {
  return getSetting(`${service}_api_key`) ?? "";
}

/** True when the error is a network/connectivity failure rather than a logic bug. */
function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|network|UND_ERR/i.test(msg);
}

function getPlexConfig(): { baseUrl: string; token: string } | null {
  const baseUrl = getSetting("plex_url") ?? getServiceUrl("plex");
  const token = getSetting("plex_token") ?? "";
  if (!token) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), token };
}

function plexFetch(path: string, token: string, baseUrl: string, init?: RequestInit): Promise<Response> {
  const sep = path.includes("?") ? "&" : "?";
  return fetch(`${baseUrl}${path}${sep}X-Plex-Token=${token}`, {
    ...init,
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    signal: init?.signal ?? AbortSignal.timeout(8000),
  });
}

// Build a poster URL that the browser can load via the Talome proxy.
// Radarr/Sonarr cache poster images locally — `url` is the path on the arr
// server (e.g. "/MediaCover/123/poster.jpg"). We proxy it through Talome so the
// browser never needs a direct connection to the arr service or TMDB.
function posterUrl(service: "radarr" | "sonarr", images: ArrImage[]): string | undefined {
  const img = images?.find((i) => i.coverType === "poster");
  if (!img) return undefined;
  // Prefer the locally-cached path; fall back to remoteUrl as the last resort.
  const localPath: string | undefined = img.url;   // e.g. "/MediaCover/123/poster.jpg"
  const remote: string | undefined = img.remoteUrl; // e.g. "https://image.tmdb.org/..."
  if (localPath) {
    // Strip leading slash so the proxy param is clean.
    const path = localPath.startsWith("/") ? localPath.slice(1) : localPath;
    return `/api/media/poster?service=${service}&path=${encodeURIComponent(path)}`;
  }
  return remote;
}

function backdropUrl(service: "radarr" | "sonarr", images: ArrImage[]): string | undefined {
  const img = images?.find((i) => i.coverType === "fanart");
  if (!img) return undefined;
  const localPath: string | undefined = img.url;
  const remote: string | undefined = img.remoteUrl;
  if (localPath) {
    const path = localPath.startsWith("/") ? localPath.slice(1) : localPath;
    return `/api/media/backdrop?service=${service}&path=${encodeURIComponent(path)}`;
  }
  return remote;
}

function extractSeasonCount(series: SonarrSeries): number {
  if (typeof series?.seasonCount === "number") return series.seasonCount;
  if (typeof series?.statistics?.seasonCount === "number") return series.statistics.seasonCount;
  if (Array.isArray(series?.seasons)) {
    const regularSeasons = series.seasons.filter((season) =>
      typeof season?.seasonNumber === "number" ? season.seasonNumber > 0 : true
    );
    return regularSeasons.length > 0 ? regularSeasons.length : series.seasons.length;
  }
  return 0;
}

// Quality tier functions imported from @talome/types: normalizeTier, matchProfile, getMaxSizeGb, scoreRelease

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

async function fetchSeriesTitle(seriesId: string): Promise<string> {
  try {
    const series = await serviceGet("sonarr", `/series/${seriesId}`) as SonarrSeries | null;
    return series?.title ?? "";
  } catch {
    return "";
  }
}

async function fetchMovieTitle(movieId: string): Promise<string> {
  try {
    const movie = await serviceGet("radarr", `/movie/${movieId}`) as RadarrMovie | null;
    return movie?.title ?? "";
  } catch {
    return "";
  }
}

async function serviceGet(service: string, path: string): Promise<unknown> {
  const baseUrl = getServiceUrl(service);
  const apiKey = getApiKey(service);
  if (!baseUrl) throw new Error(`${service} URL not configured`);

  const url = `${baseUrl}/api/v3${path}`;
  const res = await fetch(url, {
    headers: apiKey ? { "X-Api-Key": apiKey } : {},
  });
  if (!res.ok) throw new Error(`${service} API ${res.status}: ${res.statusText}`);
  return res.json();
}

async function servicePost(service: string, path: string, body: unknown): Promise<unknown> {
  const baseUrl = getServiceUrl(service);
  const apiKey = getApiKey(service);
  if (!baseUrl) throw new Error(`${service} URL not configured`);

  const url = `${baseUrl}/api/v3${path}`;
  const res = await fetch(url, {
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

async function serviceDelete(service: string, path: string): Promise<Response> {
  const baseUrl = getServiceUrl(service);
  const apiKey = getApiKey(service);
  if (!baseUrl) throw new Error(`${service} URL not configured`);

  const url = `${baseUrl}/api/v3${path}`;
  return fetch(url, {
    method: "DELETE",
    headers: apiKey ? { "X-Api-Key": apiKey } : {},
  });
}

// Proxy poster images from Radarr/Sonarr so the browser only needs to talk to
// Talome — no direct connection to the arr service or TMDB required.
// Accepts optional `w` query param (120, 240, 400) to resize for retina grids.
media.get("/poster", async (c) => {
  const service = c.req.query("service") as "radarr" | "sonarr" | "plex" | "plex-cloud" | undefined;
  const path = c.req.query("path");
  if (!service || !path || !["radarr", "sonarr", "plex", "plex-cloud"].includes(service)) {
    return c.text("Bad request", 400);
  }

  // Plex cloud poster proxy (metadata.provider.plex.tv — watchlist items)
  if (service === "plex-cloud") {
    const plex = getPlexConfig();
    if (!plex) return c.text("Plex not configured", 400);

    const requestedWidth = c.req.query("w") ? parseInt(c.req.query("w")!, 10) : null;
    const width = requestedWidth && (ALLOWED_WIDTHS as readonly number[]).includes(requestedWidth) ? requestedWidth : null;
    const cacheKey = createHash("md5").update(`plex-cloud:${path}:${width ?? "default"}`).digest("hex");
    const cachePath = join(POSTER_CACHE_DIR, `${cacheKey}.webp`);

    try {
      const cached = await readFile(cachePath);
      return new Response(new Uint8Array(cached), {
        headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=86400" },
      });
    } catch { /* cache miss */ }

    try {
      const sep = path.includes("?") ? "&" : "?";
      const res = await fetch(`https://metadata.provider.plex.tv${path}${sep}X-Plex-Token=${plex.token}`, {
        headers: { Accept: "image/*" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return c.text("Not found", 404);
      const buf = Buffer.from(await res.arrayBuffer());
      const resized = await sharp(buf)
        .resize(width ?? 240, undefined, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      mkdir(POSTER_CACHE_DIR, { recursive: true }).then(() => writeFile(cachePath, resized)).catch((err) => log.debug("poster cache write failed", err));
      return new Response(resized.buffer.slice(resized.byteOffset, resized.byteOffset + resized.byteLength) as ArrayBuffer, {
        headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=86400" },
      });
    } catch {
      return c.text("Failed to fetch poster", 502);
    }
  }

  // Plex poster proxy — different auth model
  if (service === "plex") {
    const plex = getPlexConfig();
    if (!plex) return c.text("Plex not configured", 400);

    const requestedWidth = c.req.query("w") ? parseInt(c.req.query("w")!, 10) : null;
    const width = requestedWidth && (ALLOWED_WIDTHS as readonly number[]).includes(requestedWidth) ? requestedWidth : null;
    const cacheKey = width
      ? createHash("md5").update(`plex:${path}:${width}`).digest("hex")
      : createHash("md5").update(`plex:${path}`).digest("hex");
    const cachePath = join(POSTER_CACHE_DIR, `${cacheKey}.webp`);

    try {
      const cached = await readFile(cachePath);
      return new Response(new Uint8Array(cached), {
        headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=86400" },
      });
    } catch { /* cache miss */ }

    try {
      const res = await plexFetch(path, plex.token, plex.baseUrl);
      if (!res.ok) return c.text("Not found", 404);
      const buf = Buffer.from(await res.arrayBuffer());
      const resized = await sharp(buf)
        .resize(width ?? 240, undefined, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      mkdir(POSTER_CACHE_DIR, { recursive: true }).then(() => writeFile(cachePath, resized)).catch((err) => log.debug("plex poster cache write failed", err));
      return new Response(resized.buffer.slice(resized.byteOffset, resized.byteOffset + resized.byteLength) as ArrayBuffer, {
        headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=86400" },
      });
    } catch {
      return c.text("Failed to fetch Plex poster", 502);
    }
  }

  const requestedWidth = c.req.query("w") ? parseInt(c.req.query("w")!, 10) : null;
  const width = requestedWidth && (ALLOWED_WIDTHS as readonly number[]).includes(requestedWidth)
    ? requestedWidth
    : null;

  // Check disk cache first when a resize is requested
  const cacheKey = width
    ? createHash("md5").update(`${service}:${path}:${width}`).digest("hex")
    : null;
  const cachePath = cacheKey ? join(POSTER_CACHE_DIR, `${cacheKey}.webp`) : null;

  if (cachePath) {
    try {
      const cached = await readFile(cachePath);
      const fileStat = await stat(cachePath);
      const etag = `"${cacheKey}-${fileStat.mtimeMs}"`;
      if (c.req.header("if-none-match") === etag) {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800" },
        });
      }
      return new Response(new Uint8Array(cached), {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
          ETag: etag,
        },
      });
    } catch {
      // Cache miss — continue to fetch + resize
    }
  }

  const baseUrl = getServiceUrl(service);
  const apiKey = getApiKey(service);
  // Radarr v6+ redirects static /MediaCover/ to login — route through API path
  const resolvedPath = service === "radarr" && path.startsWith("MediaCover")
    ? `api/v3/mediacover/${path.replace(/^MediaCover\//, "")}`
    : path;
  const imageUrl = `${baseUrl}/${resolvedPath}`;
  try {
    const ifNoneMatch = !width ? c.req.header("if-none-match") : undefined;
    const ifModifiedSince = !width ? c.req.header("if-modified-since") : undefined;
    const upstreamHeaders: Record<string, string> = apiKey ? { "X-Api-Key": apiKey } : {};
    if (ifNoneMatch) upstreamHeaders["If-None-Match"] = ifNoneMatch;
    if (ifModifiedSince) upstreamHeaders["If-Modified-Since"] = ifModifiedSince;

    const res = await fetch(imageUrl, {
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 304) {
      return new Response(null, {
        status: 304,
        headers: {
          "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
          ...(res.headers.get("etag") ? { ETag: res.headers.get("etag")! } : {}),
          ...(res.headers.get("last-modified")
            ? { "Last-Modified": res.headers.get("last-modified")! }
            : {}),
        },
      });
    }
    if (!res.ok) return c.text("Not found", 404);

    const buf = Buffer.from(await res.arrayBuffer());

    // No resize requested — pass through original
    if (!width) {
      const contentType = res.headers.get("content-type") ?? "image/jpeg";
      return new Response(buf, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
          ...(res.headers.get("etag") ? { ETag: res.headers.get("etag")! } : {}),
          ...(res.headers.get("last-modified")
            ? { "Last-Modified": res.headers.get("last-modified")! }
            : {}),
        },
      });
    }

    // Resize to requested width, convert to webp for best compression
    const resized = await sharp(buf)
      .resize(width, undefined, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();

    // Write to cache in the background
    mkdir(POSTER_CACHE_DIR, { recursive: true })
      .then(() => writeFile(cachePath!, resized))
      .catch((err) => log.debug("poster cache write failed", err));

    const etag = `"${cacheKey}"`;
    return new Response(resized.buffer.slice(resized.byteOffset, resized.byteOffset + resized.byteLength) as ArrayBuffer, {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        ETag: etag,
      },
    });
  } catch {
    return c.text("Failed to fetch poster", 502);
  }
});

// Proxy backdrop/fanart images from Radarr/Sonarr — same pattern as poster proxy
// but with landscape-oriented widths for hero sections.
media.get("/backdrop", async (c) => {
  const service = c.req.query("service") as "radarr" | "sonarr" | undefined;
  const path = c.req.query("path");
  if (!service || !path || !["radarr", "sonarr"].includes(service)) {
    return c.text("Bad request", 400);
  }

  const requestedWidth = c.req.query("w") ? parseInt(c.req.query("w")!, 10) : null;
  const width = requestedWidth && (ALLOWED_BACKDROP_WIDTHS as readonly number[]).includes(requestedWidth)
    ? requestedWidth
    : null;

  const cacheKey = width
    ? createHash("md5").update(`bd:${service}:${path}:${width}`).digest("hex")
    : createHash("md5").update(`bd:${service}:${path}`).digest("hex");
  const cachePath = join(POSTER_CACHE_DIR, `${cacheKey}.webp`);

  try {
    const cached = await readFile(cachePath);
    const fileStat = await stat(cachePath);
    const etag = `"${cacheKey}-${fileStat.mtimeMs}"`;
    if (c.req.header("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800" },
      });
    }
    return new Response(new Uint8Array(cached), {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        ETag: etag,
      },
    });
  } catch { /* cache miss */ }

  const baseUrl = getServiceUrl(service);
  const apiKey = getApiKey(service);
  const resolvedBdPath = service === "radarr" && path.startsWith("MediaCover")
    ? `api/v3/mediacover/${path.replace(/^MediaCover\//, "")}`
    : path;
  const imageUrl = `${baseUrl}/${resolvedBdPath}`;
  try {
    const res = await fetch(imageUrl, {
      headers: apiKey ? { "X-Api-Key": apiKey } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return c.text("Not found", 404);
    const buf = Buffer.from(await res.arrayBuffer());

    if (!width) {
      const contentType = res.headers.get("content-type") ?? "image/jpeg";
      return new Response(buf, {
        headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=86400" },
      });
    }

    const resized = await sharp(buf)
      .resize(width, undefined, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();

    mkdir(POSTER_CACHE_DIR, { recursive: true })
      .then(() => writeFile(cachePath, resized))
      .catch((err) => log.debug("backdrop cache write failed", err));

    return new Response(resized.buffer.slice(resized.byteOffset, resized.byteOffset + resized.byteLength) as ArrayBuffer, {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        ETag: `"${cacheKey}"`,
      },
    });
  } catch {
    return c.text("Failed to fetch backdrop", 502);
  }
});

async function qbitGet(path: string): Promise<unknown> {
  const baseUrl = getServiceUrl("qbittorrent");
  const res = await fetch(`${baseUrl}/api/v2${path}`);
  if (!res.ok) throw new Error(`qBittorrent API ${res.status}`);
  return res.json();
}

media.get("/library", async (c) => {
  try {
    const [series, movies] = await Promise.allSettled([
      serviceGet("sonarr", "/series"),
      serviceGet("radarr", "/movie"),
    ]);

    const tvShows = series.status === "fulfilled"
      ? (series.value as SonarrSeries[]).map((s) => ({
          id: s.id,
          title: s.title,
          year: s.year,
          tvdbId: s.tvdbId ?? null,
          type: "tv" as const,
          status: s.status,
          seasonCount: extractSeasonCount(s),
          episodeCount: s.statistics?.episodeCount ?? 0,
          sizeOnDisk: s.statistics?.sizeOnDisk ?? 0,
          poster: posterUrl("sonarr", s.images ?? []),
          backdrop: backdropUrl("sonarr", s.images ?? []),
          monitored: s.monitored,
          added: s.added,
          overview: s.overview ?? "",
          genres: s.genres ?? [],
          rating: s.ratings?.value ?? null,
          network: s.network ?? null,
          runtime: s.runtime ?? null,
        }))
      : [];

    const movieList = movies.status === "fulfilled"
      ? (movies.value as RadarrMovie[]).map((m) => ({
          id: m.id,
          title: m.title,
          year: m.year,
          tmdbId: m.tmdbId ?? null,
          type: "movie" as const,
          status: m.status,
          hasFile: m.hasFile,
          sizeOnDisk: m.sizeOnDisk ?? 0,
          poster: posterUrl("radarr", m.images ?? []),
          backdrop: backdropUrl("radarr", m.images ?? []),
          monitored: m.monitored,
          runtime: m.runtime ?? null,
          added: m.added,
          overview: m.overview ?? "",
          genres: m.genres ?? [],
          rating: m.ratings?.tmdb?.value ?? m.ratings?.value ?? null,
          studio: m.studio ?? null,
          filePath: m.movieFile?.path ?? null,
          quality: m.movieFile ? {
            name: m.movieFile.quality?.quality?.name ?? null,
            resolution: m.movieFile.quality?.quality?.resolution ?? null,
            codec: m.movieFile.mediaInfo?.videoCodec ?? null,
            audioCodec: m.movieFile.mediaInfo?.audioCodec ?? null,
            runtime: m.movieFile.mediaInfo?.runTime ?? null,
            container: m.movieFile.mediaInfo?.containerFormat ?? null,
          } : null,
        }))
      : [];

    return c.json({
      tv: tvShows,
      movies: movieList,
      sonarrAvailable: series.status === "fulfilled",
      radarrAvailable: movies.status === "fulfilled",
      totals: {
        tvShows: tvShows.length,
        movies: movieList.length,
      },
    });
  } catch (err: unknown) {
    console.error("[media/library]", err);
    return c.json({ error: errMsg(err), tv: [], movies: [], sonarrAvailable: false, radarrAvailable: false, totals: { tvShows: 0, movies: 0 } }, 500);
  }
});

// ── Episodes for a series (grouped by season) ────────────────────────────────

media.get("/episodes", async (c) => {
  const seriesId = c.req.query("seriesId");
  if (!seriesId) return c.json({ error: "seriesId is required" }, 400);

  try {
    const raw = await serviceGet("sonarr", `/episode?seriesId=${seriesId}&includeEpisodeFile=true`);
    const episodes = (raw ?? []) as SonarrEpisode[];

    // Group by season, filter out specials (season 0) unless it's the only season
    const bySeasonMap = new Map<number, SonarrEpisode[]>();
    for (const ep of episodes) {
      const sn = ep.seasonNumber ?? 0;
      if (!bySeasonMap.has(sn)) bySeasonMap.set(sn, []);
      bySeasonMap.get(sn)!.push(ep);
    }

    const hasRegularSeasons = [...bySeasonMap.keys()].some((k) => k > 0);
    const seasons = [...bySeasonMap.entries()]
      .filter(([sn]) => !hasRegularSeasons || sn > 0)
      .sort(([a], [b]) => a - b)
      .map(([seasonNumber, eps]) => {
        const sorted = eps.sort((a, b) => (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0));
        return {
          seasonNumber,
          totalEpisodes: sorted.length,
          downloadedEpisodes: sorted.filter((e) => e.hasFile).length,
          episodes: sorted.map((e) => ({
            id: e.id,
            episodeNumber: e.episodeNumber ?? 0,
            title: e.title ?? "",
            hasFile: e.hasFile ?? false,
            monitored: e.monitored ?? false,
            airDateUtc: e.airDateUtc ?? null,
            quality: e.episodeFile?.quality?.quality?.name ?? null,
            filePath: e.episodeFile?.path ?? null,
            runtime: e.episodeFile?.mediaInfo?.runTime ?? null,
            container: e.episodeFile?.mediaInfo?.containerFormat ?? null,
            codec: e.episodeFile?.mediaInfo?.videoCodec ?? null,
            audioCodec: e.episodeFile?.mediaInfo?.audioCodec ?? null,
          })),
        };
      });

    return c.json({ seriesId: Number(seriesId), seasons });
  } catch (err: unknown) {
    console.error("[media/episodes]", errMsg(err));
    if (isNetworkError(err)) {
      return c.json({ seriesId: Number(seriesId), seasons: [], available: false });
    }
    return c.json({ error: errMsg(err), seasons: [] }, 500);
  }
});

media.get("/downloads", async (c) => {
  try {
    const [sonarrQueue, radarrQueue, torrents, sonarrLibrary, radarrLibrary] = await Promise.allSettled([
      serviceGet("sonarr", "/queue?includeUnknownSeriesItems=true&includeUnknownEpisodeItems=true&includeSeries=true"),
      serviceGet("radarr", "/queue?includeUnknownMovieItems=true&includeMovie=true"),
      qbitGet("/torrents/info"),
      serviceGet("sonarr", "/series"),
      serviceGet("radarr", "/movie"),
    ]);

    // Build id→poster maps from the full library (has locally-cached image paths)
    const moviePosterById = new Map<number, string>();
    if (radarrLibrary.status === "fulfilled") {
      for (const m of radarrLibrary.value as RadarrMovie[]) {
        const p = posterUrl("radarr", m.images ?? []);
        if (p && m.id) moviePosterById.set(m.id, p);
      }
    }
    const seriesPosterById = new Map<number, string>();
    if (sonarrLibrary.status === "fulfilled") {
      for (const s of sonarrLibrary.value as SonarrSeries[]) {
        const p = posterUrl("sonarr", s.images ?? []);
        if (p && s.id) seriesPosterById.set(s.id, p);
      }
    }

    const torrentList = torrents.status === "fulfilled"
      ? (torrents.value as QBitTorrent[]).map((t) => ({
          hash: t.hash,
          name: t.name,
          size: t.size,
          progress: t.progress,
          dlspeed: t.dlspeed,
          upspeed: t.upspeed,
          state: t.state,
          eta: t.eta,
        }))
      : [];

    // Build a map from torrent hash → torrent for correlation
    const torrentMap = new Map(torrentList.map((t) => [t.hash.toLowerCase(), t]));

    const extractStatusMessages = (messages: unknown): string[] => {
      if (!Array.isArray(messages)) return [];
      return messages
        .map((message: unknown) => {
          if (typeof message === "string") return message.trim();
          if (message && typeof message === "object") {
            const msg = message as Record<string, unknown>;
            const text = msg.messages ?? msg.message ?? msg.title;
            return typeof text === "string" ? text.trim() : "";
          }
          return "";
        })
        .filter((message: string) => message.length > 0);
    };

    const enrichQueue = (items: ArrQueueItem[], type: "tv" | "movie") =>
      items.map((q) => {
        const torrent = q.downloadId ? torrentMap.get(q.downloadId.toLowerCase()) : null;
        // Look up poster from full library (has local cached paths), fall back to queue item images
        const mediaId = type === "movie" ? (q.movieId ?? q.movie?.id) : (q.seriesId ?? q.series?.id);
        const poster = type === "movie"
          ? (mediaId != null ? moviePosterById.get(mediaId) : undefined) ?? posterUrl("radarr", q.movie?.images ?? []) ?? null
          : (mediaId != null ? seriesPosterById.get(mediaId) : undefined) ?? posterUrl("sonarr", q.series?.images ?? []) ?? null;
        const size = q.size ?? 0;
        return {
          id: q.id,
          title: q.title,
          status: q.status,
          size,
          sizeleft: q.sizeleft ?? 0,
          type,
          movieId: type === "movie" ? (q.movieId ?? q.movie?.id ?? null) : null,
          seriesId: type === "tv" ? (q.seriesId ?? q.series?.id ?? null) : null,
          estimatedCompletionTime: q.estimatedCompletionTime ?? null,
          downloadId: q.downloadId ?? null,
          progress: torrent
            ? torrent.progress
            : size > 0 ? (size - (q.sizeleft ?? 0)) / size : 0,
          dlspeed: torrent?.dlspeed ?? 0,
          eta: torrent
            ? torrent.eta
            : q.estimatedCompletionTime
              ? Math.round((new Date(q.estimatedCompletionTime).getTime() - Date.now()) / 1000)
              : null,
          poster,
          errorMessage: q.errorMessage ?? null,
          statusMessages: extractStatusMessages(q.statusMessages),
        };
      });

    const sonarrItems = sonarrQueue.status === "fulfilled"
      ? enrichQueue((sonarrQueue.value as ArrQueueResponse).records ?? [], "tv")
      : [];

    const radarrItems = radarrQueue.status === "fulfilled"
      ? enrichQueue((radarrQueue.value as ArrQueueResponse).records ?? [], "movie")
      : [];

    // Build a title→poster map for matching raw torrents — use the full library maps
    const titlePosterMap = new Map<string, string>();
    if (radarrLibrary.status === "fulfilled") {
      for (const m of radarrLibrary.value as RadarrMovie[]) {
        const p = moviePosterById.get(m.id);
        if (p && m.title) titlePosterMap.set(m.title.toLowerCase(), p);
      }
    }
    if (sonarrLibrary.status === "fulfilled") {
      for (const s of sonarrLibrary.value as SonarrSeries[]) {
        const p = seriesPosterById.get(s.id);
        if (p && s.title) titlePosterMap.set(s.title.toLowerCase(), p);
      }
    }

    // Helper: find best-matching poster for a raw torrent name
    function matchPoster(torrentName: string): string | null {
      const lower = torrentName.toLowerCase();
      for (const [title, poster] of titlePosterMap) {
        if (lower.includes(title)) return poster;
      }
      return null;
    }

    // Only return raw torrents that are NOT already represented by a queue item
    const queueDownloadIds = new Set(
      [...sonarrItems, ...radarrItems]
        .map((q) => q.downloadId?.toLowerCase())
        .filter(Boolean)
    );
    const unmatchedTorrents = torrentList
      .filter((t) => !queueDownloadIds.has(t.hash.toLowerCase()))
      .map((t) => ({ ...t, poster: matchPoster(t.name) }));

    return c.json({
      queue: [...sonarrItems, ...radarrItems],
      torrents: unmatchedTorrents,
    });
  } catch (err: unknown) {
    console.error("[media/downloads]", errMsg(err));
    return c.json({ error: errMsg(err), queue: [], torrents: [] }, 500);
  }
});

media.get("/calendar", async (c) => {
  const start = c.req.query("start") ?? new Date().toISOString().split("T")[0];
  const end =
    c.req.query("end") ??
    new Date(Date.now() + 14 * 86400000).toISOString().split("T")[0];

  try {
    const [sonarrCal, radarrCal] = await Promise.allSettled([
      serviceGet("sonarr", `/calendar?start=${start}&end=${end}`),
      serviceGet("radarr", `/calendar?start=${start}&end=${end}`),
    ]);

    const episodes = sonarrCal.status === "fulfilled"
      ? (sonarrCal.value as SonarrEpisode[]).map((e) => ({
          id: e.id,
          seriesId: e.seriesId ?? e.series?.id ?? null,
          seriesTitle: e.series?.title ?? "Unknown",
          title: e.title,
          season: e.seasonNumber,
          episode: e.episodeNumber,
          airDate: e.airDateUtc,
          type: "episode" as const,
          poster: posterUrl("sonarr", e.series?.images ?? []) ?? null,
        }))
      : [];

    const movies = radarrCal.status === "fulfilled"
      ? (radarrCal.value as RadarrMovie[]).map((m) => ({
          id: m.id,
          title: m.title,
          releaseDate: m.digitalRelease ?? m.physicalRelease ?? m.inCinemas,
          type: "movie" as const,
          poster: posterUrl("radarr", m.images ?? []) ?? null,
          year: m.year ?? null,
        }))
      : [];

    return c.json({ episodes, movies });
  } catch (err: unknown) {
    console.error("[media/calendar]", errMsg(err));
    return c.json({ error: errMsg(err), episodes: [], movies: [] }, 500);
  }
});

media.get("/quality-profiles", async (c) => {
  const app = c.req.query("app") as "sonarr" | "radarr" | undefined;
  if (!app || !["sonarr", "radarr"].includes(app)) {
    return c.json({ error: "app must be sonarr or radarr", qualityProfiles: [] }, 400);
  }
  try {
    const profiles = await serviceGet(app, "/qualityprofile");
    const qualityProfiles = (profiles as ArrQualityProfile[]).map((p) => ({ id: p.id, name: p.name ?? `Profile ${p.id}` }));
    return c.json({ app, qualityProfiles });
  } catch (err: unknown) {
    return c.json({ error: errMsg(err), app, qualityProfiles: [] }, 500);
  }
});

media.post("/quality-profile/apply", async (c) => {
  try {
    const body = await c.req.json();
    const app = body?.app as "sonarr" | "radarr" | undefined;
    const qualityProfileId = Number(body?.qualityProfileId);
    const mediaIdsRaw = Array.isArray(body?.mediaIds)
      ? body.mediaIds
      : body?.mediaId != null
        ? [body.mediaId]
        : [];
    const mediaIds = mediaIdsRaw
      .map((id: unknown) => Number(id))
      .filter((id: number) => Number.isInteger(id) && id > 0);

    if (!app || !["sonarr", "radarr"].includes(app)) {
      return c.json({ error: "app must be sonarr or radarr" }, 400);
    }
    if (!Number.isInteger(qualityProfileId) || qualityProfileId <= 0) {
      return c.json({ error: "qualityProfileId must be a positive integer" }, 400);
    }
    if (mediaIds.length === 0) {
      return c.json({ error: "mediaIds (or mediaId) is required" }, 400);
    }

    const baseUrl = getServiceUrl(app);
    const apiKey = getApiKey(app);
    if (!baseUrl) throw new Error(`${app} URL not configured`);

    const endpoint = app === "sonarr" ? "/series/editor" : "/movie/editor";
    const res = await fetch(`${baseUrl}/api/v3${endpoint}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "X-Api-Key": apiKey } : {}),
      },
      body: JSON.stringify({
        qualityProfileId,
        seriesIds: app === "sonarr" ? mediaIds : undefined,
        movieIds: app === "radarr" ? mediaIds : undefined,
      }),
    });

    if (!res.ok) {
      let details = "";
      try {
        details = await res.text();
      } catch {
        details = "";
      }
      return c.json(
        { error: `${app} API ${res.status}: ${res.statusText}`, details: details || undefined },
        502
      );
    }

    return c.json({
      ok: true,
      app,
      qualityProfileId,
      mediaIds,
      message: `Applied quality profile ${qualityProfileId} to ${mediaIds.length} item(s).`,
    });
  } catch (err: unknown) {
    return c.json({ error: errMsg(err) || "Failed to apply quality profile" }, 500);
  }
});

media.get("/wanted", async (c) => {
  const app = c.req.query("app") as "sonarr" | "radarr" | undefined;
  const kind = c.req.query("kind") === "cutoff" ? "cutoff" : "missing";
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize") ?? 30)));
  if (!app || !["sonarr", "radarr"].includes(app)) {
    return c.json({ error: "app must be sonarr or radarr", records: [] }, 400);
  }
  try {
    const include = app === "sonarr" ? "&includeSeries=true&includeImages=true" : "";
    const data = await serviceGet(app, `/wanted/${kind}?page=${page}&pageSize=${pageSize}${include}`) as {
      records?: ArrWantedRecord[];
      page?: number;
      pageSize?: number;
      totalRecords?: number;
    };
    const records = (data?.records ?? []).map((r) => {
      const title = app === "sonarr"
        ? `${r.series?.title ?? "Unknown"} ${r.seasonNumber != null ? `S${String(r.seasonNumber).padStart(2, "0")}` : ""}${r.episodeNumber != null ? `E${String(r.episodeNumber).padStart(2, "0")}` : ""}`.trim()
        : (r.title ?? r.sortTitle ?? "Unknown");
      const poster = app === "sonarr"
        ? posterUrl("sonarr", r.series?.images ?? []) ?? null
        : posterUrl("radarr", r.images ?? []) ?? null;
      return {
        id: r.id,
        app,
        title,
        year: r.year ?? r.series?.year ?? null,
        monitored: r.monitored ?? r.series?.monitored ?? null,
        quality: r.quality?.quality?.name ?? r.quality?.name ?? null,
        size: r.size ?? null,
        poster,
        seriesId: app === "sonarr" ? (r.seriesId ?? r.series?.id ?? null) : null,
        episodeId: app === "sonarr" ? (r.id ?? null) : null,
        seasonNumber: app === "sonarr" ? (r.seasonNumber ?? null) : null,
        movieId: app === "radarr" ? (r.id ?? null) : null,
      };
    });
    return c.json({
      app,
      kind,
      page: data?.page ?? page,
      pageSize: data?.pageSize ?? pageSize,
      totalRecords: data?.totalRecords ?? records.length,
      records,
    });
  } catch (err: unknown) {
    console.error(`[media/wanted] ${app}/${kind}:`, errMsg(err));
    if (isNetworkError(err)) {
      return c.json({ app, kind, page, pageSize, totalRecords: 0, records: [], available: false });
    }
    return c.json({ error: errMsg(err), app, kind, records: [] }, 500);
  }
});

media.get("/releases", async (c) => {
  const app = c.req.query("app") as "sonarr" | "radarr" | undefined;
  if (!app || !["sonarr", "radarr"].includes(app)) {
    return c.json({ error: "app must be sonarr or radarr", releases: [] }, 400);
  }

  const tier = normalizeTier(c.req.query("qualityTier") ?? c.req.query("qualityIntent"));
  const category: MediaCategory = app === "radarr" ? "movie" : "episode";
  const defaultMaxGb = getMaxSizeGb(tier, category);
  const maxSizeGbRaw = Number(c.req.query("maxSizeGb") ?? defaultMaxGb);
  const maxSizeGb = Number.isFinite(maxSizeGbRaw) && maxSizeGbRaw > 0 ? maxSizeGbRaw : defaultMaxGb;
  const maxSizeBytes = maxSizeGb * 1024 * 1024 * 1024;
  const preferMp4 = c.req.query("preferMp4") === "true";
  const showAll = c.req.query("showAll") === "true";

  try {
    const movieId = c.req.query("movieId");
    const seriesId = c.req.query("seriesId");
    const seasonNumber = c.req.query("seasonNumber");
    const episodeId = c.req.query("episodeId");
    const targetTitle = c.req.query("targetTitle") ?? "";

    const params = new URLSearchParams();
    if (app === "radarr") {
      if (!movieId) return c.json({ error: "movieId is required for radarr", releases: [] }, 400);
      params.set("movieId", movieId);
    } else {
      // Sonarr: episodeId alone triggers targeted episode search.
      // seriesId alone returns generic RSS feed (useless).
      // seriesId + seasonNumber triggers targeted season search.
      if (episodeId) {
        params.set("episodeId", episodeId);
      } else if (seriesId) {
        params.set("seriesId", seriesId);
        if (!seasonNumber) params.set("seasonNumber", "1");
        else params.set("seasonNumber", seasonNumber);
      } else {
        return c.json({ error: "seriesId or episodeId is required for sonarr", releases: [] }, 400);
      }
    }

    const raw = await serviceGet(app, `/release?${params.toString()}`);
    const allReleases = (raw ?? []) as ArrRelease[];

    // ── Two-pass filtering: strict match first, title fallback second ──
    // Sonarr releases have `seriesTitle` (string); Radarr has `mappedMovieId` (number).
    // showAll bypasses all title filtering — returns every release from the indexer.
    let filtered: ArrRelease[];
    let filterMethod: string;

    if (showAll) {
      filtered = allReleases;
      filterMethod = "show-all";
    } else if (app === "sonarr" && seriesId) {
      // Resolve the series title for matching against Sonarr's `seriesTitle` field
      const seriesName = targetTitle || await fetchSeriesTitle(seriesId);
      const normSeriesName = seriesName ? normaliseTitle(seriesName) : "";

      // Pass 1: match on `seriesTitle` field (Sonarr's parsed series name)
      const strict = normSeriesName
        ? allReleases.filter((r) => {
            const relSeries = normaliseTitle(String(r?.seriesTitle ?? ""));
            if (!relSeries || relSeries !== normSeriesName) return false;
            if (seasonNumber != null && typeof r?.seasonNumber === "number" && r.seasonNumber !== Number(seasonNumber)) return false;
            return true;
          })
        : [];

      if (strict.length > 0) {
        filtered = strict;
        filterMethod = "series-title-match";
      } else if (seriesName) {
        // Pass 2: match on the full release title (handles non-standard naming)
        filtered = allReleases.filter((r) => {
          if (titleMatchScore(String(r?.title ?? ""), seriesName) < 40) return false;
          if (seasonNumber != null && typeof r?.seasonNumber === "number" && r.seasonNumber !== Number(seasonNumber)) return false;
          return true;
        });
        filterMethod = filtered.length > 0 ? "title-fallback" : "no-matches";
      } else {
        filtered = [];
        filterMethod = "no-matches";
      }
    } else if (app === "radarr" && movieId) {
      const strict = allReleases.filter((r) => {
        const mapped = r?.mappedMovieId;
        return typeof mapped === "number" && mapped === Number(movieId);
      });

      if (strict.length > 0) {
        filtered = strict;
        filterMethod = "strict-id-match";
      } else {
        const title = targetTitle || await fetchMovieTitle(movieId);
        if (title) {
          filtered = allReleases.filter((r) => {
            const mapped = r?.mappedMovieId;
            if (typeof mapped === "number" && mapped > 0 && mapped !== Number(movieId)) return false;
            return titleMatchScore(String(r?.title ?? ""), title) >= 40;
          });
        } else {
          filtered = [];
        }
        filterMethod = filtered.length > 0 ? "title-fallback" : "no-matches";
      }
    } else {
      filtered = allReleases;
      filterMethod = "unfiltered";
    }

    const releases = filtered
      .map((r) => {
        const sizeBytes = Number(r.size ?? 0);
        const oversized = sizeBytes > maxSizeBytes && sizeBytes > 0;
        const scored = scoreRelease(
          {
            title: String(r.title ?? ""),
            qualityName: String(r?.quality?.quality?.name ?? r?.quality?.name ?? ""),
            size: sizeBytes,
            ageHours: Number(r.ageHours ?? 0),
            seeders: typeof r.seeders === "number" ? r.seeders : null,
          },
          tier,
          category,
          { preferMp4 },
        );
        const matchScore = targetTitle ? titleMatchScore(String(r.title ?? ""), targetTitle) : null;
        const containerFormat = parseContainerFormat(String(r.title ?? ""));
        return {
          guid: r.guid ?? null,
          title: r.title ?? "Unknown release",
          quality: r.quality?.quality?.name ?? r.quality?.name ?? null,
          size: sizeBytes,
          ageHours: r.ageHours ?? null,
          indexer: r.indexer ?? null,
          rejected: r.rejected ?? false,
          downloadAllowed: r.downloadAllowed !== false,
          rejections: Array.isArray(r.rejections) ? (r.rejections as string[]).slice(0, 3) : [],
          customFormatScore: r.customFormatScore ?? null,
          downloadUrl: r.downloadUrl ?? null,
          protocol: r.protocol ?? null,
          seeders: typeof r.seeders === "number" ? r.seeders : null,
          leechers: typeof r.leechers === "number" ? r.leechers : null,
          containerFormat,
          score: scored.total,
          scoreBreakdown: scored.breakdown,
          matchScore,
          sizeRisk: oversized ? "oversized" : "ok",
          whyRecommended: oversized
            ? `Large file for ${tier} tier`
            : `Best match for ${tier} tier`,
          raw: r,
        };
      })
      .sort((a, b) => {
        // Rejected releases get a scoring penalty but stay interleaved
        const aScore = a.score - (a.rejected ? 15 : 0);
        const bScore = b.score - (b.rejected ? 15 : 0);
        return bScore - aScore;
      });

    return c.json({
      app,
      qualityTier: tier,
      maxSizeGb,
      releases,
      recommendation: releases[0] ?? null,
      fallbackLevel: releases.length > 0 ? "preferred-or-best-available" : "none",
      filterInfo: {
        totalFromIndexer: allReleases.length,
        afterFilter: releases.length,
        filterMethod,
      },
    });
  } catch (err: unknown) {
    return c.json({ error: errMsg(err), releases: [] }, 500);
  }
});

interface GrabRequestBody {
  app?: "sonarr" | "radarr";
  release?: ArrRelease;
  movieId?: number;
  seriesId?: number;
}

media.post("/releases/grab", async (c) => {
  const body = await c.req.json().catch((err) => { log.debug("grab body parse failed", err); return {}; }) as GrabRequestBody;
  const app = body?.app;
  const release = body?.release;
  const movieId = body?.movieId;
  const seriesId = body?.seriesId;
  if (!app || !["sonarr", "radarr"].includes(app)) {
    return c.json({ error: "app must be sonarr or radarr" }, 400);
  }
  if (!release) return c.json({ error: "release payload is required" }, 400);

  try {
    const baseUrl = getServiceUrl(app);
    const apiKey = getApiKey(app);

    // Force the correct media ID so Arr can identify the movie/series
    // even when the release title doesn't match Arr's parsing rules.
    const payload = { ...release };
    if (app === "radarr" && movieId) {
      payload.movieId = movieId;
      payload.mappedMovieId = movieId;
    }
    if (app === "sonarr" && seriesId) {
      payload.seriesId = seriesId;
      payload.mappedSeriesId = seriesId;
    }

    let result = await fetch(`${baseUrl}/api/v3/release`, {
      method: "POST",
      headers: apiKey ? { "X-Api-Key": apiKey, "Content-Type": "application/json" } : { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // Radarr v6+ expires release cache quickly — retry by re-triggering search first
    if (result.status === 404 && payload.guid) {
      const searchParams = new URLSearchParams();
      if (app === "radarr" && movieId) searchParams.set("movieId", String(movieId));
      if (app === "sonarr" && seriesId) searchParams.set("seriesId", String(seriesId));

      if (searchParams.toString()) {
        log.debug("Release cache miss — re-searching before retry grab");
        await fetch(`${baseUrl}/api/v3/release?${searchParams}`, {
          headers: apiKey ? { "X-Api-Key": apiKey } : {},
          signal: AbortSignal.timeout(30000),
        }).catch(() => {});

        // Retry the grab with fresh cache
        result = await fetch(`${baseUrl}/api/v3/release`, {
          method: "POST",
          headers: apiKey ? { "X-Api-Key": apiKey, "Content-Type": "application/json" } : { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
    }

    if (!result.ok) {
      const errBody = await result.text().catch(() => "");
      if (result.status === 404) {
        return c.json({ error: "Release not found — search again to refresh results" }, 404);
      }
      throw new Error(errBody || `${app} API ${result.status}`);
    }
    return c.json({ ok: true });
  } catch (err: unknown) {
    return c.json({ error: errMsg(err) }, 500);
  }
});

media.get("/queue-details", async (c) => {
  const app = c.req.query("app") as "sonarr" | "radarr" | undefined;
  if (!app || !["sonarr", "radarr"].includes(app)) {
    return c.json({ error: "app must be sonarr or radarr", records: [] }, 400);
  }

  const params = new URLSearchParams();
  if (app === "sonarr") {
    const seriesId = c.req.query("seriesId");
    if (seriesId) params.set("seriesId", seriesId);
    params.set("includeSeries", "true");
    params.set("includeEpisode", "true");
  } else {
    const movieId = c.req.query("movieId");
    if (movieId) params.set("movieId", movieId);
    params.set("includeMovie", "true");
  }

  try {
    const data = await serviceGet(app, `/queue/details?${params.toString()}`);
    const records = ((data ?? []) as ArrQueueItem[]).map((q) => ({
      id: q.id,
      title: q.title ?? q.movie?.title ?? q.series?.title ?? "Unknown",
      status: q.status ?? null,
      errorMessage: q.errorMessage ?? null,
      statusMessages: q.statusMessages ?? [],
      indexer: q.indexer ?? null,
      protocol: q.protocol ?? null,
      quality: q.quality?.quality?.name ?? q.quality?.name ?? null,
    }));
    return c.json({ app, records });
  } catch (err: unknown) {
    return c.json({ error: errMsg(err), app, records: [] }, 500);
  }
});

media.post("/queue/grab", async (c) => {
  const body = await c.req.json().catch((err) => { log.debug("queue grab body parse failed", err); return {}; }) as { app?: "sonarr" | "radarr"; id?: number };
  const app = body?.app;
  const id = Number(body?.id);
  if (!app || !["sonarr", "radarr"].includes(app)) return c.json({ error: "app must be sonarr or radarr" }, 400);
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: "valid queue id is required" }, 400);
  try {
    const baseUrl = getServiceUrl(app);
    const apiKey = getApiKey(app);
    const result = await fetch(`${baseUrl}/api/v3/queue/grab/${id}`, {
      method: "POST",
      headers: apiKey ? { "X-Api-Key": apiKey, "Content-Type": "application/json" } : { "Content-Type": "application/json" },
    });
    if (!result.ok) throw new Error(`${app} API ${result.status}`);
    return c.json({ ok: true, app, id });
  } catch (err: unknown) {
    return c.json({ error: errMsg(err) }, 500);
  }
});

media.delete("/queue/:id", async (c) => {
  const app = c.req.query("app") as "sonarr" | "radarr" | undefined;
  const id = Number(c.req.param("id"));
  const removeFromClient = c.req.query("removeFromClient") !== "false"; // default true
  const blocklist = c.req.query("blocklist") === "true"; // default false
  if (!app || !["sonarr", "radarr"].includes(app)) return c.json({ error: "app must be sonarr or radarr" }, 400);
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: "valid queue id is required" }, 400);
  try {
    const baseUrl = getServiceUrl(app);
    const apiKey = getApiKey(app);
    const params = new URLSearchParams();
    if (removeFromClient) params.set("removeFromClient", "true");
    if (blocklist) params.set("blocklist", "true");
    const result = await fetch(`${baseUrl}/api/v3/queue/${id}?${params.toString()}`, {
      method: "DELETE",
      headers: apiKey ? { "X-Api-Key": apiKey } : {},
    });
    if (!result.ok) throw new Error(`${app} API ${result.status}`);
    return c.json({ ok: true, app, id, removeFromClient, blocklist });
  } catch (err: unknown) {
    return c.json({ error: errMsg(err) }, 500);
  }
});

media.get("/cleanup/dry-run", async (c) => {
  const app = c.req.query("app") as "sonarr" | "radarr" | undefined;
  const maxItems = Math.min(200, Math.max(1, Number(c.req.query("maxItems") ?? 100)));
  if (!app || !["sonarr", "radarr"].includes(app)) {
    return c.json({ error: "app must be sonarr or radarr", candidates: [] }, 400);
  }
  try {
    if (app === "sonarr") {
      const wanted = await serviceGet("sonarr", `/wanted/missing?page=1&pageSize=${maxItems}&includeSeries=true`) as { records?: ArrWantedRecord[] };
      const candidates = (wanted?.records ?? []).map((r) => ({
        id: r.id,
        type: "episode",
        title: `${r.series?.title ?? "Unknown"} S${String(r.seasonNumber ?? 0).padStart(2, "0")}E${String(r.episodeNumber ?? 0).padStart(2, "0")}`,
        reason: "Missing episode and monitored",
      }));
      return c.json({ app, mode: "dry-run", candidates });
    }

    const wanted = await serviceGet("radarr", `/wanted/missing?page=1&pageSize=${maxItems}&monitored=true`) as { records?: ArrWantedRecord[] };
    const candidates = (wanted?.records ?? []).map((r) => ({
      id: r.id,
      type: "movie",
      title: r.title ?? "Unknown",
      reason: "Monitored movie still missing preferred file",
    }));
    return c.json({ app, mode: "dry-run", candidates });
  } catch (err: unknown) {
    return c.json({ error: errMsg(err), app, candidates: [] }, 500);
  }
});

// Single-title lookup via Radarr/Sonarr — returns full metadata for titles NOT in the
// local library (posters, overview, ratings, IDs) so the dashboard can show a peek sheet.
media.get("/lookup", async (c) => {
  const query = c.req.query("q") ?? "";
  const type = c.req.query("type") as "movie" | "tv" | undefined; // optional hint
  if (!query) return c.json({ results: [] });

  try {
    const searches: Promise<unknown>[] = [];
    if (!type || type === "movie") searches.push(serviceGet("radarr", `/movie/lookup?term=${encodeURIComponent(query)}`).catch((err) => { log.warn("radarr lookup failed", err); return []; }));
    if (!type || type === "tv")    searches.push(serviceGet("sonarr", `/series/lookup?term=${encodeURIComponent(query)}`).catch((err) => { log.warn("sonarr lookup failed", err); return []; }));

    const [radarrRaw, sonarrRaw] = await Promise.all(
      type === "movie" ? [searches[0], Promise.resolve([])] :
      type === "tv"    ? [Promise.resolve([]), searches[0]] :
                         searches
    );

    const movies = ((radarrRaw ?? []) as RadarrMovie[]).slice(0, 5).map((m) => ({
      tmdbId: m.tmdbId ?? null,
      title: m.title,
      year: m.year ?? null,
      type: "movie" as const,
      overview: m.overview ?? "",
      genres: m.genres ?? [],
      rating: m.ratings?.tmdb?.value ?? m.ratings?.value ?? null,
      poster: posterUrl("radarr", m.images ?? []) ?? null,
      studio: m.studio ?? null,
      runtime: m.runtime ?? null,
      inLibrary: false,
    }));

    const tv = ((sonarrRaw ?? []) as SonarrSeries[]).slice(0, 5).map((s) => ({
      tvdbId: s.tvdbId ?? null,
      title: s.title,
      year: s.year ?? null,
      type: "tv" as const,
      overview: s.overview ?? "",
      genres: s.genres ?? [],
      rating: s.ratings?.value ?? null,
      poster: posterUrl("sonarr", s.images ?? []) ?? null,
      network: s.network ?? null,
      seasonCount: extractSeasonCount(s),
      inLibrary: false,
    }));

    return c.json({ results: [...movies, ...tv] });
  } catch (err: unknown) {
    return c.json({ error: errMsg(err), results: [] }, 500);
  }
});

// Add a title to Radarr (movie) or Sonarr (tv) directly from the dashboard
interface AddMediaBody {
  type?: "movie" | "tv";
  title?: string;
  tmdbId?: number;
  tvdbId?: number;
  qualityProfileId?: number;
  qualityTier?: string;
  qualityIntent?: string;
}

media.post("/add", async (c) => {
  const body = await c.req.json().catch((err) => { log.debug("add media body parse failed", err); return {}; }) as AddMediaBody;
  const { type, title, tmdbId, tvdbId, qualityProfileId } = body;
  const tier = normalizeTier(body.qualityTier ?? body.qualityIntent);

  if (!type || !title) return c.json({ error: "type and title required" }, 400);

  try {
    if (type === "movie") {
      if (!tmdbId) return c.json({ error: "tmdbId required for movies" }, 400);
      const rootFolders = await serviceGet("radarr", "/rootfolder") as ArrRootFolder[];
      const qualityProfiles = await serviceGet("radarr", "/qualityprofile") as ArrQualityProfile[];
      const rootPath = rootFolders[0]?.path ?? "/movies";

      let profileResult;
      if (qualityProfileId) {
        const explicit = qualityProfiles.find((p) => p.id === qualityProfileId);
        profileResult = explicit
          ? { profileId: explicit.id, profileName: explicit.name ?? null, fallbackUsed: false, reason: "Explicit profile ID" }
          : matchProfile(qualityProfiles, tier);
      } else {
        profileResult = matchProfile(qualityProfiles, tier);
      }

      const result = await fetch(`${getServiceUrl("radarr")}/api/v3/movie`, {
        method: "POST",
        headers: { "X-Api-Key": getApiKey("radarr"), "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId, title, rootFolderPath: rootPath, qualityProfileId: profileResult.profileId, monitored: true, addOptions: { searchForMovie: true } }),
      });
      if (!result.ok) {
        const errBody = await result.json().catch(() => null);
        const detail = errBody?.[0]?.errorMessage ?? errBody?.message ?? "";
        throw new Error(detail ? `Radarr: ${detail}` : `Radarr ${result.status}`);
      }
      const added = await result.json().catch(() => null);
      return c.json({ ok: true, serviceId: added?.id ?? null, type: "movie", qualityTier: tier, appliedQualityProfileId: profileResult.profileId, appliedQualityProfileName: profileResult.profileName, matchReason: profileResult.reason });
    } else {
      if (!tvdbId) return c.json({ error: "tvdbId required for TV shows" }, 400);
      const rootFolders = await serviceGet("sonarr", "/rootfolder") as ArrRootFolder[];
      const qualityProfiles = await serviceGet("sonarr", "/qualityprofile") as ArrQualityProfile[];
      const rootPath = rootFolders[0]?.path ?? "/tv";

      let profileResult;
      if (qualityProfileId) {
        const explicit = qualityProfiles.find((p) => p.id === qualityProfileId);
        profileResult = explicit
          ? { profileId: explicit.id, profileName: explicit.name ?? null, fallbackUsed: false, reason: "Explicit profile ID" }
          : matchProfile(qualityProfiles, tier);
      } else {
        profileResult = matchProfile(qualityProfiles, tier);
      }

      const result = await fetch(`${getServiceUrl("sonarr")}/api/v3/series`, {
        method: "POST",
        headers: { "X-Api-Key": getApiKey("sonarr"), "Content-Type": "application/json" },
        body: JSON.stringify({ tvdbId, title, rootFolderPath: rootPath, qualityProfileId: profileResult.profileId, monitored: true, addOptions: { searchForMissingEpisodes: true } }),
      });
      if (!result.ok) {
        const errBody = await result.json().catch(() => null);
        const detail = errBody?.[0]?.errorMessage ?? errBody?.message ?? "";
        throw new Error(detail ? `Sonarr: ${detail}` : `Sonarr ${result.status}`);
      }
      const added = await result.json().catch(() => null);
      return c.json({ ok: true, serviceId: added?.id ?? null, type: "tv", qualityTier: tier, appliedQualityProfileId: profileResult.profileId, appliedQualityProfileName: profileResult.profileName, matchReason: profileResult.reason });
    }
  } catch (err: unknown) {
    return c.json({ error: errMsg(err) }, 500);
  }
});

media.get("/search", async (c) => {
  const query = c.req.query("q") ?? "";
  if (!query) return c.json({ tv: [], movies: [] });

  try {
    const [sonarrResults, radarrResults] = await Promise.allSettled([
      serviceGet("sonarr", `/series/lookup?term=${encodeURIComponent(query)}`),
      serviceGet("radarr", `/movie/lookup?term=${encodeURIComponent(query)}`),
    ]);

    const tv = sonarrResults.status === "fulfilled"
      ? (sonarrResults.value as SonarrSeries[]).slice(0, 10).map((s) => ({
          tvdbId: s.tvdbId,
          title: s.title,
          year: s.year,
          overview: s.overview,
          poster: posterUrl("sonarr", s.images ?? []),
          type: "tv" as const,
        }))
      : [];

    const movies = radarrResults.status === "fulfilled"
      ? (radarrResults.value as RadarrMovie[]).slice(0, 10).map((m) => ({
          tmdbId: m.tmdbId,
          title: m.title,
          year: m.year,
          overview: m.overview,
          poster: posterUrl("radarr", m.images ?? []),
          type: "movie" as const,
        }))
      : [];

    return c.json({ tv, movies });
  } catch (err: unknown) {
    console.error("[media/search]", errMsg(err));
    return c.json({ error: errMsg(err), tv: [], movies: [] }, 500);
  }
});

media.get("/requests", async (c) => {
  try {
    const baseUrl = getServiceUrl("overseerr");
    const apiKey = getApiKey("overseerr");
    if (!baseUrl || !apiKey) return c.json({ configured: false, results: [] });

    const res = await fetch(`${baseUrl}/api/v1/request?take=50&sort=added`, {
      headers: { "X-Api-Key": apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Overseerr API ${res.status}`);
    const data = await res.json() as OverseerrResponse;

    const results = (data.results ?? []).map((r) => {
      const posterPath: string | undefined = r.media?.posterPath;
      return {
        id: r.id,
        type: r.type === "movie" ? "movie" : "tv",
        status: r.status,
        title: r.media?.title ?? r.media?.name ?? "Unknown",
        overview: r.media?.overview ?? "",
        poster: posterPath ? `https://image.tmdb.org/t/p/w300${posterPath}` : undefined,
        tmdbId: r.media?.tmdbId,
        mediaType: r.media?.mediaType,
        requestedBy: r.requestedBy?.displayName ?? "Unknown",
        requestedByAvatar: r.requestedBy?.avatar,
        createdAt: r.createdAt,
      };
    });

    return c.json({ configured: true, results });
  } catch (err: unknown) {
    console.error("[media/requests]", errMsg(err));
    if (isNetworkError(err)) {
      return c.json({ configured: true, available: false, results: [] });
    }
    return c.json({ error: errMsg(err), results: [] }, 500);
  }
});

// Approve or decline an Overseerr request
media.post("/requests/:id/:action", async (c) => {
  const id = c.req.param("id");
  const action = c.req.param("action");
  if (action !== "approve" && action !== "decline") {
    return c.json({ error: "Invalid action" }, 400);
  }
  try {
    const baseUrl = getServiceUrl("overseerr");
    const apiKey = getApiKey("overseerr");
    if (!baseUrl || !apiKey) return c.json({ error: "Overseerr not configured" }, 400);

    const res = await fetch(`${baseUrl}/api/v1/request/${id}/${action}`, {
      method: "POST",
      headers: { "X-Api-Key": apiKey },
    });
    if (!res.ok) throw new Error(`Overseerr ${action} failed: ${res.status}`);
    return c.json({ ok: true });
  } catch (err: unknown) {
    return c.json({ error: errMsg(err) }, 500);
  }
});

// Health summary for Sonarr, Radarr, Prowlarr, Overseerr + qBittorrent
media.get("/arr-status", async (c) => {
  async function checkArr(name: string, apiVersion = "v3", endpoint = "system/status"): Promise<{
    name: string; ok: boolean; version?: string; url: string;
  }> {
    const url = getServiceUrl(name);
    const apiKey = getApiKey(name);
    try {
      const res = await fetch(`${url}/api/${apiVersion}/${endpoint}`, {
        headers: apiKey ? { "X-Api-Key": apiKey } : {},
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return { name, ok: false, url };
      const json = await res.json() as ArrStatusResponse;
      return { name, ok: true, version: json.version, url };
    } catch {
      return { name, ok: false, url };
    }
  }

  async function checkOverseerr(): Promise<{ name: string; ok: boolean; version?: string; pendingRequests?: number; url: string }> {
    const url = getServiceUrl("overseerr");
    const apiKey = getApiKey("overseerr");
    try {
      const [statusRes, requestsRes] = await Promise.allSettled([
        fetch(`${url}/api/v1/status`, {
          headers: apiKey ? { "X-Api-Key": apiKey } : {},
          signal: AbortSignal.timeout(4000),
        }),
        fetch(`${url}/api/v1/request?filter=pending&take=1`, {
          headers: apiKey ? { "X-Api-Key": apiKey } : {},
          signal: AbortSignal.timeout(4000),
        }),
      ]);
      if (statusRes.status !== "fulfilled" || !statusRes.value.ok) return { name: "overseerr", ok: false, url };
      const json = await statusRes.value.json() as ArrStatusResponse;
      let pendingRequests: number | undefined;
      if (requestsRes.status === "fulfilled" && requestsRes.value.ok) {
        const rJson = await requestsRes.value.json() as OverseerrResponse;
        pendingRequests = rJson.pageInfo?.results ?? undefined;
      }
      return { name: "overseerr", ok: true, version: json.version, pendingRequests, url };
    } catch {
      return { name: "overseerr", ok: false, url };
    }
  }

  const [sonarr, radarr, prowlarr, overseerr] = await Promise.allSettled([
    checkArr("sonarr", "v3"),
    checkArr("radarr", "v3"),
    checkArr("prowlarr", "v1", "health"),
    checkOverseerr(),
  ]);

  return c.json({
    sonarr:    sonarr.status === "fulfilled"    ? sonarr.value    : { name: "sonarr",    ok: false, url: "" },
    radarr:    radarr.status === "fulfilled"    ? radarr.value    : { name: "radarr",    ok: false, url: "" },
    prowlarr:  prowlarr.status === "fulfilled"  ? prowlarr.value  : { name: "prowlarr",  ok: false, url: "" },
    overseerr: overseerr.status === "fulfilled" ? overseerr.value : { name: "overseerr", ok: false, url: "" },
  });
});

// Webhook receiver for Radarr / Sonarr "On Download / On Upgrade" events.
// Point the Radarr/Sonarr notification webhook at: POST /api/media/webhook
media.post("/webhook", async (c) => {
  try {
    const body = await c.req.json().catch((err) => { log.debug("webhook body parse failed", err); return {}; }) as ArrWebhookPayload;
    const eventType = body.eventType ?? "";

    if (eventType === "Download" || eventType === "MovieAdded") {
      // Radarr payload
      const title = body.movie?.title ?? body.remoteMovie?.title ?? "Unknown movie";
      const quality = body.movieFile?.quality?.quality?.name ?? body.quality?.quality?.name ?? "";
      const isUpgrade = body.isUpgrade === true;
      writeNotification(
        "info",
        isUpgrade ? `${title} upgraded` : `${title} downloaded`,
        quality ? `Quality: ${quality}` : "",
        `radarr:${body.movie?.id ?? title}`,
      );
    } else if (eventType === "EpisodeFileDelete") {
      // ignore deletions
    } else if (eventType === "Grab") {
      // Sonarr/Radarr grab — download started, skip (not yet complete)
    } else if (body.episodes && (eventType === "Download" || eventType === "EpisodeFileImport")) {
      // Sonarr episode download
      const series = body.series?.title ?? "Unknown series";
      const eps = body.episodes ?? [];
      const epLabel = eps.length === 1
        ? `S${String(eps[0].seasonNumber).padStart(2, "0")}E${String(eps[0].episodeNumber).padStart(2, "0")} – ${eps[0].title ?? ""}`
        : `${eps.length} episodes`;
      writeNotification(
        "info",
        `${series} downloaded`,
        epLabel,
        `sonarr:${body.series?.id ?? series}`,
      );
    }

    return c.json({ ok: true });
  } catch (err: unknown) {
    return c.json({ error: errMsg(err) }, 500);
  }
});

// ── Plex endpoints ──────────────────────────────────────────────────────────

media.get("/plex/watching", async (c) => {
  const plex = getPlexConfig();
  if (!plex) return c.json({ configured: false });

  try {
    const [onDeckRes, historyRes] = await Promise.allSettled([
      plexFetch("/library/onDeck", plex.token, plex.baseUrl),
      plexFetch("/status/sessions/history/all?sort=viewedAt:desc&limit=30", plex.token, plex.baseUrl),
    ]);

    interface PlexWatchItem {
      ratingKey?: string;
      title?: string;
      episodeTitle?: string;
      type: "movie" | "tv";
      year?: number;
      thumb?: string;
      viewOffset?: number;
      duration?: number;
      lastViewedAt?: string;
      viewedAt?: string;
      grandparentTitle?: string;
      parentIndex?: number;
      index?: number;
    }

    const continueWatching: PlexWatchItem[] = [];
    if (onDeckRes.status === "fulfilled" && onDeckRes.value.ok) {
      const json = await onDeckRes.value.json() as PlexMediaContainer;
      for (const item of json.MediaContainer?.Metadata ?? []) {
        continueWatching.push({
          ratingKey: item.ratingKey,
          title: item.grandparentTitle ?? item.title,
          episodeTitle: item.grandparentTitle ? item.title : undefined,
          type: item.type === "movie" ? "movie" : "tv",
          year: item.year ?? item.parentYear,
          thumb: item.grandparentThumb ?? item.thumb,
          viewOffset: item.viewOffset,
          duration: item.duration,
          lastViewedAt: item.lastViewedAt ? new Date(item.lastViewedAt * 1000).toISOString() : undefined,
          grandparentTitle: item.grandparentTitle,
          parentIndex: item.parentIndex,
          index: item.index,
        });
      }
    }

    const recentlyWatched: PlexWatchItem[] = [];
    if (historyRes.status === "fulfilled" && historyRes.value.ok) {
      const json = await historyRes.value.json() as PlexMediaContainer;
      for (const item of json.MediaContainer?.Metadata ?? []) {
        recentlyWatched.push({
          ratingKey: item.ratingKey,
          title: item.grandparentTitle ?? item.title,
          episodeTitle: item.grandparentTitle ? item.title : undefined,
          type: item.type === "movie" ? "movie" : "tv",
          year: item.year ?? item.parentYear,
          thumb: item.grandparentThumb ?? item.thumb,
          viewedAt: item.viewedAt ? new Date(item.viewedAt * 1000).toISOString() : undefined,
          grandparentTitle: item.grandparentTitle,
          parentIndex: item.parentIndex,
          index: item.index,
        });
      }
    }

    return c.json({ configured: true, continueWatching, recentlyWatched });
  } catch (err: unknown) {
    console.error("[media/plex/watching]", errMsg(err));
    if (isNetworkError(err)) {
      return c.json({ configured: true, available: false, continueWatching: [], recentlyWatched: [] });
    }
    return c.json({ error: errMsg(err), configured: true, continueWatching: [], recentlyWatched: [] }, 500);
  }
});

media.get("/plex/watch-status", async (c) => {
  const plex = getPlexConfig();
  if (!plex) return c.json({ configured: false, watchStatus: {} });

  try {
    // Get all library sections
    const sectionsRes = await plexFetch("/library/sections", plex.token, plex.baseUrl);
    if (!sectionsRes.ok) throw new Error(`Plex sections: ${sectionsRes.status}`);
    const sectionsJson = await sectionsRes.json() as PlexMediaContainer;
    const sections = (sectionsJson.MediaContainer?.Directory ?? [])
      .filter((s) => s.type === "movie" || s.type === "show");

    const watchStatus: Record<string, "watched" | "in-progress"> = {};

    // Fetch watched/in-progress items from each section
    await Promise.all(sections.map(async (section) => {
      try {
        // Get recently viewed items (watched + in-progress) with GUIDs for matching
        const res = await plexFetch(
          `/library/sections/${section.key}/all?viewCount>=1&includeGuids=1&type=${section.type === "movie" ? 1 : 2}`,
          plex.token, plex.baseUrl
        );
        if (!res.ok) return;
        const json = await res.json() as PlexMediaContainer;
        for (const item of json.MediaContainer?.Metadata ?? []) {
          // Extract TMDB/IMDB IDs from Guid array
          const guids = item.Guid ?? [];
          for (const g of guids) {
            const id = String(g.id ?? "");
            if (id.startsWith("tmdb://")) {
              const tmdbId = id.replace("tmdb://", "");
              watchStatus[`tmdb:${tmdbId}`] = item.viewOffset ? "in-progress" : "watched";
            } else if (id.startsWith("imdb://")) {
              const imdbId = id.replace("imdb://", "");
              watchStatus[`imdb:${imdbId}`] = item.viewOffset ? "in-progress" : "watched";
            }
          }
        }
      } catch { /* skip failed section */ }
    }));

    return c.json({ configured: true, watchStatus });
  } catch (err: unknown) {
    console.error("[media/plex/watch-status]", errMsg(err));
    if (isNetworkError(err)) {
      return c.json({ configured: true, available: false, watchStatus: {} });
    }
    return c.json({ error: errMsg(err), configured: true, watchStatus: {} }, 500);
  }
});

media.post("/plex/scrobble", async (c) => {
  const plex = getPlexConfig();
  if (!plex) return c.json({ error: "Plex not configured" }, 400);

  try {
    const { ratingKey, action } = await c.req.json<{ ratingKey: string; action: "watched" | "unwatched" }>();
    const endpoint = action === "watched" ? "/:/scrobble" : "/:/unscrobble";
    const res = await plexFetch(
      `${endpoint}?identifier=com.plexapp.plugins.library&key=${encodeURIComponent(ratingKey)}`,
      plex.token, plex.baseUrl
    );
    if (!res.ok) throw new Error(`Plex scrobble failed: ${res.status}`);
    return c.json({ ok: true });
  } catch (err: unknown) {
    return c.json({ error: errMsg(err) }, 500);
  }
});

// ── Plex Watchlist ───────────────────────────────────────────────────────────

media.get("/plex/watchlist", async (c) => {
  const plex = getPlexConfig();
  if (!plex) return c.json({ configured: false, items: [] });

  try {
    const res = await fetch(
      `https://discover.provider.plex.tv/library/sections/watchlist/all?includeGuids=1&X-Plex-Token=${plex.token}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) return c.json({ configured: true, items: [] });

    const json = (await res.json()) as PlexMediaContainer;
    const rawItems: {
      ratingKey: string;
      title: string;
      type: "movie" | "tv";
      year?: number;
      guid?: string;
      tmdbId?: number;
    }[] = [];

    for (const item of json.MediaContainer?.Metadata ?? []) {
      let tmdbId: number | undefined;
      for (const g of item.Guid ?? []) {
        const match = String(g.id ?? "").match(/tmdb:\/\/(\d+)/);
        if (match) { tmdbId = Number(match[1]); break; }
      }

      rawItems.push({
        ratingKey: item.ratingKey ?? "",
        title: item.title ?? "",
        type: item.type === "movie" ? "movie" : "tv",
        year: item.year,
        guid: item.guid,
        tmdbId,
      });
    }

    // Enrich with poster URLs from Radarr/Sonarr lookups (parallel, best-effort)
    const items = await Promise.all(
      rawItems.map(async (item) => {
        let poster: string | undefined;
        if (item.tmdbId) {
          try {
            const service = item.type === "movie" ? "radarr" : "sonarr";
            const lookupPath = item.type === "movie"
              ? `/movie/lookup/tmdb?tmdbId=${item.tmdbId}`
              : `/series/lookup?term=tmdb:${item.tmdbId}`;
            const lookup = await serviceGet(service, lookupPath);
            const match = Array.isArray(lookup) ? lookup[0] : lookup;
            if (match) poster = posterUrl(service, match.images ?? []);
          } catch { /* best effort */ }
        }
        return { ...item, poster };
      }),
    );

    return c.json({ configured: true, items });
  } catch (err: unknown) {
    return c.json({ configured: true, items: [], error: errMsg(err) });
  }
});

// ── Add media to library from TMDB ID ────────────────────────────────────────

media.post("/add", async (c) => {
  try {
    const { type, tmdbId, title } = await c.req.json<{
      type: "movie" | "tv";
      tmdbId: number;
      title: string;
    }>();

    if (!tmdbId) return c.json({ error: "tmdbId is required" }, 400);

    if (type === "movie") {
      const rootFolders = await serviceGet("radarr", "/rootfolder") as ArrRootFolder[];
      const rootPath = rootFolders[0]?.path ?? "/movies";
      const profiles = await serviceGet("radarr", "/qualityprofile") as ArrQualityProfile[];
      const profileResult = matchProfile(profiles, "standard");

      await servicePost("radarr", "/movie", {
        tmdbId,
        title,
        rootFolderPath: rootPath,
        qualityProfileId: profileResult.profileId,
        monitored: true,
        addOptions: { searchForMovie: true },
      });

      return c.json({ ok: true, message: `Added "${title}" to Radarr` });
    } else {
      // For TV, we need tvdbId — look it up from TMDB
      const lookupRes = await serviceGet("sonarr", `/series/lookup?term=tmdb:${tmdbId}`);
      const match = Array.isArray(lookupRes) ? (lookupRes as SonarrSeries[])[0] : null;
      if (!match?.tvdbId) return c.json({ error: "Could not find show in Sonarr lookup" }, 404);

      const rootFolders = await serviceGet("sonarr", "/rootfolder") as ArrRootFolder[];
      const rootPath = rootFolders[0]?.path ?? "/tv";
      const profiles = await serviceGet("sonarr", "/qualityprofile") as ArrQualityProfile[];
      const profileResult = matchProfile(profiles, "standard");

      await servicePost("sonarr", "/series", {
        tvdbId: match.tvdbId,
        title: match.title ?? title,
        rootFolderPath: rootPath,
        qualityProfileId: profileResult.profileId,
        monitored: true,
        addOptions: { searchForMissingEpisodes: true },
      });

      return c.json({ ok: true, message: `Added "${title}" to Sonarr` });
    }
  } catch (err: unknown) {
    return c.json({ error: errMsg(err) }, 500);
  }
});

// ── Delete media files via arr APIs ────────────────────────────────────────

media.delete("/episode-file/:episodeId", async (c) => {
  const episodeId = c.req.param("episodeId");
  try {
    // First get the episode to find its episodeFileId
    const episode = await serviceGet("sonarr", `/episode/${episodeId}`) as SonarrEpisode;
    const fileId = episode?.episodeFileId;
    if (!fileId) return c.json({ error: "No file for this episode" }, 404);

    // Delete the episode file via Sonarr API
    const apiKey = getApiKey("sonarr");
    const baseUrl = getServiceUrl("sonarr");
    const res = await fetch(`${baseUrl}/api/v3/episodefile/${fileId}?apikey=${apiKey}`, {
      method: "DELETE",
    });
    if (!res.ok) return c.json({ error: `Sonarr API error: ${res.status}` }, 502);
    return c.json({ ok: true });
  } catch (err: unknown) {
    return c.json({ error: errMsg(err) }, 500);
  }
});

media.delete("/movie-file/:movieId", async (c) => {
  const movieId = c.req.param("movieId");
  try {
    // Get movie to find its movieFileId
    const movie = await serviceGet("radarr", `/movie/${movieId}`) as RadarrMovie;
    const fileId = movie?.movieFile?.id;
    if (!fileId) return c.json({ error: "No file for this movie" }, 404);

    // Delete the movie file via Radarr API
    const apiKey = getApiKey("radarr");
    const baseUrl = getServiceUrl("radarr");
    const res = await fetch(`${baseUrl}/api/v3/moviefile/${fileId}?apikey=${apiKey}`, {
      method: "DELETE",
    });
    if (!res.ok) return c.json({ error: `Radarr API error: ${res.status}` }, 502);
    return c.json({ ok: true });
  } catch (err: unknown) {
    return c.json({ error: errMsg(err) }, 500);
  }
});

// ── Remove media from library (deletes the Sonarr/Radarr entry) ───────────

media.delete("/movie/:movieId", async (c) => {
  const movieId = c.req.param("movieId");
  const deleteFiles = c.req.query("deleteFiles") === "true";
  const addImportExclusion = c.req.query("addImportExclusion") === "true";
  try {
    const qs = `?deleteFiles=${deleteFiles}&addImportExclusion=${addImportExclusion}`;
    const res = await serviceDelete("radarr", `/movie/${movieId}${qs}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return c.json({ error: `Radarr API error ${res.status}: ${text}` }, 502);
    }
    return c.json({ ok: true });
  } catch (err: unknown) {
    return c.json({ error: errMsg(err) }, 500);
  }
});

media.delete("/series/:seriesId", async (c) => {
  const seriesId = c.req.param("seriesId");
  const deleteFiles = c.req.query("deleteFiles") === "true";
  const addImportExclusion = c.req.query("addImportExclusion") === "true";
  try {
    const qs = `?deleteFiles=${deleteFiles}&addImportExclusion=${addImportExclusion}`;
    const res = await serviceDelete("sonarr", `/series/${seriesId}${qs}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return c.json({ error: `Sonarr API error ${res.status}: ${text}` }, 502);
    }
    return c.json({ ok: true });
  } catch (err: unknown) {
    return c.json({ error: errMsg(err) }, 500);
  }
});

// ── Media path authorization (Sonarr/Radarr root folders) ─────────────────

let cachedMediaRoots: string[] | null = null;
let mediaRootsCacheTime = 0;
const MEDIA_ROOTS_TTL = 60_000;

async function getMediaRoots(): Promise<string[]> {
  const now = Date.now();
  if (cachedMediaRoots && now - mediaRootsCacheTime < MEDIA_ROOTS_TTL) return cachedMediaRoots;
  const containerRoots: string[] = [];
  try {
    const sr = await serviceGet("sonarr", "/rootfolder") as ArrRootFolder[];
    for (const r of sr) if (r.path) containerRoots.push(r.path.replace(/\/$/, ""));
  } catch { /* sonarr not configured */ }
  try {
    const rr = await serviceGet("radarr", "/rootfolder") as ArrRootFolder[];
    for (const r of rr) if (r.path) containerRoots.push(r.path.replace(/\/$/, ""));
  } catch { /* radarr not configured */ }

  // Map container root paths → host paths
  const mounts = await getArrMounts();
  const roots: string[] = [];
  for (const cr of containerRoots) {
    const hostRoot = containerToHostPath(cr, mounts);
    if (hostRoot) roots.push(hostRoot);
    roots.push(cr); // also keep container path in case of non-Docker setup
  }

  cachedMediaRoots = roots;
  mediaRootsCacheTime = now;
  return roots;
}

function isUnderMediaRoot(absPath: string, roots: string[]): boolean {
  const resolved = resolve(absPath);
  return roots.some((root) => resolved === root || resolved.startsWith(root + "/"));
}

/** Validate a media path against Sonarr/Radarr root folders. */
async function authorizeMediaPath(absPath: string): Promise<boolean> {
  const roots = await getMediaRoots();
  return isUnderMediaRoot(absPath, roots);
}

// ── Media streaming endpoints ─────────────────────────────────────────────

media.get("/stream", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path required" }, 400);

  const hostPath = await resolveMediaFilePath(filePath);
  if (!hostPath) return c.json({ error: "File not found" }, 404);
  if (!(await authorizeMediaPath(hostPath))) return c.json({ error: "Access denied" }, 403);

  // Prefer optimized MP4 if a completed conversion exists for this file
  const optimizedPath = findOptimizedPath(hostPath);
  const streamPath = optimizedPath ?? hostPath;

  try {
    return await buildStreamResponse(streamPath, c.req.header("range"));
  } catch (err: unknown) {
    return c.json({ error: errMsg(err) }, 500);
  }
});

media.get("/probe", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path required" }, 400);

  const hostPath = await resolveMediaFilePath(filePath);
  if (!hostPath) return c.json({ error: "File not found" }, 404);
  if (!(await authorizeMediaPath(hostPath))) return c.json({ error: "Access denied" }, 403);
  if (!hasFfmpeg()) return c.json({ error: "ffmpeg not available" }, 500);

  // If an optimized MP4 exists (stream endpoint will serve it), probe that instead
  const optimizedPath = findOptimizedPath(hostPath);
  const probePath = optimizedPath ?? hostPath;
  const result = probeFile(probePath);

  return c.json({ ...result, optimized: !!optimizedPath });
});

media.get("/hls-start", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path required" }, 400);

  const hostPath = await resolveMediaFilePath(filePath);
  if (!hostPath) return c.json({ error: "File not found" }, 404);
  if (!(await authorizeMediaPath(hostPath))) return c.json({ error: "Access denied" }, 403);
  if (!hasFfmpeg()) return c.json({ error: "ffmpeg not available" }, 500);

  const audioTrack = parseInt(c.req.query("audioTrack") ?? "0", 10);
  const seekTo = parseFloat(c.req.query("seekTo") ?? "0");
  const transcodeVideo = c.req.query("transcodeVideo") === "1";
  const probe = probeFile(hostPath);
  const hash = startHls(hostPath, audioTrack, seekTo, probe.videoCodec, transcodeVideo, probe.videoColorTransfer ?? "", probe.videoColorPrimaries ?? "", probe.videoColorSpace ?? "");
  return c.json({ hash, ...probe });
});

media.get("/hls/:hash/:file", async (c) => {
  const hash = c.req.param("hash");
  const file = c.req.param("file");

  if (!/^[a-f0-9]+$/.test(hash) || /[/\\]/.test(file)) {
    return c.json({ error: "Invalid path" }, 400);
  }

  const outDir = hlsOutDirByHash(hash);
  if (!outDir) return c.json({ error: "Not found" }, 404);

  // Record activity — keeps idle reaper from cleaning this job
  touchJob(hash);

  const fp = join(outDir, file);

  // For playlist.m3u8, wait briefly for ffmpeg to create it (race with hls-start)
  if (file === "playlist.m3u8") {
    for (let i = 0; i < 30; i++) {
      try { await stat(fp); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
  }

  try {
    const s = await stat(fp);
    const { createReadStream } = await import("node:fs");
    const { Readable } = await import("node:stream");
    const stream = createReadStream(fp);

    let contentType = "application/octet-stream";
    if (file.endsWith(".m3u8")) contentType = "application/vnd.apple.mpegurl";
    else if (file.endsWith(".m4s")) contentType = "video/mp4";
    else if (file.endsWith(".mp4")) contentType = "video/mp4";
    else if (file.endsWith(".ts")) contentType = "video/mp2t";

    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(s.size),
        "Cache-Control": file.endsWith(".m3u8") ? "no-store" : "max-age=3600",
        "Access-Control-Allow-Origin": c.req.header("origin") ?? "*",
        "Access-Control-Allow-Credentials": "true",
      },
    });
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
});

/** POST /hls-stop — kill ffmpeg and clean up HLS files. */
media.post("/hls-stop", async (c) => {
  const body = await c.req.json<{ hash: string }>().catch(() => ({ hash: "" }));
  if (!body.hash) return c.json({ error: "hash required" }, 400);
  await stopHls(body.hash);
  return c.json({ ok: true });
});

/** POST /hls-ping — keep-alive from client, resets idle timer. */
media.post("/hls-ping", async (c) => {
  const body = await c.req.json<{ hash: string }>().catch(() => ({ hash: "" }));
  if (!body.hash) return c.json({ error: "hash required" }, 400);
  touchJob(body.hash);
  return c.json({ ok: true });
});

// ── Transmux endpoints (Chrome MKV direct play) ──────────────────────────

/** GET /transmux-start — kick off MKV→MP4 transmux with container path resolution. */
media.get("/transmux-start", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path required" }, 400);

  const hostPath = await resolveMediaFilePath(filePath);
  if (!hostPath) return c.json({ error: "File not found" }, 404);
  if (!(await authorizeMediaPath(hostPath))) return c.json({ error: "Access denied" }, 403);
  if (!hasFfmpeg()) return c.json({ error: "ffmpeg not available" }, 500);

  const probe = probeFile(hostPath);
  const hash = startTransmux(hostPath, probe.videoCodec);
  return c.json({ hash, ...probe });
});

/** GET /transmux-status/:hash — check if transmux is ready. */
media.get("/transmux-status/:hash", (c) => {
  const hash = c.req.param("hash");
  if (!/^[a-f0-9]+$/.test(hash)) return c.json({ error: "Invalid hash" }, 400);

  const job = transmuxJobs.get(hash);
  if (job) return c.json({ ready: job.done && !job.error, error: job.error });

  const outPath = join(TRANSMUX_ROOT, `${hash}.mp4`);
  if (existsSync(outPath)) return c.json({ ready: true, error: false });

  return c.json({ error: "Not found" }, 404);
});

/** GET /transmux/:hash/stream — serve transmuxed MP4 with Range support. */
media.get("/transmux/:hash/stream", async (c) => {
  const hash = c.req.param("hash");
  if (!/^[a-f0-9]+$/.test(hash)) return c.json({ error: "Invalid hash" }, 400);

  const outPath = join(TRANSMUX_ROOT, `${hash}.mp4`);
  if (!existsSync(outPath)) return c.json({ error: "Not found" }, 404);

  return buildStreamResponse(outPath, c.req.header("range"));
});

/** POST /transmux-stop — cancel a running transmux job. */
media.post("/transmux-stop", async (c) => {
  const body = await c.req.json<{ hash: string }>().catch(() => ({ hash: "" }));
  if (!body.hash) return c.json({ error: "hash required" }, 400);
  stopTransmux(body.hash);
  return c.json({ ok: true });
});

media.get("/subtitle", async (c) => {
  const filePath = c.req.query("path");
  const indexStr = c.req.query("index");
  if (!filePath) return c.json({ error: "path required" }, 400);

  const hostPath = await resolveMediaFilePath(filePath);
  if (!hostPath) return c.json({ error: "File not found" }, 404);
  if (!(await authorizeMediaPath(hostPath))) return c.json({ error: "Access denied" }, 403);
  if (!hasFfmpeg()) return c.json({ error: "ffmpeg not available" }, 500);

  const subIndex = parseInt(indexStr ?? "0", 10);

  return new Promise<Response>((res) => {
    const proc = spawn("ffmpeg", [
      "-i", hostPath, "-map", `0:s:${subIndex}`, "-f", "webvtt", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", () => { /* drain */ });

    proc.on("close", (code) => {
      if (code !== 0 || chunks.length === 0) {
        res(Response.json({ error: "Failed to extract subtitle" }, { status: 500 }));
        return;
      }
      res(new Response(Buffer.concat(chunks), {
        status: 200,
        headers: {
          "Content-Type": "text/vtt; charset=utf-8",
          "Access-Control-Allow-Origin": c.req.header("origin") ?? "*",
          "Access-Control-Allow-Credentials": "true",
          "Cache-Control": "max-age=3600",
        },
      }));
    });

    proc.on("error", () => {
      res(Response.json({ error: "ffmpeg not available" }, { status: 500 }));
    });
  });
});

// ── Jellyfin playback ─────────────────────────────────────────────────────────

/** Browser DeviceProfile — tells Jellyfin what the client can play natively.
 *  HEVC is NOT in DirectPlay — browsers can't reliably decode HEVC via direct
 *  <video src> outside of HLS. Jellyfin will HLS-transcode HEVC content instead,
 *  which also enables proper HDR tonemapping. */
const BROWSER_DEVICE_PROFILE = {
  DirectPlayProfiles: [
    { Type: "Video", Container: "mp4,m4v", VideoCodec: "h264", AudioCodec: "aac,mp3,opus,flac,vorbis" },
    { Type: "Video", Container: "webm", VideoCodec: "vp8,vp9", AudioCodec: "opus,vorbis" },
  ],
  TranscodingProfiles: [
    { Type: "Video", Container: "ts", VideoCodec: "h264", AudioCodec: "aac",
      Protocol: "hls", Context: "Streaming", MaxAudioChannels: "6" },
  ],
  SubtitleProfiles: [
    { Format: "vtt", Method: "External" },
    { Format: "srt", Method: "External" },
    { Format: "ass", Method: "External" },
    { Format: "ssa", Method: "External" },
    { Format: "pgssub", Method: "Encode" },
    { Format: "dvdsub", Method: "Encode" },
    { Format: "dvbsub", Method: "Encode" },
  ],
};

/** Replace localhost in Jellyfin URL with the requester's hostname for LAN access. */
function jellyfinFrontendUrl(jellyfinUrl: string, requestHost: string): string {
  try {
    const jf = new URL(jellyfinUrl);
    if (jf.hostname === "localhost" || jf.hostname === "127.0.0.1") {
      jf.hostname = requestHost.split(":")[0];
    }
    return jf.origin;
  } catch { return jellyfinUrl; }
}

/**
 * POST /jellyfin-playback  { path: string }
 *
 * Uses Jellyfin's PlaybackInfo API with a browser DeviceProfile to determine
 * the correct playback method. Returns DirectPlay URL or HLS Transcode URL,
 * plus audio/subtitle track info. Frontend talks to Jellyfin directly (CORS *).
 */
media.post("/jellyfin-playback", async (c) => {
  const body = await c.req.json<{ path?: string }>().catch(() => ({ path: undefined }));
  const filePath = body.path;
  if (!filePath) return c.json({ error: "path required" }, 400);

  const jellyfinUrl = getSetting("jellyfin_url");
  const jellyfinKey = getSetting("jellyfin_api_key");
  if (!jellyfinUrl || !jellyfinKey) {
    return c.json({ available: false, reason: "jellyfin not configured" });
  }

  // Resolve arr container path → host path → extract basename for Jellyfin matching
  const hostPath = await resolveMediaFilePath(filePath);
  if (!hostPath) return c.json({ available: false, reason: "path not resolved" });

  const { basename, dirname } = await import("node:path");
  const fileName = basename(hostPath);

  // Extract search term from folder structure
  let folderName = basename(dirname(hostPath));
  if (/^season\s+\d+$/i.test(folderName)) {
    folderName = basename(dirname(dirname(hostPath)));
  }
  const searchTerm = folderName.replace(/\s*\(\d{4}\)\s*$/, "").trim();

  type JellyfinItem = {
    Id: string;
    Name: string;
    Type?: string;
    Path?: string;
    MediaSources?: Array<{ Id: string; Path?: string }>;
    UserData?: { PlaybackPositionTicks?: number; Played?: boolean };
    Chapters?: Array<{ StartPositionTicks: number; Name: string }>;
  };

  const jfHeaders = { "X-Emby-Token": jellyfinKey };

  const matchByFilename = (item: JellyfinItem) => {
    if (item.Path && basename(item.Path) === fileName) return true;
    return item.MediaSources?.some((s) => s.Path && basename(s.Path) === fileName);
  };

  try {
    // 1. Search Jellyfin — try movies + episodes first
    const searchUrl = new URL(`${jellyfinUrl}/Items`);
    searchUrl.searchParams.set("Recursive", "true");
    searchUrl.searchParams.set("IncludeItemTypes", "Movie,Episode");
    searchUrl.searchParams.set("Fields", "Path,MediaSources,UserData,Chapters");
    searchUrl.searchParams.set("SearchTerm", searchTerm);
    searchUrl.searchParams.set("Limit", "20");

    const searchRes = await fetch(searchUrl.toString(), { headers: jfHeaders });
    if (!searchRes.ok) return c.json({ available: false, reason: "jellyfin search failed" });

    const searchData = await searchRes.json() as { Items?: JellyfinItem[] };
    let match = searchData.Items?.find(matchByFilename);

    // 2a. Folder search missed — retry with progressively shorter terms from the filename.
    // Jellyfin search chokes on long queries (>5 words), so we truncate progressively.
    // Keeps stop words intact (Jellyfin needs original word sequence).
    if (!match) {
      const fileTitle = fileName
        .replace(/\.[^.]+$/, "")                          // strip extension
        .replace(/\s*(Bluray|WEB[-]?DL|WEBRip|HDTV|Remux|WEBDL)[-.]?\d*p?.*$/i, "") // strip quality tags
        .replace(/\s*\(\d{4}\)\s*$/, "")                   // strip year
        .replace(/\s*-\s*/g, " ")                           // dashes to spaces
        .trim();

      // Try progressively shorter slices: 5 words, 4 words, 3 words
      const words = fileTitle.split(/\s+/);
      const candidates: string[] = [];
      for (const len of [5, 4, 3]) {
        if (words.length >= len) candidates.push(words.slice(0, len).join(" "));
      }
      // Deduplicate and skip terms we already tried
      const seen = new Set([searchTerm]);
      const uniqueCandidates = candidates.filter((t) => { if (seen.has(t)) return false; seen.add(t); return true; });

      for (const term of uniqueCandidates) {
        const retryUrl = new URL(`${jellyfinUrl}/Items`);
        retryUrl.searchParams.set("Recursive", "true");
        retryUrl.searchParams.set("IncludeItemTypes", "Movie,Episode");
        retryUrl.searchParams.set("Fields", "Path,MediaSources,UserData,Chapters");
        retryUrl.searchParams.set("SearchTerm", term);
        retryUrl.searchParams.set("Limit", "30");

        const retryRes = await fetch(retryUrl.toString(), { headers: jfHeaders });
        if (retryRes.ok) {
          const retryData = await retryRes.json() as { Items?: JellyfinItem[] };
          match = retryData.Items?.find(matchByFilename);
          if (match) break;
        }
      }
    }

    // 2b. If not found (episode beyond Limit=20), find the series then query its episodes
    if (!match) {
      const seriesUrl = new URL(`${jellyfinUrl}/Items`);
      seriesUrl.searchParams.set("Recursive", "true");
      seriesUrl.searchParams.set("IncludeItemTypes", "Series");
      seriesUrl.searchParams.set("SearchTerm", searchTerm);
      seriesUrl.searchParams.set("Limit", "5");

      const seriesRes = await fetch(seriesUrl.toString(), { headers: jfHeaders });
      if (seriesRes.ok) {
        const seriesData = await seriesRes.json() as { Items?: JellyfinItem[] };
        const series = seriesData.Items?.[0];
        if (series) {
          const epsUrl = new URL(`${jellyfinUrl}/Shows/${series.Id}/Episodes`);
          epsUrl.searchParams.set("Fields", "Path,MediaSources,UserData,Chapters");
          epsUrl.searchParams.set("Limit", "1000");

          const epsRes = await fetch(epsUrl.toString(), { headers: jfHeaders });
          if (epsRes.ok) {
            const epsData = await epsRes.json() as { Items?: JellyfinItem[] };
            match = epsData.Items?.find(matchByFilename);
          }
        }
      }
    }

    if (!match) return c.json({ available: false, reason: "not found in jellyfin" });

    // 2. Get first Jellyfin user ID (for PlaybackInfo)
    const usersRes = await fetch(`${jellyfinUrl}/Users`, {
      headers: { "X-Emby-Token": jellyfinKey },
    });
    const users = usersRes.ok ? (await usersRes.json() as Array<{ Id: string }>) : [];
    const userId = users[0]?.Id ?? "";

    // 3. Call PlaybackInfo with browser DeviceProfile
    const pbUrl = `${jellyfinUrl}/Items/${match.Id}/PlaybackInfo?UserId=${userId}&api_key=${jellyfinKey}`;
    const pbRes = await fetch(pbUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ DeviceProfile: BROWSER_DEVICE_PROFILE }),
    });
    if (!pbRes.ok) return c.json({ available: false, reason: "playback info failed" });

    const pbData = await pbRes.json() as {
      PlaySessionId?: string;
      MediaSources?: Array<{
        Id: string;
        Container?: string;
        SupportsDirectPlay?: boolean;
        SupportsDirectStream?: boolean;
        SupportsTranscoding?: boolean;
        TranscodingUrl?: string;
        RunTimeTicks?: number;
        MediaStreams?: Array<{
          Type: string;
          Index: number;
          Codec: string;
          Language?: string;
          DisplayTitle?: string;
          Title?: string;
          Channels?: number;
          Height?: number;
          Width?: number;
          IsDefault?: boolean;
          IsExternal?: boolean;
          DeliveryMethod?: string;
          DeliveryUrl?: string;
          SupportsExternalStream?: boolean;
        }>;
      }>;
    };

    const source = pbData.MediaSources?.[0];
    if (!source) return c.json({ available: false, reason: "no media source" });

    const baseUrl = jellyfinFrontendUrl(jellyfinUrl, c.req.header("host") ?? "localhost");
    const playSessionId = pbData.PlaySessionId ?? "";
    const mediaSourceId = source.Id;

    // Build both URLs — let the frontend quality selector offer both options
    const canDirectPlay = source.SupportsDirectPlay === true;
    const playMethod = canDirectPlay ? "DirectPlay" as const : "Transcode" as const;

    const directPlayUrl = `${baseUrl}/Videos/${match.Id}/stream?Static=true&MediaSourceId=${mediaSourceId}&PlaySessionId=${playSessionId}&api_key=${jellyfinKey}`;

    // Always construct a transcode URL — use Jellyfin's if available, otherwise build from scratch.
    // This ensures the frontend quality selector always has a transcode option, even for direct-play files.
    let transcodeUrl: string | undefined;
    if (source.TranscodingUrl) {
      transcodeUrl = `${baseUrl}${source.TranscodingUrl}`;
    } else {
      // Build HLS URL from scratch for direct-play files
      const hlsParams = new URLSearchParams({
        DeviceId: "talome-web",
        MediaSourceId: mediaSourceId,
        PlaySessionId: playSessionId,
        api_key: jellyfinKey,
        VideoCodec: "h264",
        AudioCodec: "aac",
        MaxAudioChannels: "2",
        TranscodingMaxAudioChannels: "2",
        SegmentContainer: "ts",
        MinSegments: "1",
        BreakOnNonKeyFrames: "True",
        ManifestSubtitles: "vtt",
        "h264-profile": "high",
        "h264-level": "51",
        VideoBitrate: "8000000",
        AudioBitrate: "192000",
        MaxWidth: "1920",
        TranscodeReasons: "DirectPlayError",
      });
      transcodeUrl = `${baseUrl}/Videos/${match.Id}/master.m3u8?${hlsParams.toString()}`;
    }

    // Build quality variants — always available for the frontend quality selector.
    const sourceHeight = (source.MediaStreams ?? []).find((s) => s.Type === "Video")?.Height ?? 1080;
    const transcodeQualities: Array<{ label: string; height: number; bitrate: number; url: string }> = [];
    const qualityPresets = [
      { label: "1080p", height: 1080, maxWidth: 1920, bitrate: 8_000_000 },
      { label: "720p",  height: 720,  maxWidth: 1280, bitrate: 4_000_000 },
      { label: "480p",  height: 480,  maxWidth: 854,  bitrate: 1_500_000 },
      { label: "360p",  height: 360,  maxWidth: 640,  bitrate: 800_000 },
    ].filter((p) => p.height <= sourceHeight);

    if (source.TranscodingUrl) {
      // Modify the existing transcode URL's bitrate/resolution params
      for (const preset of qualityPresets) {
        let url = source.TranscodingUrl;
        url = url.replace(/VideoBitrate=\d+/, `VideoBitrate=${preset.bitrate}`);
        if (url.includes("MaxWidth=")) {
          url = url.replace(/MaxWidth=\d+/, `MaxWidth=${preset.maxWidth}`);
        } else {
          url += `&MaxWidth=${preset.maxWidth}`;
        }
        transcodeQualities.push({
          label: preset.label,
          height: preset.height,
          bitrate: preset.bitrate,
          url: `${baseUrl}${url}`,
        });
      }
    } else {
      // Build quality URLs from scratch for direct-play files
      for (const preset of qualityPresets) {
        const params = new URLSearchParams({
          DeviceId: "talome-web",
          MediaSourceId: mediaSourceId,
          PlaySessionId: playSessionId,
          api_key: jellyfinKey,
          VideoCodec: "h264",
          AudioCodec: "aac",
          MaxAudioChannels: "2",
          TranscodingMaxAudioChannels: "2",
          SegmentContainer: "ts",
          MinSegments: "1",
          BreakOnNonKeyFrames: "True",
          VideoBitrate: String(preset.bitrate),
          AudioBitrate: "192000",
          MaxWidth: String(preset.maxWidth),
        });
        transcodeQualities.push({
          label: preset.label,
          height: preset.height,
          bitrate: preset.bitrate,
          url: `${baseUrl}/Videos/${match.Id}/master.m3u8?${params.toString()}`,
        });
      }
    }

    // Extract audio and subtitle tracks from MediaStreams
    const audioTracks = (source.MediaStreams ?? [])
      .filter((s) => s.Type === "Audio")
      .map((s) => ({
        index: s.Index,
        codec: s.Codec,
        language: s.Language ?? "und",
        title: s.DisplayTitle ?? s.Title ?? "",
        channels: s.Channels ?? 2,
        isDefault: s.IsDefault ?? false,
      }));

    const subtitleTracks = (source.MediaStreams ?? [])
      .filter((s) => s.Type === "Subtitle")
      .map((s) => ({
        index: s.Index,
        codec: s.Codec,
        language: s.Language ?? "und",
        title: s.DisplayTitle ?? s.Title ?? "",
        deliveryUrl: s.DeliveryUrl ? `${baseUrl}${s.DeliveryUrl}` : "",
        isDefault: s.IsDefault ?? false,
        isTextBased: s.Codec === "srt" || s.Codec === "ass" || s.Codec === "ssa" || s.Codec === "subrip" || s.Codec === "webvtt" || s.Codec === "mov_text",
      }));

    const duration = source.RunTimeTicks ? source.RunTimeTicks / 10_000_000 : 0;

    const resumePositionTicks = match.UserData?.PlaybackPositionTicks ?? 0;
    const chapters = (match.Chapters ?? []).map((ch) => ({
      startSeconds: ch.StartPositionTicks / 10_000_000,
      name: ch.Name,
    }));

    // Fetch trickplay (seek thumbnails) from Jellyfin
    let trickplay: {
      width: number; height: number;
      tileWidth: number; tileHeight: number;
      thumbnailCount: number; interval: number;
      baseUrl: string;
    } | null = null;
    try {
      const trickRes = await fetch(
        `${jellyfinUrl}/Users/${userId}/Items/${match.Id}?Fields=Trickplay&api_key=${jellyfinKey}`,
        { headers: jfHeaders, signal: AbortSignal.timeout(5000) },
      );
      if (trickRes.ok) {
        const trickData = await trickRes.json() as {
          Trickplay?: Record<string, Record<string, {
            Width?: number; Height?: number;
            TileWidth?: number; TileHeight?: number;
            ThumbnailCount?: number; Interval?: number;
          }>>;
        };
        if (trickData.Trickplay) {
          // Structure: Trickplay[mediaSourceId][resolution] = info
          const sourceEntry = trickData.Trickplay[mediaSourceId] ?? Object.values(trickData.Trickplay)[0];
          if (sourceEntry) {
            const resolutions = Object.keys(sourceEntry);
            if (resolutions.length > 0) {
              const res = resolutions[0];
              const info = sourceEntry[res];
              if (info) {
                trickplay = {
                  width: info.Width ?? 320,
                  height: info.Height ?? 180,
                  tileWidth: info.TileWidth ?? 10,
                  tileHeight: info.TileHeight ?? 10,
                  thumbnailCount: info.ThumbnailCount ?? 0,
                  interval: info.Interval ?? 10000,
                  baseUrl: `${baseUrl}/Videos/${match.Id}/Trickplay/${res}`,
                };
              }
            }
          }
        }
      }
    } catch { /* trickplay not available — non-critical */ }

    return c.json({
      available: true,
      playMethod,
      directPlayUrl,
      transcodeUrl,
      transcodeQualities,
      audioTracks,
      subtitleTracks,
      duration,
      itemId: match.Id,
      mediaSourceId,
      playSessionId,
      jellyfinBaseUrl: baseUrl,
      apiKey: jellyfinKey,
      resumePositionTicks,
      chapters,
      trickplay,
    });
  } catch (err) {
    log.error("Jellyfin playback failed", err instanceof Error ? err.message : err);
    return c.json({ available: false, reason: "jellyfin error" });
  }
});

// ── Related media by genre similarity ─────────────────────────────────────────

media.get("/related", async (c) => {
  const type = c.req.query("type") as "movie" | "tv" | undefined;
  const idRaw = c.req.query("id");
  const limitRaw = c.req.query("limit");
  if (!type || !idRaw || !["movie", "tv"].includes(type)) {
    return c.json({ error: "type (movie|tv) and id are required" }, 400);
  }
  const id = parseInt(idRaw, 10);
  if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const limit = Math.min(Math.max(parseInt(limitRaw ?? "12", 10) || 12, 1), 30);

  try {
    const endpoint = type === "movie" ? "/movie" : "/series";
    const service: "radarr" | "sonarr" = type === "movie" ? "radarr" : "sonarr";
    const raw = await serviceGet(service, endpoint);
    if (!Array.isArray(raw)) return c.json({ results: [] });
    const items = raw as Array<RadarrMovie | SonarrSeries>;

    const target = items.find((i) => i.id === id);
    if (!target) return c.json({ results: [] });

    const targetGenres = new Set<string>((target.genres ?? []).map((g) => g.toLowerCase()));
    if (targetGenres.size === 0) return c.json({ results: [] });

    const scored = items
      .filter((i) => i.id !== id)
      .map((i) => {
        const genres = (i.genres ?? []).map((g) => g.toLowerCase());
        const itemGenres = new Set(genres);
        let shared = 0;
        for (const g of targetGenres) {
          if (itemGenres.has(g)) shared++;
        }
        const union = new Set([...targetGenres, ...itemGenres]).size;
        const score = union > 0 ? shared / union : 0;
        return { item: i, score, rating: i.ratings?.tmdb?.value ?? i.ratings?.value ?? 0 };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.rating - a.rating)
      .slice(0, limit);

    const results = scored.map(({ item: i }) => {
      const movie = type === "movie" ? (i as RadarrMovie) : null;
      const series = type === "tv" ? (i as SonarrSeries) : null;
      return {
        id: i.id,
        title: i.title,
        year: i.year,
        tmdbId: movie?.tmdbId ?? null,
        tvdbId: series?.tvdbId ?? null,
        type,
        poster: posterUrl(service, i.images ?? []),
        backdrop: backdropUrl(service, i.images ?? []),
        genres: i.genres ?? [],
        rating: i.ratings?.tmdb?.value ?? i.ratings?.value ?? null,
        runtime: i.runtime ?? null,
        overview: i.overview ?? null,
        studio: movie?.studio ?? null,
        network: series?.network ?? null,
        seasonCount: series ? (series.statistics?.seasonCount ?? series.seasonCount ?? null) : undefined,
        hasFile: movie ? movie.hasFile : undefined,
        filePath: movie?.movieFile?.path ?? null,
      };
    });

    return c.json({ results });
  } catch (err: unknown) {
    return c.json({ error: errMsg(err), results: [] }, 500);
  }
});

export { media };
