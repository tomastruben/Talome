import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { or, like } from "drizzle-orm";
import { getSetting } from "../utils/settings.js";
import { listContainers } from "../docker/client.js";
import type { SearchResult, UnifiedSearchResponse } from "@talome/types";

export const search = new Hono();

// ── External API response shapes (minimal, for type safety) ─────────────────

/** Sonarr series lookup result (subset of fields we use) */
interface SonarrLookupItem {
  id?: number;
  title?: string;
  tvdbId?: number;
  tmdbId?: number;
  year?: number;
  overview?: string;
  images?: Array<{ coverType: string; url?: string; remoteUrl?: string }>;
  ratings?: { value?: number };
}

/** Radarr movie lookup result (subset of fields we use) */
interface RadarrLookupItem {
  id?: number;
  title?: string;
  tmdbId?: number;
  tvdbId?: number;
  year?: number;
  overview?: string;
  images?: Array<{ coverType: string; url?: string; remoteUrl?: string }>;
  ratings?: { value?: number; tmdb?: { value?: number } };
}

// ── TTL Cache ────────────────────────────────────────────────────────────────

interface CacheEntry<T> { data: T; expires: number }

function ttlCache<T>(ttlMs: number) {
  const store = new Map<string, CacheEntry<T>>();
  return {
    get(key: string): T | undefined {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expires) { store.delete(key); return undefined; }
      return entry.data;
    },
    set(key: string, data: T) {
      store.set(key, { data, expires: Date.now() + ttlMs });
      // Evict expired entries periodically (keep map bounded)
      if (store.size > 100) {
        const now = Date.now();
        for (const [k, v] of store) { if (now > v.expires) store.delete(k); }
      }
    },
  };
}

/** Cache for media lookups (Sonarr/Radarr hit TMDB — slow). 30s TTL. */
const mediaCache = ttlCache<any[]>(30_000);

/** Cache for Docker container list. 5s TTL. */
const containerCache = ttlCache<Awaited<ReturnType<typeof listContainers>>>(5_000);

/** Cache for installed app IDs. 10s TTL. */
const installedAppsCache = ttlCache<Set<string>>(10_000);

/** Cache for Audiobookshelf library ID. 5min TTL (rarely changes). */
let absLibraryCache: { id: string; expires: number } | null = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function serviceUrl(service: string): string | null {
  return getSetting(`${service}_url`) || null;
}

function apiKey(service: string): string {
  return getSetting(`${service}_api_key`) ?? "";
}

/** Score a match: 1.0 exact, 0.8 starts-with, 0.5 contains. */
function scoreMatch(name: string, query: string): number {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n === q) return 1.0;
  if (n.startsWith(q)) return 0.8;
  return 0.5;
}

/** Timed wrapper — runs a search function and captures its latency. */
async function timed<T>(
  label: string,
  fn: () => Promise<T>,
  timing: Record<string, number>,
): Promise<T> {
  const t0 = performance.now();
  try {
    const result = await fn();
    timing[label] = Math.round(performance.now() - t0);
    return result;
  } catch {
    timing[label] = Math.round(performance.now() - t0);
    return [] as unknown as T;
  }
}

// ── Source: Apps (local DB) ──────────────────────────────────────────────────

function getInstalledAppIds(): Set<string> {
  const cached = installedAppsCache.get("ids");
  if (cached) return cached;
  const ids = new Set(
    db.select({ appId: schema.installedApps.appId }).from(schema.installedApps).all().map((r) => r.appId),
  );
  installedAppsCache.set("ids", ids);
  return ids;
}

function searchApps(query: string): SearchResult[] {
  const term = `%${query}%`;
  const rows = db
    .select()
    .from(schema.appCatalog)
    .where(
      or(
        like(schema.appCatalog.name, term),
        like(schema.appCatalog.tagline, term),
        like(schema.appCatalog.category, term),
      ),
    )
    .limit(20)
    .all();

  const installed = getInstalledAppIds();

  return rows.slice(0, 6).map((r): SearchResult => ({
    kind: "app",
    id: r.appId,
    name: r.name,
    storeId: r.storeSourceId,
    category: r.category ?? "other",
    icon: r.icon,
    iconUrl: r.iconUrl,
    installed: installed.has(r.appId),
    score: scoreMatch(r.name, query),
  }));
}

