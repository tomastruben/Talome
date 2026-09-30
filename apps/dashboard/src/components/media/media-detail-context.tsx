"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import useSWR, { useSWRConfig } from "swr";
import { CORE_URL } from "@/lib/constants";
import { POLL_SLOW_MS } from "@/lib/polling";
import type {
  SheetItem,
  MediaItem,
  LookupItem,
  LibraryData,
} from "./media-detail-sheet";

// The sheet (and its download polling) is only needed once a detail is
// opened — keep it out of the dashboard shell's initial bundle.
const loadMediaDetailSheet = () => import("./media-detail-sheet");
const UnifiedMediaSheet = dynamic(
  () => loadMediaDetailSheet().then((m) => ({ default: m.UnifiedMediaSheet })),
  { ssr: false },
);

const LIBRARY_KEY = `${CORE_URL}/api/media/library`;
/** Give up waiting for the library after this long and fall back to a lookup. */
const LIBRARY_WAIT_TIMEOUT_MS = 15_000;

// ── Context ───────────────────────────────────────────────────────────────────

interface MediaDetailContextValue {
  /** Open the detail sheet for the item whose title best matches `title`.
   *  If the title is not in the library, falls back to a Radarr/Sonarr lookup. */
  openDetail: (
    title: string,
    options?: { typeHint?: "movie" | "tv"; yearHint?: number }
  ) => void;
  /** Return the library item that best matches `title`, or undefined if not found. */
  findItem: (title: string) => MediaItem | undefined;
  /**
   * Register interest in library data (starts fetching/polling it while at
   * least one consumer holds it). Returns the release function.
   */
  acquireLibrary: () => () => void;
}

const MediaDetailContext = createContext<MediaDetailContextValue | null>(null);

export function useMediaDetail() {
  const ctx = useContext(MediaDetailContext);
  if (!ctx) throw new Error("useMediaDetail must be used within MediaDetailProvider");
  return ctx;
}

/**
 * Declare that the calling component needs `findItem` to see library data.
 * The library (a full Sonarr/Radarr pull on the backend) is only fetched —
 * and refreshed every 60s — while at least one consumer is mounted or a
 * detail sheet is open, instead of on every dashboard page.
 */
export function useMediaLibraryDemand(enabled = true) {
  const acquire = useContext(MediaDetailContext)?.acquireLibrary;
  useEffect(() => {
    if (!enabled || !acquire) return;
    return acquire();
  }, [enabled, acquire]);
}

// ── Provider ──────────────────────────────────────────────────────────────────

async function fetcher(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("API error");
  return res.json();
}

