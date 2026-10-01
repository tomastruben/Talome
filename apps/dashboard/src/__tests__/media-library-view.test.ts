import { describe, expect, it } from "vitest";
import type { MediaItem } from "@/components/media/media-detail-sheet";
import {
  DEFAULT_MEDIA_VIEW_STATE,
  collectionCounts,
  fileStem,
  filterLibrary,
  genreCounts,
  hasCinemaParam,
  movieHealth,
  parseMediaViewState,
  serializeMediaViewState,
  sortLibrary,
  viewSummary,
  viewTitle,
  type CollectionContext,
  type MediaViewState,
} from "@/components/media/media-library-view";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-01T12:00:00Z");

function movie(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 1,
    title: "Arrival",
    type: "movie",
    year: 2016,
    tmdbId: 329865,
    hasFile: true,
    monitored: true,
    status: "released",
    genres: ["Drama", "Science Fiction"],
    rating: 7.9,
    added: new Date(NOW - 100 * DAY).toISOString(),
    filePath: "/movies/Arrival (2016)/Arrival.mkv",
    ...overrides,
  };
}

function show(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 10,
    title: "Severance",
    type: "tv",
    year: 2022,
    genres: ["Drama", "Mystery"],
    rating: 8.7,
    added: new Date(NOW - 5 * DAY).toISOString(),
    ...overrides,
  };
}

const ctx = (overrides: Partial<CollectionContext> = {}): CollectionContext => ({
  now: NOW,
  watchStatus: {},
  health: null,
  ...overrides,
});

const state = (overrides: Partial<MediaViewState> = {}): MediaViewState => ({
  ...DEFAULT_MEDIA_VIEW_STATE,
  genres: [],
  ...overrides,
});

describe("media view URL", () => {
  it("writes nothing for the default view", () => {
    expect(serializeMediaViewState(state())).toBe("");
    expect(parseMediaViewState("")).toEqual(state());
  });

  it("round-trips every key", () => {
    const view = state({
      tab: "movies",
      collection: "recent",
      genres: ["Drama", "Action"],
      minRating: 7,
      search: "dune",
      sort: "title-asc",
    });
    const query = serializeMediaViewState(view);
    expect(query).toBe("view=recent&genre=Drama&genre=Action&rating=7&q=dune&sort=title-asc");
    expect(parseMediaViewState(query)).toEqual(view);

    const activity = state({ tab: "activity", section: "wanted" });
    expect(serializeMediaViewState(activity)).toBe("tab=activity&section=wanted");
    expect(parseMediaViewState("tab=activity&section=wanted")).toEqual(activity);
  });

  it("keeps genre order and drops duplicates and blanks", () => {
    const parsed = parseMediaViewState("tab=tv&genre=Mystery&genre=Drama&genre=Mystery&genre=");
    expect(parsed.genres).toEqual(["Mystery", "Drama"]);
    expect(serializeMediaViewState(parsed)).toBe("tab=tv&genre=Mystery&genre=Drama");
  });

  it("falls back to defaults for invalid or out-of-place values", () => {
    expect(parseMediaViewState("tab=nope&view=bogus&rating=7.5&sort=random")).toEqual(state());
    // TV has no file or watch data, so movie-only collections don't apply
    expect(parseMediaViewState("tab=tv&view=missing").collection).toBe("all");
    // Search, genres and collections belong to the library tabs only
    expect(parseMediaViewState("tab=downloads&q=x&genre=Drama&view=recent")).toEqual(state({ tab: "downloads" }));
    // A section belongs to Activity only
    expect(parseMediaViewState("tab=calendar&section=wanted").section).toBe("all");
    expect(parseMediaViewState("tab=activity&section=nope").section).toBe("all");
    expect(serializeMediaViewState(state({ tab: "downloads", search: "x", genres: ["Drama"], section: "wanted" }))).toBe("tab=downloads");
  });

  it("keeps existing deep links working", () => {
    expect(parseMediaViewState("tab=movies&q=Send+Help")).toEqual(state({ search: "Send Help" }));
    expect(parseMediaViewState("tab=tv&genre=Drama")).toEqual(state({ tab: "tv", genres: ["Drama"] }));
    expect(parseMediaViewState("tab=downloads").tab).toBe("downloads");
    // The Continue watching fallback route writes `search`
    expect(parseMediaViewState("tab=tv&search=Severance").search).toBe("Severance");
  });

  it("never writes cinema, and reads it only as a one-off", () => {
    const parsed = parseMediaViewState("cinema=1&tab=tv");
    expect(serializeMediaViewState(parsed)).toBe("tab=tv");
    expect(hasCinemaParam("cinema=1")).toBe(true);
    expect(hasCinemaParam("?cinema=1")).toBe(true);
    expect(hasCinemaParam("cinema=0")).toBe(false);
  });
});

