/**
 * The Media page's view model, kept pure so the URL, the window sidebar, the
 * classic tabs and the detail route all agree on what a "view" is and how it
 * filters the library. No React, no fetching: callers inject the clock and the
 * data they already have.
 */
import type { MediaItem } from "@/components/media/media-detail-sheet";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MediaTab = "movies" | "tv" | "downloads" | "calendar" | "activity";
export type LibraryTab = Extract<MediaTab, "movies" | "tv">;
export type MediaCollection = "all" | "recent" | "unwatched" | "missing" | "ready" | "needs-conversion";
export type ActivitySection = "all" | "continue" | "watchlist" | "requests" | "wanted";
export type MediaSortKey = "added-desc" | "added-asc" | "title-asc" | "title-desc" | "year-desc" | "year-asc";
export type MovieHealth = "ready" | "needs-conversion";

export interface MediaViewState {
  tab: MediaTab;
  /** URL key `view`; only meaningful on movies and tv. */
  collection: MediaCollection;
  /** Only meaningful on activity. */
  section: ActivitySection;
  genres: string[];
  minRating: number | null;
  search: string;
  sort: MediaSortKey;
}

/** The parts of a view the window sidebar navigates between. */
export interface MediaLocation {
  tab: MediaTab;
  collection: MediaCollection;
  section: ActivitySection;
}

export const MEDIA_TABS: readonly MediaTab[] = ["movies", "tv", "downloads", "calendar", "activity"];
export const MEDIA_COLLECTIONS: readonly MediaCollection[] = ["all", "recent", "unwatched", "missing", "ready", "needs-conversion"];
export const ACTIVITY_SECTIONS: readonly ActivitySection[] = ["all", "continue", "watchlist", "requests", "wanted"];
export const MEDIA_SORT_KEYS: readonly MediaSortKey[] = ["added-desc", "added-asc", "title-asc", "title-desc", "year-desc", "year-asc"];
/** The minimum ratings the Rating select offers. */
export const RATING_OPTIONS: readonly number[] = [6, 7, 8, 9];

/** Collections that exist for each library tab. TV has no file or watch data per show. */
const TAB_COLLECTIONS: Record<LibraryTab, readonly MediaCollection[]> = {
  movies: MEDIA_COLLECTIONS,
  tv: ["all", "recent"],
};

export const RECENT_DAYS = 30;
const RECENT_MS = RECENT_DAYS * 24 * 60 * 60 * 1000;

export const DEFAULT_MEDIA_VIEW_STATE: MediaViewState = {
  tab: "movies",
  collection: "all",
  section: "all",
  genres: [],
  minRating: null,
  search: "",
  sort: "added-desc",
};

export function isLibraryTab(tab: MediaTab): tab is LibraryTab {
  return tab === "movies" || tab === "tv";
}

export function collectionsForTab(tab: LibraryTab): readonly MediaCollection[] {
  return TAB_COLLECTIONS[tab];
}

// ── URL ───────────────────────────────────────────────────────────────────────

type ParamsLike = Pick<URLSearchParams, "get" | "getAll">;

