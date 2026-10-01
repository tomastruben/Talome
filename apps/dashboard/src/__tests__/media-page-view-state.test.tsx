import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { MediaItem } from "@/components/media/media-detail-sheet";

type Swr = { data: unknown; error: unknown; mutate: ReturnType<typeof vi.fn> };

const h = vi.hoisted(() => {
  const swr = (data: unknown, error?: unknown) => ({ data, error, mutate: vi.fn() });
  return {
    swr,
    /** What Next.js's router holds as the current query: useSearchParams reads it. */
    search: "",
    listeners: new Set<() => void>(),
    params: { type: "movie", id: "1" } as Record<string, string>,
    embedded: false,
    push: vi.fn(),
    cinemaOpen: vi.fn(),
    library: swr(undefined) as { data: unknown; error: unknown; mutate: ReturnType<typeof vi.fn> },
    health: {} as Record<string, unknown>,
    sources: {} as Record<string, { data: unknown; error: unknown; mutate: ReturnType<typeof vi.fn> }>,
  };
});

/** The answers each source gives unless a test says otherwise: answered, nothing configured. */
function defaultSources(): Record<string, Swr> {
  return {
    watchStatus: h.swr({ configured: false, watchStatus: {} }),
    calendar: h.swr({ episodes: [], movies: [] }),
    sonarr: h.swr({ records: [], totalRecords: 0 }),
    radarr: h.swr({ records: [], totalRecords: 0 }),
    requests: h.swr({ configured: false, results: [] }),
    watchlist: h.swr({ configured: false, items: [] }),
    watching: h.swr({ configured: false }),
  };
}

vi.mock("next/navigation", async () => {
  const React = await import("react");
  const subscribe = (listener: () => void) => {
    h.listeners.add(listener);
    return () => { h.listeners.delete(listener); };
  };
  const getSearch = () => h.search;
  return {
    useRouter: () => ({ push: h.push, replace: vi.fn(), back: vi.fn() }),
    useSearchParams: () => {
      const search = React.useSyncExternalStore(subscribe, getSearch, getSearch);
      return React.useMemo(() => new URLSearchParams(search), [search]);
    },
    usePathname: () => "/dashboard/media",
    useParams: () => h.params,
  };
});

vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

vi.mock("@/hooks/use-desktop-mode", () => ({
  useIsEmbeddedFrame: () => h.embedded,
}));

vi.mock("@/hooks/use-feature-stacks", () => ({
  useFeatureStack: () => ({ stack: { readiness: 1 }, isLoading: false }),
}));

vi.mock("@/components/assistant/assistant-context", () => ({
  useAssistant: () => ({ openPaletteInChatMode: vi.fn() }),
}));

const cinema = { open: h.cinemaOpen, close: vi.fn(), isOpen: false, tab: "movies" };
vi.mock("@/components/media/cinema-browser-context", () => ({
  useCinemaBrowser: () => cinema,
}));

vi.mock("@/components/media/cinema-browser-launcher", () => ({
  preloadCinemaBrowser: vi.fn(),
}));

vi.mock("@/components/media/media-detail-sheet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/media/media-detail-sheet")>();
  return { ...actual, UnifiedMediaSheet: () => null };
});

vi.mock("@/hooks/use-downloads", () => ({
  useDownloads: () => ({
    data: { queue: [], torrents: [] },
    torrents: [],
    queue: [],
    totalCount: 0,
    activity: { counts: { attention: 0 }, activeCount: 0, pendingCount: 0 },
    error: undefined,
    retry: vi.fn(),
  }),
}));

vi.mock("@/components/media/media-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/media/media-data")>();
  return {
    ...actual,
    useMediaLibrary: () => h.library,
    useMovieHealth: () => h.health,
    usePlexWatchStatus: () => h.sources.watchStatus,
    useMediaCalendar: () => h.sources.calendar,
    useMediaWanted: (app: "sonarr" | "radarr") => h.sources[app],
    useMediaRequests: () => h.sources.requests,
    usePlexWatchlist: () => h.sources.watchlist,
    usePlexWatching: () => h.sources.watching,
  };
});