describe("collections", () => {
  it("counts recent as the last 30 days (29 in, 31 out)", () => {
    const items = [
      movie({ id: 1, added: new Date(NOW - 29 * DAY).toISOString() }),
      movie({ id: 2, added: new Date(NOW - 31 * DAY).toISOString() }),
      movie({ id: 3, added: undefined }),
    ];
    expect(collectionCounts(items, "movies", ctx()).recent).toBe(1);
  });

  it("counts unwatched movies only when Plex watch status is configured", () => {
    const items = [
      movie({ id: 1, tmdbId: 1 }),
      movie({ id: 2, tmdbId: 2 }),
      movie({ id: 3, tmdbId: 3 }),
      movie({ id: 4, tmdbId: 4, hasFile: false }),
      movie({ id: 5, tmdbId: null }),
    ];
    const watchStatus = { "tmdb:1": "watched", "tmdb:2": "in-progress" } as const;
    // 2 is in progress (not finished) and 3 never started; 4 has no file; 5 can't be matched
    expect(collectionCounts(items, "movies", ctx({ watchStatus })).unwatched).toBe(2);
    expect(collectionCounts(items, "movies", ctx({ watchStatus: null }))).not.toHaveProperty("unwatched");
    // TV never has an unwatched collection
    expect(collectionCounts([show()], "tv", ctx({ watchStatus }))).toEqual({ all: 1, recent: 1 });
  });

  it("counts missing as monitored, released and without a file", () => {
    const items = [
      movie({ id: 1, hasFile: false }),
      movie({ id: 2, hasFile: false, status: "announced" }),
      movie({ id: 3, hasFile: false, status: "inCinemas" }),
      movie({ id: 4, hasFile: false, monitored: false }),
      movie({ id: 5, hasFile: true }),
    ];
    expect(collectionCounts(items, "movies", ctx()).missing).toBe(1);
  });

  it("derives ready and needs conversion from the scan cache and finished jobs", () => {
    const jobs = new Map([["converted", { status: "completed" }]]);
    const scan = {
      direct: { needsOptimization: false },
      mkvfile: { needsOptimization: true },
      converted: { needsOptimization: true },
    };
    const health = (item: MediaItem) => movieHealth(item, jobs, scan);
    const items = [
      movie({ id: 1, filePath: "/m/Direct.mp4" }),
      movie({ id: 2, filePath: "/m/MkvFile.mkv" }),
      movie({ id: 3, filePath: "/m/converted.mkv" }),
      movie({ id: 4, filePath: "/m/unscanned.mkv" }),
      movie({ id: 5, hasFile: false, filePath: null }),
    ];
    const counts = collectionCounts(items, "movies", ctx({ health }));
    expect(counts.ready).toBe(2);
    expect(counts["needs-conversion"]).toBe(1);
    expect(collectionCounts(items, "movies", ctx({ health: null }))).not.toHaveProperty("ready");
    expect(fileStem("/a/B.C.mkv")).toBe("b.c");
  });
});