// ── Source: Containers (Docker API) ──────────────────────────────────────────

async function searchContainers(query: string): Promise<SearchResult[]> {
  let all = containerCache.get("list");
  if (!all) {
    all = await listContainers();
    containerCache.set("list", all);
  }
  const q = query.toLowerCase();
  return all
    .filter((c) => c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q))
    .slice(0, 5)
    .map((c): SearchResult => ({
      kind: "container",
      id: c.id,
      name: c.name,
      image: c.image,
      status: c.status,
      score: scoreMatch(c.name, query),
    }));
}

// ── Source: Automations (local DB) ───────────────────────────────────────────

function searchAutomations(query: string): SearchResult[] {
  const term = `%${query}%`;
  const rows = db
    .select()
    .from(schema.automations)
    .where(like(schema.automations.name, term))
    .limit(5)
    .all();

  return rows.map((r): SearchResult => ({
    kind: "automation",
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    lastRunAt: r.lastRunAt,
    score: scoreMatch(r.name, query),
  }));
}

// ── Source: Media (Sonarr + Radarr) ──────────────────────────────────────────

async function fetchServiceCached(service: string, path: string): Promise<any[]> {
  const cacheKey = `${service}:${path}`;
  const cached = mediaCache.get(cacheKey);
  if (cached) return cached;
  const data = await fetchService(service, path);
  const arr = Array.isArray(data) ? data : [];
  mediaCache.set(cacheKey, arr);
  return arr;
}

async function searchMedia(query: string): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const encodedQuery = encodeURIComponent(query);

  const [sonarrRes, radarrRes] = await Promise.allSettled([
    serviceUrl("sonarr")
      ? fetchServiceCached("sonarr", `/series/lookup?term=${encodedQuery}`)
      : Promise.resolve([]),
    serviceUrl("radarr")
      ? fetchServiceCached("radarr", `/movie/lookup?term=${encodedQuery}`)
      : Promise.resolve([]),
  ]);

  if (sonarrRes.status === "fulfilled") {
    for (const s of (sonarrRes.value as SonarrLookupItem[]).slice(0, 5)) {
      const inLibrary = typeof s.id === "number" && s.id > 0;
      results.push({
        kind: "media",
        id: `tv-${s.tvdbId}`,
        name: s.title ?? "",
        type: "tv",
        year: s.year ?? 0,
        overview: s.overview ?? "",
        poster: buildPosterProxy("sonarr", s.images, inLibrary),
        serviceId: inLibrary ? s.id ?? 0 : 0,
        inLibrary,
        tmdbId: s.tmdbId ?? null,
        tvdbId: s.tvdbId ?? null,
        rating: s.ratings?.value ?? null,
        score: inLibrary ? 0.9 : scoreMatch(s.title ?? "", query),
      });
    }
  }

  if (radarrRes.status === "fulfilled") {
    for (const m of (radarrRes.value as RadarrLookupItem[]).slice(0, 5)) {
      const inLibrary = typeof m.id === "number" && m.id > 0;
      results.push({
        kind: "media",
        id: `movie-${m.tmdbId}`,
        name: m.title ?? "",
        type: "movie",
        year: m.year ?? 0,
        overview: m.overview ?? "",
        poster: buildPosterProxy("radarr", m.images, inLibrary),
        serviceId: inLibrary ? m.id ?? 0 : 0,
        inLibrary,
        tmdbId: m.tmdbId ?? null,
        tvdbId: m.tvdbId ?? null,
        rating: m.ratings?.tmdb?.value ?? m.ratings?.value ?? null,
        score: inLibrary ? 0.9 : scoreMatch(m.title ?? "", query),
      });
    }
  }

  // Library items first, then by score
  results.sort((a, b) => {
    if (a.kind === "media" && b.kind === "media") {
      if (a.inLibrary !== b.inLibrary) return a.inLibrary ? -1 : 1;
    }
    return b.score - a.score;
  });

  return results;
}

/** Build a poster URL that uses the Talome proxy (cached, resized).
 *  Non-library items use the remote TMDB URL directly — the local path
 *  doesn't exist on the arr server for items not yet added. */
