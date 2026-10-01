import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "@/components/media/media-detail-sheet";
import type { MediaLocation } from "@/components/media/media-library-view";

type Swr<T> = { data?: T; error?: unknown; isLoading?: boolean };

const DAY = 24 * 60 * 60 * 1000;

const state = vi.hoisted(() => ({
  library: {} as Swr<{ movies: MediaItem[]; tv: MediaItem[] }>,
  watchStatus: {} as Swr<{ configured: boolean; watchStatus: Record<string, "watched" | "in-progress"> }>,
  healthOf: null as null | ((item: MediaItem) => "ready" | "needs-conversion" | null),
  calendar: {} as Swr<{ episodes: unknown[]; movies: unknown[] }>,
  wanted: { sonarr: {}, radarr: {} } as Record<"sonarr" | "radarr", Swr<{ records: unknown[]; totalRecords?: number; available?: boolean }>>,
  requests: {} as Swr<{ configured?: boolean; results: { status: number }[] }>,
  watchlist: {} as Swr<{ configured: boolean; items: unknown[] }>,
  watching: {} as Swr<{ configured: boolean; continueWatching?: unknown[] }>,
  downloads: {
    data: undefined as unknown,
    activity: { counts: { attention: 0 }, activeCount: 0, pendingCount: 0 },
  },
}));

vi.mock("@/components/media/media-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/media/media-data")>();
  return {
    ...actual,
    useMediaLibrary: () => state.library,
    usePlexWatchStatus: () => state.watchStatus,
    useMovieHealth: () => ({ healthOf: state.healthOf, jobsByStem: new Map(), counts: { scanned: 0, ready: 0, needsConversion: 0 }, mutateScan: vi.fn() }),
    useMediaCalendar: () => state.calendar,
    useMediaWanted: (app: "sonarr" | "radarr") => state.wanted[app],
    useMediaRequests: () => state.requests,
    usePlexWatchlist: () => state.watchlist,
    usePlexWatching: () => state.watching,
  };
});

vi.mock("@/hooks/use-downloads", () => ({
  useDownloads: () => state.downloads,
}));

import { MediaWindowSidebar, TOP_GENRES } from "@/components/media/media-window-sidebar";

function movie(id: number, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    title: `Movie ${id}`,
    type: "movie",
    tmdbId: id,
    hasFile: true,
    monitored: true,
    status: "released",
    added: new Date(Date.now() - 100 * DAY).toISOString(),
    genres: ["Drama"],
    ...overrides,
  };
}

const HOME: MediaLocation = { tab: "movies", collection: "all", section: "all" };

function renderSidebar(location: MediaLocation = HOME, genres: string[] = []) {
  const onNavigate = vi.fn();
  const onGenresChange = vi.fn();
  const utils = render(
    <MediaWindowSidebar
      location={location}
      libraryTab={location.tab === "tv" ? "tv" : "movies"}
      genres={genres}
      onNavigate={onNavigate}
      onGenresChange={onGenresChange}
    />,
  );
  return { ...utils, onNavigate, onGenresChange };
}

const row = (name: string | RegExp) => screen.getByRole("button", { name });
const currentRows = () => screen.getAllByRole("button").filter((b) => b.getAttribute("aria-current") === "page");

beforeEach(() => {
  state.library = {
    data: {
      movies: [
        movie(1, { added: new Date(Date.now() - 2 * DAY).toISOString() }),
        movie(2, { hasFile: false }),
        movie(3),
      ],
      tv: [{ id: 10, title: "Show", type: "tv", genres: ["Mystery"] }],
    },
  };
  state.watchStatus = { data: { configured: false, watchStatus: {} } };
  state.healthOf = null;
  state.calendar = { data: { episodes: [{}, {}], movies: [{}] } };
  state.wanted = {
    sonarr: { data: { records: [], totalRecords: 120 } },
    radarr: { data: { records: [], totalRecords: 30 } },
  };
  state.requests = { data: { configured: false, results: [] } };
  state.watchlist = { data: { configured: false, items: [] } };
  state.watching = { data: { configured: false } };
  state.downloads = { data: { queue: [], torrents: [] }, activity: { counts: { attention: 0 }, activeCount: 0, pendingCount: 0 } };
});