function normalise(s: string) {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

interface ParsedReference {
  title: string;
  year?: number;
  tmdbId?: number;
  tvdbId?: number;
}

function parseReference(raw: string): ParsedReference {
  const trimmed = raw.trim().replace(/^["'`]+|["'`]+$/g, "");

  let title = trimmed;
  let year: number | undefined;
  let tmdbId: number | undefined;
  let tvdbId: number | undefined;

  // Extract tmdbId: 123 or tvdbId: 456 anywhere in the string
  const tmdbMatch = trimmed.match(/\btmdb(?:Id)?:\s*(\d+)/i);
  if (tmdbMatch) tmdbId = Number(tmdbMatch[1]);
  const tvdbMatch = trimmed.match(/\btvdb(?:Id)?:\s*(\d+)/i);
  if (tvdbMatch) tvdbId = Number(tvdbMatch[1]);

  // Match "Title (2014)" or "Title (2014, tmdbId: 123)" — extract year and strip parenthetical
  const parenMatch = trimmed.match(/^(.+?)\s*\(((?:19|20)\d{2})(?:\s*,\s*[^)]*)?\)/);
  if (parenMatch) {
    title = parenMatch[1].trim();
    year = Number(parenMatch[2]);
  } else {
    // Strip dash-separated suffixes (e.g. "Title — some note")
    const withDashRemoved = trimmed.split(/\s[-–—]\s/, 1)[0]?.trim() ?? trimmed;
    title = withDashRemoved || trimmed;
    // Remove any remaining ID patterns from the title
    title = title.replace(/\s*,?\s*\btmdb(?:Id)?:\s*\d+/i, "").replace(/\s*,?\s*\btvdb(?:Id)?:\s*\d+/i, "").trim();
  }

  return { title: title || trimmed, year, tmdbId, tvdbId };
}

// Stop-words that are too common to be meaningful in fuzzy matching
const STOP_WORDS = new Set(["the", "a", "an", "of", "and", "in", "on", "at", "to", "for", "is", "it", "my"]);

function scoreTitleMatch(candidateTitle: string, queryTitle: string): number {
  const candidate = normalise(candidateTitle);
  const query = normalise(queryTitle);
  if (!candidate || !query) return 0;
  if (candidate === query) return 100;
  if (candidate.startsWith(query)) return 75;
  if (candidate.includes(query)) return 60;
  if (query.includes(candidate)) return 45;

  // Token-based fuzzy match — only count non-stop-word tokens
  const queryTokens = queryTitle
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
  if (queryTokens.length > 1) {
    const tokenHits = queryTokens.filter((t) => candidate.includes(t)).length;
    const ratio = tokenHits / queryTokens.length;
    // Require at least 50% of meaningful tokens to match
    if (ratio >= 0.5) {
      return 20 + Math.round(ratio * 30);
    }
  }

  return 0;
}

/** Minimum fuzzy score to accept a title match (prevents weak single-token hits). */
const MIN_TITLE_SCORE = 40;

interface MatchOpts {
  typeHint?: "movie" | "tv";
  yearHint?: number;
  tmdbId?: number;
  tvdbId?: number;
}

function pickBestMediaItem(
  all: MediaItem[],
  queryTitle: string,
  opts?: MatchOpts
): MediaItem | undefined {
  // 1. ID-based exact match (instant, guaranteed correct)
  if (opts?.tmdbId) {
    const byId = all.find((item) => item.tmdbId === opts.tmdbId);
    if (byId) return byId;
  }
  if (opts?.tvdbId) {
    const byId = all.find((item) => item.tvdbId === opts.tvdbId);
    if (byId) return byId;
  }

  // 2. Fall back to fuzzy title matching with stricter scoring
  let best: { item: MediaItem; score: number } | null = null;

  for (const item of all) {
    if (opts?.typeHint && item.type !== opts.typeHint) continue;

    let score = scoreTitleMatch(item.title, queryTitle);
    if (score < MIN_TITLE_SCORE) continue;

    if (opts?.yearHint != null && item.year != null) {
      if (item.year === opts.yearHint) score += 35;
      else if (Math.abs(item.year - opts.yearHint) === 1) score += 10;
      else score -= 15;
    }

    // Length-ratio tiebreaker: penalize large differences in title length
    const candidateLen = normalise(item.title).length;
    const queryLen = normalise(queryTitle).length;
    if (candidateLen > 0 && queryLen > 0) {
      const ratio = Math.min(candidateLen, queryLen) / Math.max(candidateLen, queryLen);
      // Up to +10 bonus for closely-sized titles, 0 for very different lengths
      score += Math.round(ratio * 10);
    }

    if (!best || score > best.score) {
      best = { item, score };
    }
  }

  return best?.item;
}

function pickBestLookupItem(
  results: LookupItem[],
  queryTitle: string,
  opts?: MatchOpts
): LookupItem | null {
  // 1. ID-based exact match
  if (opts?.tmdbId) {
    const byId = results.find((item) => item.tmdbId === opts.tmdbId);
    if (byId) return byId;
  }
  if (opts?.tvdbId) {
    const byId = results.find((item) => item.tvdbId === opts.tvdbId);
    if (byId) return byId;
  }

  // 2. Fuzzy title matching with stricter scoring
  let best: { item: LookupItem; score: number } | null = null;

  for (const item of results) {
    if (opts?.typeHint && item.type !== opts.typeHint) continue;

    let score = scoreTitleMatch(item.title, queryTitle);
    if (score < MIN_TITLE_SCORE) continue;

    if (opts?.yearHint != null && item.year != null) {
      if (item.year === opts.yearHint) score += 35;
      else if (Math.abs(item.year - opts.yearHint) === 1) score += 10;
      else score -= 15;
    }

    const candidateLen = normalise(item.title).length;
    const queryLen = normalise(queryTitle).length;
    if (candidateLen > 0 && queryLen > 0) {
      const ratio = Math.min(candidateLen, queryLen) / Math.max(candidateLen, queryLen);
      score += Math.round(ratio * 10);
    }

    if (!best || score > best.score) {
      best = { item, score };
    }
  }

  return best?.item ?? null;
}

function resolveLibraryItem(
  lib: LibraryData | undefined,
  title: string,
  options?: MatchOpts
): MediaItem | undefined {
  if (!lib) return undefined;
  const all: MediaItem[] = [...(lib.movies ?? []), ...(lib.tv ?? [])];
  return pickBestMediaItem(all, title, options);
}

export function MediaDetailProvider({ children }: { children: React.ReactNode }) {
  const [sheetItem, setSheetItem] = useState<SheetItem | null>(null);
  const [sheetMounted, setSheetMounted] = useState(false);
  const [libraryDemand, setLibraryDemand] = useState(0);
  const { cache } = useSWRConfig();

  // Fetch the library only while something needs it: a consumer registered
  // demand (chat inline media tags) or a detail sheet is open / loading.
  const libraryActive = libraryDemand > 0 || sheetItem !== null;
  const { data: library, error: libraryError } = useSWR<LibraryData>(
    libraryActive ? LIBRARY_KEY : null,
    fetcher,
    {
      refreshInterval: POLL_SLOW_MS,
      revalidateOnFocus: false,
      // Data already cached by the media pages is fresh enough; the 60s
      // refresh keeps it current while active.
      revalidateIfStale: false,
    },
  );

  /** Latest library from the shared SWR cache (also filled by media pages). */
  const getLibrary = useCallback(
    (): LibraryData | undefined => cache.get(LIBRARY_KEY)?.data as LibraryData | undefined,
    [cache],
  );

  // Resolvers waiting for the library to arrive (openDetail before load).
  const libraryWaitersRef = useRef<Array<(lib: LibraryData | undefined) => void>>([]);
  useEffect(() => {
    if (!library && !libraryError) return;
    const waiters = libraryWaitersRef.current;
    libraryWaitersRef.current = [];
    for (const resolveWaiter of waiters) resolveWaiter(library);
  }, [library, libraryError]);

  const waitForLibrary = useCallback((): Promise<LibraryData | undefined> => {
    const cached = getLibrary();
    if (cached) return Promise.resolve(cached);
    if (cache.get(LIBRARY_KEY)?.error) return Promise.resolve(undefined);
    return new Promise((resolveWait) => {
      let settled = false;
      const settle = (lib: LibraryData | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveWait(lib);
      };
      const timer = setTimeout(() => settle(getLibrary()), LIBRARY_WAIT_TIMEOUT_MS);
      libraryWaitersRef.current.push(settle);
    });
  }, [cache, getLibrary]);

  const acquireLibrary = useCallback(() => {
    setLibraryDemand((n) => n + 1);
    // Warm the sheet chunk so opening a detail from chat is instant.
    void loadMediaDetailSheet().catch(() => {});
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setLibraryDemand((n) => Math.max(0, n - 1));
    };
  }, []);

  // Monotonic id so a stale async open (library/lookup still loading) never
  // overrides a newer open or a close.
  const openSeqRef = useRef(0);

  const openDetail = useCallback((
    rawTitle: string,
    options?: { typeHint?: "movie" | "tv"; yearHint?: number }
  ) => {
    const seq = ++openSeqRef.current;
    setSheetMounted(true);
    setSheetItem(null);
    const parsed = parseReference(rawTitle);
    const queryTitle = parsed.title || rawTitle;
    const yearHint = options?.yearHint ?? parsed.year;
    const tmdbId = parsed.tmdbId;
    const tvdbId = parsed.tvdbId;
    const matchOpts: MatchOpts = { typeHint: options?.typeHint, yearHint, tmdbId, tvdbId };

    const lookup = () => {
      // Not in library — show loading, then fetch metadata
      setSheetItem({ kind: "loading", pendingTitle: queryTitle });
      const params = new URLSearchParams({ q: queryTitle });
      if (options?.typeHint) params.set("type", options.typeHint);
      fetch(`${CORE_URL}/api/media/lookup?${params.toString()}`)
        .then((r) => r.ok ? r.json() : Promise.reject())
        .then((data) => {
          if (seq !== openSeqRef.current) return;
          const results: LookupItem[] = data.results ?? [];
          const best = pickBestLookupItem(results, queryTitle, matchOpts);
          if (best) {
            setSheetItem({ kind: "lookup", data: best });
          } else {
            setSheetItem(null);
          }
        })
        .catch(() => {
          if (seq === openSeqRef.current) setSheetItem(null);
        });
    };

    const showResolved = (lib: LibraryData | undefined) => {
      const match = resolveLibraryItem(lib, queryTitle, matchOpts);
      if (match) {
        // Open unified sheet in library mode
        setSheetItem({ kind: "library", data: match });
        return;
      }
      lookup();
    };

    const cached = getLibrary();
    if (cached) {
      showResolved(cached);
      return;
    }

    // Library not loaded yet (it is fetched lazily): show the loading state —
    // which also activates the library fetch — then resolve once it arrives.
    setSheetItem({ kind: "loading", pendingTitle: queryTitle });
    void waitForLibrary().then((lib) => {
      if (seq !== openSeqRef.current) return;
      showResolved(lib);
    });
  }, [getLibrary, waitForLibrary]);

  const closeDetail = useCallback(() => {
    openSeqRef.current++;
    setSheetItem(null);
  }, []);

  const findItem = useCallback((title: string): MediaItem | undefined => {
    const parsed = parseReference(title);
    return resolveLibraryItem(getLibrary(), parsed.title || title, {
      yearHint: parsed.year,
      tmdbId: parsed.tmdbId,
      tvdbId: parsed.tvdbId,
    });
  // `library` is a dependency so consumers re-render once data arrives.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getLibrary, library]);

  const value = useMemo(
    () => ({ openDetail, findItem, acquireLibrary }),
    [openDetail, findItem, acquireLibrary],
  );

  return (
    <MediaDetailContext.Provider value={value}>
      {children}
      {sheetMounted && (
        <UnifiedMediaSheet
          item={sheetItem}
          onClose={closeDetail}
        />
      )}
    </MediaDetailContext.Provider>
  );
}
