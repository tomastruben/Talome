"use client";

/**
 * Shared data for the Media page, its window sidebar and the detail route.
 * Every caller of one of these keys uses the same fetcher and interval, so SWR
 * shares one request and one cache entry between them.
 */
import { useMemo, useSyncExternalStore } from "react";
import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";
import { optimizationJobsRefreshInterval } from "@/lib/polling";
import type { LibraryData, MediaItem } from "@/components/media/media-detail-sheet";
import type { OverseerrRequest } from "@/components/media/requests-tab";
import type { PlexWatchlistItem } from "@/components/media/watching-tab";
import { fileStem, movieHealth, type MovieHealth } from "@/components/media/media-library-view";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CalendarData {
  episodes: { id: number; seriesId?: number | null; seriesTitle: string; title: string; season: number; episode: number; airDate: string; poster?: string | null }[];
  movies: { id: number; title: string; releaseDate?: string; poster?: string | null; year?: number | null }[];
}

export type WantedApp = "sonarr" | "radarr";

export interface WantedRecord {
  id: number;
  app: WantedApp;
  title: string;
  year?: number | null;
  monitored?: boolean | null;
  quality?: string | null;
  size?: number | null;
  poster?: string | null;
  seriesId?: number | null;
  episodeId?: number | null;
  seasonNumber?: number | null;
  movieId?: number | null;
}

export interface WantedData {
  records: WantedRecord[];
  /** Everything Sonarr or Radarr reports as wanted, not only the loaded page. */
  totalRecords?: number;
  /** False when the app could not be reached. */
  available?: boolean;
}

export interface RequestsData {
  configured?: boolean;
  /** False when Overseerr is configured but could not be reached. */
  available?: boolean;
  results: OverseerrRequest[];
}

export interface PlexWatchlistData {
  configured: boolean;
  items: PlexWatchlistItem[];
}

export interface PlexWatchStatusData {
  configured: boolean;
  available?: boolean;
  watchStatus: Record<string, "watched" | "in-progress">;
}

export interface PlexContinueWatchingItem {
  ratingKey?: string;
  title?: string;
  episodeTitle?: string;
  type: "movie" | "tv";
  year?: number;
  thumb?: string;
  viewOffset?: number;
  duration?: number;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
}

export interface PlexWatchingData {
  configured: boolean;
  /** False when Plex is configured but could not be reached. */
  available?: boolean;
  continueWatching?: PlexContinueWatchingItem[];
}

export interface OptimizationJobsData {
  jobs: Array<{ sourcePath: string; status: string; progress: number }>;
}

export interface ScanEntry {
  needsOptimization: boolean;
  videoCodec: string;
  audioCodec: string;
  container: string;
}

export interface ScanStatusData {
  entries: Record<string, ScanEntry>;
}

// ── Fetchers ──────────────────────────────────────────────────────────────────

async function readJson(res: Response): Promise<unknown> {
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
      ? data.error
      : `Request failed (${res.status})`;
    throw new Error(message);
  }
  if (data && typeof data === "object" && "error" in data && data.error) {
    throw new Error(typeof data.error === "string" ? data.error : "Request failed");
  }
  return data;
}

/** Throws on a failed response and on a JSON `{ error }`, so SWR never caches a failure as data. */
export async function mediaFetcher<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  return (await readJson(res)) as T;
}

// ── Keys ──────────────────────────────────────────────────────────────────────

export const MEDIA_LIBRARY_KEY = `${CORE_URL}/api/media/library`;
export const MEDIA_CALENDAR_KEY = `${CORE_URL}/api/media/calendar`;
export const MEDIA_REQUESTS_KEY = `${CORE_URL}/api/media/requests`;
export const PLEX_WATCHLIST_KEY = `${CORE_URL}/api/media/plex/watchlist`;
export const PLEX_WATCHING_KEY = `${CORE_URL}/api/media/plex/watching`;
export const PLEX_WATCH_STATUS_KEY = `${CORE_URL}/api/media/plex/watch-status`;
export const OPTIMIZATION_JOBS_KEY = `${CORE_URL}/api/optimization/jobs?status=running,queued,completed`;
export const SCAN_STATUS_KEY = `${CORE_URL}/api/optimization/scan-status`;
/** Rows loaded per app on the Wanted view. */
export const WANTED_PAGE_SIZE = 40;