function toParams(input: ParamsLike | string): ParamsLike {
  return typeof input === "string" ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input) : input;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * Reads a view from the URL. Unknown or out-of-place values fall back to the
 * defaults, so old and hand-written links (`?tab=tv&genre=Drama`,
 * `?tab=movies&q=Title`, the Continue watching fallback's `?search=`) keep
 * working. `cinema` is not part of the view; see `hasCinemaParam`.
 */
export function parseMediaViewState(input: ParamsLike | string): MediaViewState {
  const params = toParams(input);
  const tab = oneOf(params.get("tab"), MEDIA_TABS) ?? DEFAULT_MEDIA_VIEW_STATE.tab;
  const state: MediaViewState = { ...DEFAULT_MEDIA_VIEW_STATE, genres: [] };
  state.tab = tab;

  if (isLibraryTab(tab)) {
    state.collection = oneOf(params.get("view"), collectionsForTab(tab)) ?? "all";
    const seen = new Set<string>();
    for (const raw of params.getAll("genre")) {
      const genre = raw.trim();
      if (genre && !seen.has(genre)) {
        seen.add(genre);
        state.genres.push(genre);
      }
    }
    const rating = Number(params.get("rating"));
    state.minRating = params.get("rating") !== null && RATING_OPTIONS.includes(rating) ? rating : null;
    const search = params.get("q") ?? params.get("search") ?? "";
    state.search = search.trim() ? search : "";
    state.sort = oneOf(params.get("sort"), MEDIA_SORT_KEYS) ?? DEFAULT_MEDIA_VIEW_STATE.sort;
  } else if (tab === "activity") {
    state.section = oneOf(params.get("section"), ACTIVITY_SECTIONS) ?? "all";
  }
  return state;
}

/**
 * Writes a view as a query string (without "?"). Defaults and keys that do
 * not apply to the tab are left out, and `cinema` is never written, so the
 * URL stays short and a reload never reopens Cinema.
 */
export function serializeMediaViewState(state: MediaViewState): string {
  const params = new URLSearchParams();
  if (state.tab !== DEFAULT_MEDIA_VIEW_STATE.tab) params.set("tab", state.tab);
  if (isLibraryTab(state.tab)) {
    if (state.collection !== "all" && collectionsForTab(state.tab).includes(state.collection)) {
      params.set("view", state.collection);
    }
    const seen = new Set<string>();
    for (const genre of state.genres) {
      const value = genre.trim();
      if (value && !seen.has(value)) {
        seen.add(value);
        params.append("genre", value);
      }
    }
    if (state.minRating !== null && RATING_OPTIONS.includes(state.minRating)) {
      params.set("rating", String(state.minRating));
    }
    if (state.search.trim()) params.set("q", state.search);
    if (state.sort !== DEFAULT_MEDIA_VIEW_STATE.sort) params.set("sort", state.sort);
  } else if (state.tab === "activity" && state.section !== "all") {
    params.set("section", state.section);
  }
  return params.toString();
}

/** `?cinema=1` opens Cinema once (a bookmarkable projector link). */
export function hasCinemaParam(input: ParamsLike | string): boolean {
  return toParams(input).get("cinema") === "1";
}

/** Query keys this view owns; anything else in the URL is left alone. */
export const MEDIA_VIEW_PARAM_KEYS: readonly string[] = ["tab", "view", "section", "genre", "rating", "q", "search", "sort", "cinema"];

// ── Movie health (optimization scan) ─────────────────────────────────────────

/** Lower-cased file name without its extension: scan results are keyed by it. */
export function fileStem(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.substring(0, dot) : name).toLowerCase();
}

/**
 * Whether a movie's file plays directly in the browser, from the scan cache
 * (ffmpeg ground truth) and finished conversion jobs. Null when not scanned.
 */
export function movieHealth(
  item: Pick<MediaItem, "hasFile" | "filePath">,
  jobsByStem: ReadonlyMap<string, { status: string }>,
  scanByStem: Readonly<Record<string, { needsOptimization: boolean }>>,
): MovieHealth | null {
  if (!item.hasFile || !item.filePath) return null;
  const stem = fileStem(item.filePath);
  if (jobsByStem.get(stem)?.status === "completed") return "ready";
  const entry = scanByStem[stem];
  if (!entry) return null;
  return entry.needsOptimization ? "needs-conversion" : "ready";
}

// ── Collections and filters ──────────────────────────────────────────────────

export interface CollectionContext {
  /** Injected clock, in ms since the epoch. */
  now: number;
  /** Plex watch status by `tmdb:<id>`; null when Plex watch status is not configured. */
  watchStatus: Readonly<Record<string, "watched" | "in-progress">> | null;
  /** Movie scan health; null until scan results have loaded. */
  health: ((item: MediaItem) => MovieHealth | null) | null;
}

export type CollectionCounts = Partial<Record<MediaCollection, number>>;

/** Collections that can be computed for this tab with the data at hand. */
export function availableCollections(tab: LibraryTab, ctx: Pick<CollectionContext, "watchStatus" | "health">): MediaCollection[] {
  return collectionsForTab(tab).filter((collection) => {
    if (collection === "unwatched") return ctx.watchStatus !== null;
    if (collection === "ready" || collection === "needs-conversion") return ctx.health !== null;
    return true;
  });
}