// Base UI tabs, reduced to what the page uses: a value, a change callback and tab buttons.
vi.mock("@base-ui/react/tabs", async () => {
  const React = await import("react");
  type Ctx = { value?: unknown; onValueChange?: (value: unknown) => void };
  const TabsContext = React.createContext<Ctx>({});
  function Root({ value, onValueChange, className, children }: Ctx & { className?: string; children?: ReactNode }) {
    return (
      <TabsContext.Provider value={{ value, onValueChange }}>
        <div data-testid="media-tabs" className={className}>{children}</div>
      </TabsContext.Provider>
    );
  }
  function Tab({ value, children, className, id, title, ...rest }: { value: unknown; children?: ReactNode; className?: string; id?: string; title?: string; "aria-label"?: string }) {
    const ctx = React.useContext(TabsContext);
    return (
      <button
        type="button"
        role="tab"
        id={id}
        title={title}
        aria-label={rest["aria-label"]}
        aria-selected={ctx.value === value}
        className={className}
        onClick={() => ctx.onValueChange?.(value)}
      >
        {children}
      </button>
    );
  }
  return {
    Tabs: {
      Root,
      List: ({ children, className }: { children?: ReactNode; className?: string }) => <div role="tablist" className={className}>{children}</div>,
      Tab,
      Panel: ({ children }: { children?: ReactNode }) => <div role="tabpanel">{children}</div>,
      Indicator: () => null,
    },
  };
});

import MediaPage from "@/app/dashboard/media/page";
import MediaDetailPage from "@/app/dashboard/media/[type]/[id]/page";
import { TooltipProvider } from "@/components/ui/tooltip";