export function mediaWantedKey(app: WantedApp) {
  return `${CORE_URL}/api/media/wanted?app=${app}&kind=missing&page=1&pageSize=${WANTED_PAGE_SIZE}`;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const currentHour = () => Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
function subscribeHourly(onChange: () => void) {
  const timer = setInterval(onChange, HOUR_MS);
  return () => clearInterval(timer);
}

/**
 * The time, to the hour: precise enough for "added in the last 30 days", and
 * the same on every render within the hour, so memoised filters stay stable.
 */
export function useHourClock(): number {
  return useSyncExternalStore(subscribeHourly, currentHour, currentHour);
}

export function useMediaLibrary() {
  return useSWR<LibraryData>(MEDIA_LIBRARY_KEY, mediaFetcher, { refreshInterval: 30000 });
}

export function useMediaCalendar() {
  return useSWR<CalendarData>(MEDIA_CALENDAR_KEY, mediaFetcher, { refreshInterval: 60000 });
}

export function useMediaWanted(app: WantedApp) {
  return useSWR<WantedData>(mediaWantedKey(app), mediaFetcher, { refreshInterval: 60000 });
}

export function useMediaRequests() {
  return useSWR<RequestsData>(MEDIA_REQUESTS_KEY, mediaFetcher, { refreshInterval: 60000 });
}

export function usePlexWatchlist() {
  return useSWR<PlexWatchlistData>(PLEX_WATCHLIST_KEY, mediaFetcher, { refreshInterval: 60000 });
}

export function usePlexWatching() {
  return useSWR<PlexWatchingData>(PLEX_WATCHING_KEY, mediaFetcher, { refreshInterval: 30000 });
}

export function usePlexWatchStatus() {
  return useSWR<PlexWatchStatusData>(PLEX_WATCH_STATUS_KEY, mediaFetcher, { refreshInterval: 120000 });
}

/**
 * Where one source of the Media page stands. `loading` and `error` mean no
 * response yet (or only a failed one); `not-configured` and `unreachable` come
 * from the response itself. Only `ready` data may be shown as a fact, so an
 * empty list never stands in for "still loading" or "couldn't connect".
 */
export type MediaSourceStatus = "loading" | "error" | "not-configured" | "unreachable" | "ready";

export function mediaSourceStatus(
  data: { configured?: boolean; available?: boolean } | undefined,
  error: unknown,
): MediaSourceStatus {
  if (data === undefined) return error ? "error" : "loading";
  if (data.configured === false) return "not-configured";
  if (data.available === false) return "unreachable";
  return "ready";
}

/** The source answered, but with a failure: nothing it would show can be trusted. */
export function sourceFailed(status: MediaSourceStatus): boolean {
  return status === "error" || status === "unreachable";
}

/** Watch status by `tmdb:<id>`, or null when Plex watch status isn't configured or reachable. */
export function watchStatusOrNull(data: PlexWatchStatusData | undefined) {
  return data?.configured === true && data.available !== false ? data.watchStatus : null;
}

/** Sum of everything Sonarr and Radarr report as wanted; null until one of them answers. */
export function wantedTotal(sonarr: WantedData | undefined, radarr: WantedData | undefined): number | null {
  const parts = [sonarr, radarr].filter((d): d is WantedData => !!d && d.available !== false);
  if (parts.length === 0) return null;
  return parts.reduce((sum, d) => sum + (d.totalRecords ?? d.records.length), 0);
}

async function postScanStatus(basenames: readonly string[]): Promise<ScanStatusData> {
  const res = await fetch(SCAN_STATUS_KEY, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ basenames }),
  });
  return (await readJson(res)) as ScanStatusData;
}

/** A short, stable signature of the scanned file list (FNV-1a), so the SWR key stays small. */
function signatureOf(names: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const name of names) {
    for (let i = 0; i < name.length; i++) {
      hash ^= name.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 10;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${names.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * Movie scan health (ready to play or needs conversion) from the optimization
 * scan cache plus finished conversion jobs. Movies only: TV is scanned per
 * episode on its detail page.
 */
export function useMovieHealth(movies: readonly MediaItem[] | undefined) {
  const jobs = useSWR<OptimizationJobsData>(OPTIMIZATION_JOBS_KEY, mediaFetcher, {
    // 3s while a job is running or queued, 30s when idle
    refreshInterval: optimizationJobsRefreshInterval,
  });
  const basenames = useMemo(() => {
    const names: string[] = [];
    for (const movie of movies ?? []) if (movie.filePath) names.push(fileStem(movie.filePath));
    return { names, signature: names.length > 0 ? signatureOf(names) : null };
  }, [movies]);
  const scan = useSWR<ScanStatusData>(
    basenames.signature ? [SCAN_STATUS_KEY, basenames.signature] : null,
    () => postScanStatus(basenames.names),
    { refreshInterval: 30000 },
  );

  const jobsByStem = useMemo(() => {
    const map = new Map<string, { status: string; progress: number }>();
    for (const job of jobs.data?.jobs ?? []) map.set(fileStem(job.sourcePath), { status: job.status, progress: job.progress });
    return map;
  }, [jobs.data]);
  const scanByStem = useMemo(() => scan.data?.entries ?? {}, [scan.data]);

  // Finished conversions turn a scanned "needs conversion" into "ready", so
  // health is known only once both the scan and the job list have answered.
  const jobsSettled = jobs.data !== undefined || jobs.error !== undefined;
  const healthOf = useMemo(
    () => (scan.data && jobsSettled ? (item: MediaItem): MovieHealth | null => movieHealth(item, jobsByStem, scanByStem) : null),
    [scan.data, jobsSettled, jobsByStem, scanByStem],
  );
  /** Movies with files are being checked; ready and needs-conversion aren't decided yet. */
  const scanPending = (basenames.signature !== null && !scan.data && !scan.error)
    || (!!scan.data && !jobsSettled);
  /** The scan results never loaded (a failed refresh keeps the last results). */
  const scanError: unknown = scan.data ? undefined : scan.error;

  const counts = useMemo(() => {
    let scanned = 0;
    let ready = 0;
    let needsConversion = 0;
    if (healthOf) {
      for (const movie of movies ?? []) {
        const health = healthOf(movie);
        if (!health) continue;
        scanned++;
        if (health === "ready") ready++;
        else needsConversion++;
      }
    }
    return { scanned, ready, needsConversion };
  }, [healthOf, movies]);

  return { jobsByStem, healthOf, counts, scanPending, scanError, mutateScan: scan.mutate };
}