export function matchesCollection(item: MediaItem, collection: MediaCollection, ctx: CollectionContext): boolean {
  switch (collection) {
    case "all":
      return true;
    case "recent": {
      const added = Date.parse(item.added ?? "");
      return Number.isFinite(added) && ctx.now - added <= RECENT_MS;
    }
    case "unwatched":
      // Movies only: Plex watch status is per title, and a show is never simply "watched".
      return item.type === "movie"
        && ctx.watchStatus !== null
        && !!item.hasFile
        && item.tmdbId != null
        && ctx.watchStatus[`tmdb:${item.tmdbId}`] !== "watched";
    case "missing":
      // Announced and in-cinema titles can't have a file yet, so they are not missing.
      return item.type === "movie" && item.monitored === true && !item.hasFile && item.status === "released";
    case "ready":
    case "needs-conversion":
      return item.type === "movie" && ctx.health !== null && ctx.health(item) === collection;
  }
}

export function collectionCounts(items: readonly MediaItem[], tab: LibraryTab, ctx: CollectionContext): CollectionCounts {
  const collections = availableCollections(tab, ctx);
  const counts: CollectionCounts = {};
  for (const collection of collections) counts[collection] = 0;
  for (const item of items) {
    for (const collection of collections) {
      if (matchesCollection(item, collection, ctx)) counts[collection]! += 1;
    }
  }
  return counts;
}

export interface LibraryFilters {
  search: string;
  genres: readonly string[];
  minRating: number | null;
  collection: MediaCollection;
}

/** Every filter must match (AND): collection, search, every selected genre and the rating. */
export function filterLibrary(items: readonly MediaItem[], filters: LibraryFilters, ctx: CollectionContext): MediaItem[] {
  const query = filters.search.trim().toLocaleLowerCase();
  const { genres, minRating, collection } = filters;
  return items.filter((item) => {
    if (query && !item.title.toLocaleLowerCase().includes(query)) return false;
    if (genres.length > 0) {
      const own = item.genres ?? [];
      for (const genre of genres) if (!own.includes(genre)) return false;
    }
    if (minRating !== null && !(typeof item.rating === "number" && item.rating >= minRating)) return false;
    return matchesCollection(item, collection, ctx);
  });
}

/** Genres with how many titles carry each, most common first, then by name. */
export function genreCounts(items: readonly MediaItem[]): { genre: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const genres = item.genres;
    if (!genres) continue;
    for (const genre of genres) {
      if (genre) counts.set(genre, (counts.get(genre) ?? 0) + 1);
    }
  }
  const collator = new Intl.Collator(undefined, { sensitivity: "base" });
  return Array.from(counts, ([genre, count]) => ({ genre, count }))
    .sort((a, b) => b.count - a.count || collator.compare(a.genre, b.genre));
}

/** Sorted copy; keys are computed once per item so large libraries sort quickly. */
export function sortLibrary(items: readonly MediaItem[], sort: MediaSortKey): MediaItem[] {
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  const decorated = items.map((item) => ({
    item,
    added: Date.parse(item.added ?? "") || 0,
    year: item.year ?? 0,
  }));
  decorated.sort((a, b) => {
    switch (sort) {
      case "title-asc": return collator.compare(a.item.title, b.item.title);
      case "title-desc": return collator.compare(b.item.title, a.item.title);
      case "year-desc": return b.year - a.year;
      case "year-asc": return a.year - b.year;
      case "added-asc": return a.added - b.added;
      case "added-desc":
      default: return b.added - a.added;
    }
  });
  return decorated.map((entry) => entry.item);
}

// ── Copy ──────────────────────────────────────────────────────────────────────

export const SORT_LABELS: Record<MediaSortKey, string> = {
  "added-desc": "Date added, newest",
  "added-asc": "Date added, oldest",
  "title-asc": "Title, A to Z",
  "title-desc": "Title, Z to A",
  "year-desc": "Year, newest",
  "year-asc": "Year, oldest",
};