describe("filterLibrary", () => {
  const items = [
    movie({ id: 1, title: "Arrival", genres: ["Drama", "Science Fiction"], rating: 7.9 }),
    movie({ id: 2, title: "Dune", genres: ["Science Fiction", "Adventure"], rating: 8.0, added: new Date(NOW - DAY).toISOString() }),
    movie({ id: 3, title: "Dune: Part Two", genres: ["Science Fiction"], rating: 8.5 }),
    movie({ id: 4, title: "Drive", genres: ["Drama"], rating: null }),
  ];
  const ids = (list: MediaItem[]) => list.map((m) => m.id);

  it("combines every filter with AND", () => {
    const base = { search: "", genres: [] as string[], minRating: null, collection: "all" as const };
    expect(ids(filterLibrary(items, { ...base, search: "DUNE" }, ctx()))).toEqual([2, 3]);
    expect(ids(filterLibrary(items, { ...base, genres: ["Science Fiction", "Drama"] }, ctx()))).toEqual([1]);
    expect(ids(filterLibrary(items, { ...base, minRating: 8 }, ctx()))).toEqual([2, 3]);
    expect(ids(filterLibrary(items, { ...base, search: "dune", minRating: 8, collection: "recent" }, ctx()))).toEqual([2]);
    expect(ids(filterLibrary(items, { ...base, search: "dune", genres: ["Drama"] }, ctx()))).toEqual([]);
  });

  it("sorts with keys computed once", () => {
    expect(ids(sortLibrary(items, "title-asc"))).toEqual([1, 4, 2, 3]);
    expect(ids(sortLibrary(items, "added-desc"))[0]).toBe(2);
  });
});

describe("genreCounts", () => {
  it("orders by count, then by name", () => {
    const items = [
      movie({ genres: ["Drama", "Action"] }),
      movie({ genres: ["Action"] }),
      movie({ genres: ["Comedy", "Drama"] }),
      movie({ genres: ["Animation"] }),
      movie({ genres: undefined }),
    ];
    expect(genreCounts(items)).toEqual([
      { genre: "Action", count: 2 },
      { genre: "Drama", count: 2 },
      { genre: "Animation", count: 1 },
      { genre: "Comedy", count: 1 },
    ]);
  });

  it("handles a 10,000-title library in under 50ms", () => {
    const pool = ["Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy", "History", "Horror", "Music", "Mystery", "Romance", "Science Fiction", "Thriller", "War", "Western"];
    const items = Array.from({ length: 10_000 }, (_, i) => movie({
      id: i,
      genres: [pool[i % pool.length], pool[(i * 7) % pool.length], pool[(i * 13) % pool.length]],
    }));
    genreCounts(items); // warm up the JIT
    const start = performance.now();
    const result = genreCounts(items);
    expect(performance.now() - start).toBeLessThan(50);
    expect(result).toHaveLength(pool.length);
  });
});

describe("view copy", () => {
  it("titles the view in the sidebar's words", () => {
    expect(viewTitle(state())).toBe("Movies");
    expect(viewTitle(state({ tab: "tv" }))).toBe("TV shows");
    expect(viewTitle(state({ collection: "needs-conversion" }))).toBe("Needs conversion");
    expect(viewTitle(state({ tab: "downloads" }))).toBe("Downloads");
    expect(viewTitle(state({ tab: "activity" }))).toBe("Activity");
    expect(viewTitle(state({ tab: "activity", section: "continue" }))).toBe("Continue watching");
  });

  it("summarises with real numbers only", () => {
    const nf = new Intl.NumberFormat("en-US");
    expect(viewSummary(state(), { total: null, shown: null }, nf)).toBeNull();
    expect(viewSummary(state(), { total: 1234, shown: 1234 }, nf)).toBe("1,234 movies");
    expect(viewSummary(state({ tab: "tv" }), { total: 1, shown: 1 }, nf)).toBe("1 show");
    expect(viewSummary(state({ search: "dune" }), { total: 1234, shown: 3 }, nf)).toBe("3 of 1,234 movies");
    expect(viewSummary(state({ collection: "recent" }), { total: 12, shown: 12 }, nf)).toBe("12 movies added in the last 30 days");
    expect(viewSummary(state({ collection: "missing" }), { total: 2, shown: 2 }, nf)).toBe("2 movies released without a file");
    expect(viewSummary(state({ tab: "downloads" }), { total: 0 }, nf)).toBe("Nothing in the queue");
    expect(viewSummary(state({ tab: "downloads" }), { total: 3, attention: 1 }, nf)).toBe("3 in the queue · 1 needs attention");
    expect(viewSummary(state({ tab: "calendar" }), { total: 1 }, nf)).toBe("1 release in the next 14 days");
    expect(viewSummary(state({ tab: "activity", section: "wanted" }), { total: 2500 }, nf)).toBe("2,500 wanted");
    expect(viewSummary(state({ tab: "activity" }), { total: 4 }, nf)).toBeNull();
  });
});