function buildPosterProxy(service: "sonarr" | "radarr", images: any[] | undefined, inLibrary: boolean): string | null {
  if (!images?.length) return null;
  const img = images.find((i: any) => i.coverType === "poster");
  if (!img) return null;
  const localPath: string | undefined = img.url;
  const remote: string | undefined = img.remoteUrl;
  if (!inLibrary) return remote ?? null;
  if (localPath) {
    const path = localPath.startsWith("/") ? localPath.slice(1) : localPath;
    return `/api/media/poster?service=${service}&path=${encodeURIComponent(path)}&w=120`;
  }
  return remote ?? null;
}

async function fetchService(service: string, path: string): Promise<any> {
  const base = serviceUrl(service);
  const key = apiKey(service);
  if (!base || !key) throw new Error(`${service} not configured`);
  const res = await fetch(`${base}/api/v3${path}`, {
    headers: { "X-Api-Key": key },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`${service} ${res.status}`);
  return res.json();
}

// ── Source: Audiobooks (Audiobookshelf) ──────────────────────────────────────

async function getAbsLibraryId(base: string, token: string): Promise<string | null> {
  if (absLibraryCache && Date.now() < absLibraryCache.expires) {
    return absLibraryCache.id;
  }
  const libRes = await fetch(`${base}/api/libraries`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!libRes.ok) return null;
  const { libraries } = (await libRes.json()) as { libraries: any[] };
  if (!libraries?.length) return null;
  absLibraryCache = { id: libraries[0].id, expires: Date.now() + 300_000 };
  return absLibraryCache.id;
}

async function searchAudiobooks(query: string): Promise<SearchResult[]> {
  const base = serviceUrl("audiobookshelf");
  const token = apiKey("audiobookshelf");
  if (!base || !token) return [];

  const libraryId = await getAbsLibraryId(base, token);
  if (!libraryId) return [];

  const searchRes = await fetch(
    `${base}/api/libraries/${libraryId}/search?q=${encodeURIComponent(query)}&limit=5`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    },
  );
  if (!searchRes.ok) return [];
  const data = (await searchRes.json()) as { book?: any[] };

  return (data.book ?? []).slice(0, 5).map((entry: any): SearchResult => {
    const item = entry.libraryItem ?? entry;
    const meta = item.media?.metadata ?? {};
    return {
      kind: "audiobook",
      id: item.id ?? "",
      name: meta.title ?? item.name ?? "",
      author: meta.authorName ?? "",
      cover: item.id ? `/api/audiobooks/cover?id=${encodeURIComponent(item.id)}&w=120` : null,
      duration: item.media?.duration ?? null,
      score: scoreMatch(meta.title ?? "", query),
    };
  });
}

// ── Endpoint ─────────────────────────────────────────────────────────────────

search.get("/", async (c) => {
  const query = c.req.query("q")?.trim() ?? "";
  if (!query || query.length < 2) {
    return c.json({ query, results: [], timing: {} } satisfies UnifiedSearchResponse);
  }

  const timing: Record<string, number> = {};

  // Local (synchronous, instant)
  const t0 = performance.now();
  const localResults: SearchResult[] = [
    ...searchApps(query),
    ...searchAutomations(query),
  ];
  timing.local = Math.round(performance.now() - t0);

  // Remote (parallel, with timeouts)
  const remoteSearches: Promise<SearchResult[]>[] = [];

  remoteSearches.push(timed("containers", () => searchContainers(query), timing));

  if (serviceUrl("sonarr") || serviceUrl("radarr")) {
    remoteSearches.push(timed("media", () => searchMedia(query), timing));
  }

  if (serviceUrl("audiobookshelf")) {
    remoteSearches.push(timed("audiobooks", () => searchAudiobooks(query), timing));
  }

  const remoteResults = await Promise.allSettled(remoteSearches);
  const allResults = [...localResults];
  for (const r of remoteResults) {
    if (r.status === "fulfilled") allResults.push(...r.value);
  }

  // Sort: library media first, then highest score, then alphabetical
  allResults.sort((a, b) => {
    // Library items always surface first
    const aLib = a.kind === "media" && a.inLibrary ? 1 : 0;
    const bLib = b.kind === "media" && b.inLibrary ? 1 : 0;
    if (aLib !== bLib) return bLib - aLib;
    return b.score - a.score || a.name.localeCompare(b.name);
  });

  return c.json({ query, results: allResults, timing } satisfies UnifiedSearchResponse);
});