describe("Media window sidebar", () => {
  it("is a labelled source list with library counts", () => {
    renderSidebar();
    const nav = screen.getByRole("navigation", { name: "Media" });
    expect(within(nav).getByText("Library")).toBeInTheDocument();
    expect(row(/^Movies/)).toHaveTextContent("3");
    expect(row(/^TV shows/)).toHaveTextContent("1");
    expect(row(/^Calendar/)).toHaveTextContent("3");
    expect(row(/^Wanted/)).toHaveTextContent("150");
  });

  it("shows Watching and Requests only when Plex and Overseerr are configured", () => {
    const { rerender } = renderSidebar();
    expect(screen.queryByText("Watching")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Requests/ })).toBeNull();

    state.watching = { data: { configured: true, continueWatching: [{}, {}] } };
    state.watchlist = { data: { configured: true, items: [{}] } };
    state.requests = { data: { configured: true, results: [{ status: 1 }, { status: 1 }, { status: 2 }] } };
    rerender(<MediaWindowSidebar location={HOME} libraryTab="movies" genres={[]} onNavigate={vi.fn()} onGenresChange={vi.fn()} />);

    expect(screen.getByText("Watching")).toBeInTheDocument();
    expect(row(/^Continue watching/)).toHaveTextContent("2");
    expect(row(/^Watchlist/)).toHaveTextContent("1");
    const requests = row(/^Requests/);
    // Pending approvals are the solid amber "needs you" count
    expect(within(requests).getByText("2").closest("[data-variant='count']")).not.toBeNull();
    // jsdom joins inline text without spaces; browsers space the row's flex items
    expect(requests).toHaveAccessibleName(/2\s*awaiting approval/);
  });

  it("gives Downloads the needs-you count, a working dot, or a plain count", () => {
    state.downloads = { data: {}, activity: { counts: { attention: 2 }, activeCount: 1, pendingCount: 5 } };
    const { rerender } = renderSidebar();
    expect(row(/^Downloads/)).toHaveAccessibleName(/2\s*need attention/);
    expect(row(/^Downloads/).querySelector("[data-variant='count']")).not.toBeNull();

    state.downloads = { data: {}, activity: { counts: { attention: 0 }, activeCount: 1, pendingCount: 5 } };
    rerender(<MediaWindowSidebar location={HOME} libraryTab="movies" genres={[]} onNavigate={vi.fn()} onGenresChange={vi.fn()} />);
    expect(row(/^Downloads/).querySelector("[data-slot='status-dot'][data-state='working']")).not.toBeNull();
    expect(row(/^Downloads/)).toHaveTextContent("5");

    state.downloads = { data: {}, activity: { counts: { attention: 0 }, activeCount: 0, pendingCount: 4 } };
    rerender(<MediaWindowSidebar location={HOME} libraryTab="movies" genres={[]} onNavigate={vi.fn()} onGenresChange={vi.fn()} />);
    expect(row(/^Downloads/).querySelector("[data-slot='status-dot']")).toBeNull();
    expect(row(/^Downloads/)).toHaveTextContent("4");

    // Still loading: no count at all, never a 0
    state.downloads = { data: undefined, activity: { counts: { attention: 0 }, activeCount: 0, pendingCount: 0 } };
    rerender(<MediaWindowSidebar location={HOME} libraryTab="movies" genres={[]} onNavigate={vi.fn()} onGenresChange={vi.fn()} />);
    expect(row(/^Downloads/)).toHaveTextContent(/^Downloads$/);
  });

  it("hides collections while loading or errored, and empty ones unless current", () => {
    state.library = {};
    const { rerender } = renderSidebar();
    expect(screen.queryByText("Collections")).toBeNull();
    expect(row(/^Movies/)).toHaveTextContent(/^Movies$/);

    state.library = { data: { movies: [movie(1)], tv: [] }, error: new Error("refresh failed") };
    rerender(<MediaWindowSidebar location={HOME} libraryTab="movies" genres={[]} onNavigate={vi.fn()} onGenresChange={vi.fn()} />);
    expect(screen.queryByText("Collections")).toBeNull();

    state.library = {
      data: {
        movies: [movie(1, { added: new Date(Date.now() - 2 * DAY).toISOString() }), movie(2, { hasFile: false })],
        tv: [],
      },
    };
    rerender(<MediaWindowSidebar location={HOME} libraryTab="movies" genres={[]} onNavigate={vi.fn()} onGenresChange={vi.fn()} />);
    expect(row(/^Recently added/)).toHaveTextContent("1");
    expect(row(/^Missing file/)).toHaveTextContent("1");
    // Plex isn't configured and nothing is scanned: no invented counts
    expect(screen.queryByRole("button", { name: /^Unwatched/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Needs conversion/ })).toBeNull();

    // An empty collection stays listed while it is the current view
    state.library = { data: { movies: [movie(1)], tv: [] } };
    rerender(<MediaWindowSidebar location={{ ...HOME, collection: "missing" }} libraryTab="movies" genres={[]} onNavigate={vi.fn()} onGenresChange={vi.fn()} />);
    expect(row(/^Missing file/)).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: /^Recently added/ })).toBeNull();
  });

  it("marks exactly one location row as current", () => {
    state.watching = { data: { configured: true, continueWatching: [] } };
    state.watchlist = { data: { configured: true, items: [] } };
    state.requests = { data: { configured: true, results: [] } };
    const locations: MediaLocation[] = [
      HOME,
      { tab: "tv", collection: "all", section: "all" },
      { tab: "movies", collection: "recent", section: "all" },
      { tab: "movies", collection: "ready", section: "all" },
      { tab: "downloads", collection: "all", section: "all" },
      { tab: "calendar", collection: "all", section: "all" },
      { tab: "activity", collection: "all", section: "all" },
      { tab: "activity", collection: "all", section: "continue" },
      { tab: "activity", collection: "all", section: "watchlist" },
      { tab: "activity", collection: "all", section: "requests" },
      { tab: "activity", collection: "all", section: "wanted" },
    ];
    for (const location of locations) {
      const { unmount } = renderSidebar(location, ["Drama"]);
      expect(currentRows(), JSON.stringify(location)).toHaveLength(1);
      unmount();
    }
  });

  it("navigates from location rows", () => {
    const { onNavigate } = renderSidebar();
    fireEvent.click(row(/^Recently added/));
    expect(onNavigate).toHaveBeenLastCalledWith({ tab: "movies", collection: "recent", section: "all" });
    fireEvent.click(row(/^Wanted/));
    expect(onNavigate).toHaveBeenLastCalledWith({ tab: "activity", collection: "all", section: "wanted" });
    fireEvent.click(row(/^TV shows/));
    expect(onNavigate).toHaveBeenLastCalledWith({ tab: "tv", collection: "all", section: "all" });
  });

  it("selects and clears genres with pressed filter rows", () => {
    const { onGenresChange, rerender } = renderSidebar();
    expect(row("All genres")).toHaveAttribute("aria-pressed", "true");
    expect(row(/^Drama/)).toHaveAttribute("aria-pressed", "false");
    expect(row(/^Drama/)).not.toHaveAttribute("aria-current");
    fireEvent.click(row(/^Drama/));
    expect(onGenresChange).toHaveBeenLastCalledWith(["Drama"]);

    rerender(<MediaWindowSidebar location={HOME} libraryTab="movies" genres={["Drama"]} onNavigate={vi.fn()} onGenresChange={onGenresChange} />);
    expect(row(/^Drama/)).toHaveAttribute("aria-pressed", "true");
    expect(row("All genres")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(row(/^Drama/));
    expect(onGenresChange).toHaveBeenLastCalledWith([]);
    fireEvent.click(row("All genres"));
    expect(onGenresChange).toHaveBeenLastCalledWith([]);
  });

  it("lists the top genres, then all of them on request", () => {
    const names = Array.from({ length: 12 }, (_, i) => `Genre ${String.fromCharCode(65 + i)}`);
    state.library = {
      data: {
        // Genre A on 12 titles, B on 11, … L on 1: a clear order by count
        movies: names.flatMap((name, i) => Array.from({ length: 12 - i }, (_, j) => movie(i * 100 + j, { genres: [name] }))),
        tv: [],
      },
    };
    renderSidebar(HOME, ["Genre L"]);
    expect(row(/^Genre A/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Genre I/ })).toBeNull();
    // A selected genre stays reachable outside the top list
    expect(row(/^Genre L/)).toHaveAttribute("aria-pressed", "true");

    const toggle = row("Show all 12 genres");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(row(/^Genre I/)).toBeInTheDocument();
    expect(row("Show fewer")).toHaveAttribute("aria-expanded", "true");
    expect(TOP_GENRES).toBe(8);
  });

  it("shows genres only on Movies and TV shows", () => {
    renderSidebar({ tab: "downloads", collection: "all", section: "all" });
    expect(screen.queryByText("Genres")).toBeNull();
  });
});