function movie(id: number, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    title: id === 1 ? "Arrival" : `Movie ${id}`,
    year: 2016,
    type: "movie",
    hasFile: true,
    monitored: true,
    status: "released",
    genres: ["Drama"],
    added: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const LIBRARY = {
  movies: [movie(1), movie(2)],
  tv: [{ id: 10, title: "Severance", type: "tv" as const, year: 2022, genres: ["Mystery"] }],
  totals: { movies: 2, tvShows: 1 },
  radarrAvailable: true,
  sonarrAvailable: true,
};

const HEALTH_LOADED = {
  healthOf: null,
  jobsByStem: new Map(),
  counts: { scanned: 0, ready: 0, needsConversion: 0 },
  scanPending: false,
  scanError: undefined,
  mutateScan: vi.fn(),
};

// ── Next.js history, as next/dist/client/components/app-router.js patches it ──

let nativeReplaceState: History["replaceState"];
let replaceStateSpy: MockInstance<History["replaceState"]>;

function notifyRouter() {
  for (const listener of h.listeners) listener();
}

/**
 * Next.js 16 patches replaceState: a call whose state carries Next's own
 * `__NA` marker is internal and never reaches the router; any other call gets
 * Next's state copied in and moves the router (so useSearchParams) to the URL.
 */
function installNextHistoryPatch() {
  nativeReplaceState = window.history.replaceState.bind(window.history);
  replaceStateSpy = vi.spyOn(window.history, "replaceState").mockImplementation((data, unused, url) => {
    const state = data as { __NA?: boolean; _N?: boolean } | null;
    if (state?.__NA || state?._N) {
      nativeReplaceState(data, unused, url);
      return;
    }
    nativeReplaceState({ ...(state ?? {}), __NA: true }, unused, url);
    if (url != null) {
      h.search = window.location.search.slice(1);
      notifyRouter();
    }
  });
}

/** A Next.js navigation (a link, the desktop opening the window): Next writes its own entry, then reports the URL. */
function navigate(search: string, pathname = "/dashboard/media") {
  act(() => {
    nativeReplaceState({ __NA: true }, "", `${pathname}${search ? `?${search}` : ""}`);
    h.search = search;
    notifyRouter();
  });
}

const tab = (name: string) => screen.getByRole("tab", { name });
const skeletons = () => document.querySelectorAll('[data-slot="skeleton"]');
const emptyOrErrorState = () => document.querySelector('[data-slot="empty-state"], [data-slot="error-state"]');

/** Lets delayed skeletons (200ms) appear. */
async function passSkeletonDelay() {
  await act(async () => { vi.advanceTimersByTime(250); });
}

beforeEach(() => {
  h.embedded = false;
  h.push.mockReset();
  h.cinemaOpen.mockReset();
  h.library = h.swr(LIBRARY);
  h.health = { ...HEALTH_LOADED };
  h.sources = defaultSources();
  h.params = { type: "movie", id: "1" };
  h.listeners.clear();
  installNextHistoryPatch();
  navigate("");
  try { sessionStorage.clear(); } catch { /* jsdom always has it */ }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Media page view state", () => {
  it("switches tabs without remounting, and Next.js follows the URL it writes", () => {
    render(<MediaPage />);
    const tablist = screen.getByRole("tablist");

    fireEvent.click(tab("TV shows"));

    expect(window.location.search).toBe("?tab=tv");
    // useSearchParams reports the write back (the echo), and the page ignores it
    expect(h.search).toBe("tab=tv");
    expect(screen.getByRole("tablist")).toBe(tablist);
    expect(tab("TV shows")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Severance (2022)" })).toBeInTheDocument();
  });

  it("never writes history with Next.js's internal state", () => {
    render(<MediaPage />);
    fireEvent.click(tab("TV shows"));
    fireEvent.click(tab("Calendar"));

    expect(replaceStateSpy).toHaveBeenCalled();
    for (const [state] of replaceStateSpy.mock.calls) {
      expect(state && typeof state === "object" && "__NA" in state).toBeFalsy();
    }
  });

  it("follows a link back to the URL it left", () => {
    navigate("tab=downloads");
    render(<MediaPage />);
    expect(tab("Downloads")).toHaveAttribute("aria-selected", "true");

    fireEvent.click(tab("Movies"));
    expect(window.location.search).toBe("");
    expect(h.search).toBe("");

    // The Active downloads widget links to ?tab=downloads again
    navigate("tab=downloads");
    expect(tab("Downloads")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Nothing downloading")).toBeInTheDocument();
  });

  it("re-applies the view when the URL changes from outside", () => {
    render(<MediaPage />);
    expect(tab("Movies")).toHaveAttribute("aria-selected", "true");

    navigate("tab=downloads");

    expect(tab("Downloads")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Nothing downloading")).toBeInTheDocument();
  });

  it("opens Cinema once for ?cinema=1 and strips it from the URL", () => {
    navigate("cinema=1&tab=tv");
    const { rerender } = render(<MediaPage />);

    expect(h.cinemaOpen).toHaveBeenCalledTimes(1);
    expect(h.cinemaOpen).toHaveBeenCalledWith("tv");
    expect(window.location.search).toBe("?tab=tv");
    expect(h.search).toBe("tab=tv");

    rerender(<MediaPage />);
    expect(h.cinemaOpen).toHaveBeenCalledTimes(1);
    expect(tab("TV shows")).toHaveAttribute("aria-selected", "true");
  });

  it("saves and restores scroll on the content scroller, not the sidebar", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, writable: true, value: scrollTo });
    sessionStorage.setItem("media-scroll-y", "320");

    render(
      <div>
        <nav aria-label="Media" className="overflow-y-auto" data-testid="sidebar" />
        <div data-content-scroll="" data-testid="scroller">
          <MediaPage />
        </div>
      </div>,
    );
    const scroller = screen.getByTestId("scroller");
    const sidebar = screen.getByTestId("sidebar");

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 320 }));
    expect(scrollTo.mock.contexts[0]).toBe(scroller);
    expect(sessionStorage.getItem("media-scroll-y")).toBeNull();

    Object.defineProperty(scroller, "scrollTop", { configurable: true, value: 480 });
    Object.defineProperty(sidebar, "scrollTop", { configurable: true, value: 999 });
    fireEvent.click(screen.getByRole("button", { name: "Arrival (2016)" }));

    expect(sessionStorage.getItem("media-scroll-y")).toBe("480");
    expect(h.push).toHaveBeenCalledWith("/dashboard/media/movie/1");
  });

  it("makes each poster a named button that opens with Enter", async () => {
    const user = userEvent.setup();
    render(<MediaPage />);
    const card = screen.getByRole("button", { name: "Arrival (2016)" });
    expect(card.tagName).toBe("BUTTON");
    expect(card).not.toHaveAttribute("aria-pressed");

    card.focus();
    await user.keyboard("{Enter}");
    expect(h.push).toHaveBeenCalledWith("/dashboard/media/movie/1");
  });

  it("shows a retryable error when the library never loaded", () => {
    const mutate = vi.fn();
    h.library = { data: undefined, error: new Error("Radarr API 502"), mutate };
    render(<MediaPage />);

    expect(screen.getByText("Couldn't load your movies")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutate).toHaveBeenCalled();
  });

  it("keeps the grid when a refresh fails", () => {
    const mutate = vi.fn();
    h.library = { data: LIBRARY, error: new Error("timeout"), mutate };
    render(<MediaPage />);

    expect(screen.getByRole("button", { name: "Arrival (2016)" })).toBeInTheDocument();
    expect(screen.getByText(/Couldn.t refresh/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutate).toHaveBeenCalled();
  });

  it("offers search only on Movies and TV shows", () => {
    for (const [query, hasSearch] of [["", true], ["tab=tv", true], ["tab=downloads", false], ["tab=calendar", false], ["tab=activity", false]] as const) {
      navigate(query);
      const { unmount } = render(<MediaPage />);
      const search = screen.queryByRole("textbox", { name: /^Search/ });
      expect(Boolean(search), query || "movies").toBe(hasSearch);
      unmount();
    }
    navigate("");
    render(<MediaPage />);
    expect(screen.getByRole("textbox", { name: "Search movies" })).toHaveAttribute("placeholder", "Search movies…");
  });

  it("keeps the tab strip in classic mode and the heading for windows only", () => {
    render(<MediaPage />);
    expect(screen.getByTestId("media-tabs").className).toContain("@2xl/window:hidden");
    const heading = screen.getByRole("heading", { level: 1, name: "Movies" });
    expect(heading.parentElement?.className).toContain("hidden");
    expect(heading.parentElement?.className).toContain("@2xl/window:flex");
    expect(heading.parentElement?.nextElementSibling?.textContent ?? "").not.toContain("Movies");
    // Labels are sentence case
    expect(tab("TV shows")).toBeInTheDocument();
  });

  it("keeps the library toolbar to one row: search, then selects or one menu by column width", () => {
    render(<MediaPage />);
    const controls = document.querySelector<HTMLElement>("[data-media-view-controls]");
    expect(controls).not.toBeNull();
    // Never a stacked column of controls, and no viewport breakpoints
    expect(controls!.className).not.toMatch(/(?:^|\s)flex-col\b/);
    expect(controls!.className).not.toMatch(/(?:^|\s)(?:sm|md|lg):/);
    expect(controls!).toContainElement(screen.getByRole("textbox", { name: "Search movies" }));

    // Wide columns: the selects, inline
    const sort = screen.getByRole("combobox", { name: "Sort" });
    const inline = sort.parentElement!;
    expect(inline.className).toContain("hidden @3xl/content:flex @7xl:flex");
    expect(inline).toContainElement(screen.getByRole("combobox", { name: "Minimum rating" }));
    // Narrow columns: one menu instead
    const menu = screen.getByRole("button", { name: "Sort and filter" });
    expect(menu.className).toContain("@3xl/content:hidden");
    expect(menu.className).toContain("@7xl:hidden");
    expect(controls!).toContainElement(menu);

    // Tab labels show where the column has room, not by viewport
    expect(tab("Movies").querySelector("span")?.className).toContain("@4xl:inline");
  });

  it("sorts and filters from the toolbar menu", async () => {
    render(<MediaPage />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Sort and filter" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Title, A to Z" }));
    expect(window.location.search).toBe("?sort=title-asc");

    fireEvent.keyDown(screen.getByRole("button", { name: "Sort and filter" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Rated 7 or higher" }));
    expect(new URLSearchParams(window.location.search).get("rating")).toBe("7");
    expect(screen.getByRole("button", { name: "Sort and filter, filtered" })).toBeInTheDocument();
  });

  it("writes search to the URL once typing pauses", async () => {
    vi.useFakeTimers();
    render(<MediaPage />);
    const field = screen.getByRole("textbox", { name: "Search movies" });
    fireEvent.change(field, { target: { value: "arr" } });
    expect(window.location.search).toBe("");
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(window.location.search).toBe("?q=arr");
    expect(h.search).toBe("q=arr");
    // The echo leaves the field alone
    expect(field).toHaveValue("arr");
  });
});