export const COLLECTION_LABELS: Record<Exclude<MediaCollection, "all">, string> = {
  recent: "Recently added",
  unwatched: "Unwatched",
  missing: "Missing file",
  ready: "Ready to play",
  "needs-conversion": "Needs conversion",
};

export const SECTION_LABELS: Record<Exclude<ActivitySection, "all">, string> = {
  continue: "Continue watching",
  watchlist: "Watchlist",
  requests: "Requests",
  wanted: "Wanted",
};

export const TAB_LABELS: Record<MediaTab, string> = {
  movies: "Movies",
  tv: "TV shows",
  downloads: "Downloads",
  calendar: "Calendar",
  activity: "Activity",
};

/** "All movies" / "All shows", the classic Show select's first option. */
export function allCollectionLabel(tab: LibraryTab): string {
  return tab === "movies" ? "All movies" : "All shows";
}

export function collectionLabel(tab: LibraryTab, collection: MediaCollection): string {
  return collection === "all" ? allCollectionLabel(tab) : COLLECTION_LABELS[collection];
}

/** The window heading: where you are, in the sidebar's words. */
export function viewTitle(state: Pick<MediaViewState, "tab" | "collection" | "section">): string {
  if (isLibraryTab(state.tab)) {
    return state.collection === "all" ? TAB_LABELS[state.tab] : COLLECTION_LABELS[state.collection];
  }
  if (state.tab === "activity" && state.section !== "all") return SECTION_LABELS[state.section];
  return TAB_LABELS[state.tab];
}

const COLLECTION_PHRASES: Record<Exclude<MediaCollection, "all">, string> = {
  recent: `added in the last ${RECENT_DAYS} days`,
  unwatched: "not watched yet",
  missing: "released without a file",
  ready: "ready to play in the browser",
  "needs-conversion": "to convert for browser playback",
};

export interface ViewSummaryFacts {
  /** Titles or rows on screen after filters; null or undefined while loading. */
  shown?: number | null;
  /** Before search, genre and rating filters (the collection's size). */
  total?: number | null;
  /** Downloads that need you. */
  attention?: number | null;
}

/**
 * One muted line under the window heading. Null while the numbers are not
 * known: a summary never shows a placeholder count.
 */
export function viewSummary(
  state: Pick<MediaViewState, "tab" | "collection" | "section" | "search" | "genres" | "minRating">,
  facts: ViewSummaryFacts,
  nf: Intl.NumberFormat = new Intl.NumberFormat(),
): string | null {
  const { total, shown, attention } = facts;
  if (isLibraryTab(state.tab)) {
    if (total == null || shown == null) return null;
    const noun = (n: number) => (state.tab === "movies" ? (n === 1 ? "movie" : "movies") : n === 1 ? "show" : "shows");
    const filtered = state.search.trim() !== "" || state.genres.length > 0 || state.minRating !== null;
    const count = filtered && shown !== total ? `${nf.format(shown)} of ${nf.format(total)} ${noun(total)}` : `${nf.format(shown)} ${noun(shown)}`;
    return state.collection === "all" ? count : `${count} ${COLLECTION_PHRASES[state.collection]}`;
  }
  if (total == null) return null;
  switch (state.tab) {
    case "downloads": {
      if (total === 0) return "Nothing in the queue";
      const parts = [`${nf.format(total)} in the queue`];
      if (attention) parts.push(`${nf.format(attention)} ${attention === 1 ? "needs" : "need"} attention`);
      return parts.join(" · ");
    }
    case "calendar":
      return total === 0
        ? "Nothing in the next 14 days"
        : `${nf.format(total)} ${total === 1 ? "release" : "releases"} in the next 14 days`;
    case "activity":
      switch (state.section) {
        case "continue": return `${nf.format(total)} in progress`;
        case "watchlist": return `${nf.format(total)} on your watchlist`;
        case "requests": return `${nf.format(total)} awaiting approval`;
        case "wanted": return `${nf.format(total)} wanted`;
        default: return null;
      }
  }
  return null;
}