describe("Media collections decided by Plex or the scan", () => {
  it("waits for Plex watch status before showing Unwatched", async () => {
    vi.useFakeTimers();
    h.sources.watchStatus = h.swr(undefined);
    navigate("view=unwatched");
    render(<MediaPage />);
    await passSkeletonDelay();

    expect(screen.queryByText(/Connect Plex/)).toBeNull();
    expect(screen.queryByText(/not watched yet/)).toBeNull();
    expect(emptyOrErrorState()).toBeNull();
    expect(skeletons().length).toBeGreaterThan(0);
  });

  it("asks to connect Plex only when Plex says it isn't configured", () => {
    navigate("view=unwatched");
    render(<MediaPage />);
    expect(screen.getByText("Connect Plex to see what's unwatched")).toBeInTheDocument();
  });

  it("offers Retry when Plex can't be reached", () => {
    const status = h.swr({ configured: true, available: false, watchStatus: {} });
    h.sources.watchStatus = status;
    navigate("view=unwatched");
    render(<MediaPage />);

    expect(screen.getByText("Couldn't reach Plex")).toBeInTheDocument();
    expect(screen.queryByText(/Connect Plex/)).toBeNull();
    expect(screen.queryByText(/not watched yet/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(status.mutate).toHaveBeenCalled();
  });

  it("offers Retry when watch status fails to load", () => {
    h.sources.watchStatus = h.swr(undefined, new Error("Request failed (500)"));
    navigate("view=unwatched");
    render(<MediaPage />);
    expect(screen.getByText("Couldn't load your watch history")).toBeInTheDocument();
  });

  it.each(["ready", "needs-conversion"])("waits for the scan before showing %s", async (view) => {
    vi.useFakeTimers();
    h.health = { ...HEALTH_LOADED, scanPending: true };
    navigate(`view=${view}`);
    render(<MediaPage />);
    await passSkeletonDelay();

    expect(screen.queryByText("No movies ready yet")).toBeNull();
    expect(screen.queryByText("Nothing to convert")).toBeNull();
    expect(screen.queryByText(/ready to play in the browser|to convert for browser playback/)).toBeNull();
    expect(emptyOrErrorState()).toBeNull();
    expect(skeletons().length).toBeGreaterThan(0);
  });

  it("offers Retry when the scan results fail to load", () => {
    const mutateScan = vi.fn();
    h.health = { ...HEALTH_LOADED, scanError: new Error("Request failed (500)"), mutateScan };
    navigate("view=needs-conversion");
    render(<MediaPage />);

    expect(screen.getByText("Couldn't load scan results")).toBeInTheDocument();
    expect(screen.queryByText("Nothing to convert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutateScan).toHaveBeenCalled();
  });
});

describe("Media activity states", () => {
  const loadingEverything = () => {
    for (const key of ["sonarr", "radarr", "requests", "watchlist", "watching"]) h.sources[key] = h.swr(undefined);
  };

  it.each(["", "continue", "watchlist", "requests", "wanted"])("shows a skeleton, not a claim, while %s loads", async (section) => {
    vi.useFakeTimers();
    loadingEverything();
    navigate(section ? `tab=activity&section=${section}` : "tab=activity");
    render(<MediaPage />);

    // Nothing for 200ms, then a skeleton
    expect(emptyOrErrorState()).toBeNull();
    expect(skeletons()).toHaveLength(0);
    await passSkeletonDelay();
    expect(emptyOrErrorState()).toBeNull();
    expect(skeletons().length).toBeGreaterThan(0);
    expect(screen.queryByText(/Connect|No activity|Nothing wanted|awaiting approval|in progress|wanted$/)).toBeNull();
  });

  it("keeps the all view loading until every source has answered", async () => {
    vi.useFakeTimers();
    h.sources.radarr = h.swr(undefined);
    navigate("tab=activity");
    render(<MediaPage />);
    await passSkeletonDelay();
    expect(screen.queryByText("No activity")).toBeNull();
    expect(skeletons().length).toBeGreaterThan(0);
  });

  it("says No activity once every source answered empty", () => {
    navigate("tab=activity");
    render(<MediaPage />);
    expect(screen.getByText("No activity")).toBeInTheDocument();
  });

  it("asks to connect Plex only when Plex says it isn't configured", () => {
    navigate("tab=activity&section=continue");
    render(<MediaPage />);
    expect(screen.getByText("Connect Plex to see what you're watching")).toBeInTheDocument();
  });

  it("offers Retry when Plex can't be reached, without a count", () => {
    const watching = h.swr({ configured: true, available: false, continueWatching: [] });
    h.sources.watching = watching;
    navigate("tab=activity&section=continue");
    render(<MediaPage />);

    expect(screen.getByText("Couldn't reach Plex")).toBeInTheDocument();
    expect(screen.queryByText("Nothing in progress")).toBeNull();
    expect(screen.queryByText(/in progress$/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(watching.mutate).toHaveBeenCalled();
  });

  it("offers Retry when the watchlist fails to load, instead of Connect Plex", () => {
    h.sources.watchlist = h.swr(undefined, new Error("Plex discover failed"));
    navigate("tab=activity&section=watchlist");
    render(<MediaPage />);
    expect(screen.getByText("Couldn't load your watchlist")).toBeInTheDocument();
    expect(screen.queryByText(/Connect Plex/)).toBeNull();
  });

  it("offers Retry when Overseerr can't be reached, without a count", () => {
    h.sources.requests = h.swr({ configured: true, available: false, results: [] });
    navigate("tab=activity&section=requests");
    render(<MediaPage />);
    expect(screen.getByText("Couldn't reach Overseerr")).toBeInTheDocument();
    expect(screen.queryByText(/awaiting approval/)).toBeNull();
  });

  it("offers Retry when requests fail to load, instead of Connect Overseerr", () => {
    h.sources.requests = h.swr(undefined, new Error("Request failed (500)"));
    navigate("tab=activity&section=requests");
    render(<MediaPage />);
    expect(screen.getByText("Couldn't load requests")).toBeInTheDocument();
    expect(screen.queryByText(/Connect Overseerr/)).toBeNull();
  });

  it("waits for both apps before saying nothing is wanted", async () => {
    vi.useFakeTimers();
    h.sources.radarr = h.swr(undefined);
    navigate("tab=activity&section=wanted");
    render(<MediaPage />);
    await passSkeletonDelay();
    expect(screen.queryByText("Nothing wanted")).toBeNull();
    expect(skeletons().length).toBeGreaterThan(0);
  });

  it("offers Retry when neither Sonarr nor Radarr answers", () => {
    h.sources.sonarr = h.swr(undefined, new Error("sonarr URL not configured"));
    h.sources.radarr = h.swr({ records: [], totalRecords: 0, available: false });
    navigate("tab=activity&section=wanted");
    render(<MediaPage />);
    expect(screen.getByText("Couldn't reach Sonarr or Radarr")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(h.sources.sonarr.mutate).toHaveBeenCalled();
    expect(h.sources.radarr.mutate).toHaveBeenCalled();
  });

  it("doesn't say No activity when a source failed", () => {
    h.sources.requests = h.swr({ configured: true, available: false, results: [] });
    navigate("tab=activity");
    render(<MediaPage />);
    expect(screen.queryByText("No activity")).toBeNull();
    expect(screen.getByText("Couldn't load activity")).toBeInTheDocument();
  });

  it("keeps what loaded and names what didn't", () => {
    h.sources.requests = h.swr({ configured: true, available: false, results: [] });
    h.sources.watchlist = h.swr({ configured: true, items: [{ ratingKey: "1", title: "Dune", type: "movie", year: 2021 }] });
    navigate("tab=activity");
    render(<MediaPage />);

    expect(screen.getByText("Dune")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't load requests");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(h.sources.requests.mutate).toHaveBeenCalled();
  });
});

describe("Media detail route states", () => {
  const notFound = () => screen.queryByText("This title isn't in your library");
  const renderDetail = () => render(<TooltipProvider><MediaDetailPage /></TooltipProvider>);

  beforeEach(() => {
    // Requests the detail page makes once a title is on screen: never answered here
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    navigate("", "/dashboard/media/movie/1");
  });

  it("stays loading while the library loads", async () => {
    vi.useFakeTimers();
    h.library = h.swr(undefined);
    h.params = { type: "movie", id: "1" };
    renderDetail();

    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    await passSkeletonDelay();
    expect(skeletons().length).toBeGreaterThan(0);
    expect(notFound()).toBeNull();
    expect(h.library.mutate).not.toHaveBeenCalled();
  });

  it("asks the server again before saying a title isn't in the library", async () => {
    // The cache predates the title: the Assistant added Dune and linked here
    let answer!: () => void;
    const mutate = vi.fn(() => new Promise<void>((resolve) => {
      answer = () => {
        h.library = { ...h.library, data: { ...LIBRARY, movies: [...LIBRARY.movies, movie(3, { title: "Dune" })] } };
        resolve();
      };
    }));
    h.library = { data: LIBRARY, error: undefined, mutate };
    h.params = { type: "movie", id: "3" };
    renderDetail();

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(notFound()).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();

    await act(async () => { answer(); });
    expect(await screen.findByRole("heading", { level: 2, name: "Dune" })).toBeInTheDocument();
    expect(notFound()).toBeNull();
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("says a title isn't in the library after a fresh answer without it", async () => {
    const mutate = vi.fn(async () => undefined);
    h.library = { data: LIBRARY, error: undefined, mutate };
    h.params = { type: "movie", id: "3" };
    renderDetail();

    expect(await screen.findByText("This title isn't in your library")).toBeInTheDocument();
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("doesn't claim a title is missing when the fresh request fails", async () => {
    const mutate = vi.fn(async () => {
      h.library = { ...h.library, error: new Error("Radarr API 502") };
    });
    h.library = { data: LIBRARY, error: undefined, mutate };
    h.params = { type: "movie", id: "3" };
    renderDetail();

    expect(await screen.findByText("Couldn't load this title")).toBeInTheDocument();
    expect(notFound()).toBeNull();
  });

  it("shows a retryable error when the library can't load", () => {
    const mutate = vi.fn();
    h.library = { data: undefined, error: new Error("Radarr API 502"), mutate };
    h.params = { type: "movie", id: "1" };
    renderDetail();

    expect(screen.getByText("Couldn't load this title")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutate).toHaveBeenCalled();
  });
});
