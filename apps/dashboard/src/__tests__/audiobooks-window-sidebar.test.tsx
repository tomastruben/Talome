/**
 * Audiobooks in a desktop window: a sidebar with your libraries (and
 * Audible), then Search and Downloads. It replaces the tab strip and, on the
 * library tab, the library picker. Classic keeps the tabs, which now carry
 * names (they were icon-only).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider, createStore } from "jotai";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigate, replace: vi.fn() }),
  usePathname: () => "/dashboard/audiobooks",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const embedded = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => embedded.value }));
const books = vi.hoisted(() => ({ readiness: 1 }));
vi.mock("@/hooks/use-feature-stacks", () => ({
  useFeatureStack: () => ({ stack: { id: "books", readiness: books.readiness }, isLoading: false }),
}));
vi.mock("@/components/ui/stack-setup", () => ({ StackSetup: () => <p>Set up Audiobooks</p> }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import AudiobooksPage from "@/app/dashboard/audiobooks/page";
import { WindowSidebarSlot } from "@/components/ui/source-list";

type Route = { status: number; body?: unknown };
let routes: Record<string, Route>;
const requested: string[] = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://localhost");
  requested.push(url.pathname);
  const route = routes[url.pathname] ?? { status: 500, body: { error: "not mocked" } };
  return { ok: route.status >= 200 && route.status < 300, status: route.status, json: async () => route.body, text: async () => "" } as Response;
});

const record = (hash: string, progress: number) => ({
  hash, name: hash, state: progress < 100 ? "downloading" : "uploading", progress, size: 1, downloaded: 1,
  dlspeed: 0, eta: 0, addedOn: 0, completionOn: 0, savePath: "/", category: "audiobooks",
});

function renderPage() {
  return render(
    <Provider store={createStore()}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        {embedded.value && <WindowSidebarSlot />}
        <AudiobooksPage />
      </SWRConfig>
    </Provider>,
  );
}

const sidebar = () => screen.findByRole("navigation", { name: "Audiobooks" });

beforeEach(() => {
  navigate.mockClear();
  embedded.value = true;
  books.readiness = 1;
  requested.length = 0;
  localStorage.clear();
  // The page keeps its tab in the URL (?tab=); start each test on the library tab.
  window.history.replaceState(null, "", "/dashboard/audiobooks");
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  routes = {
    "/api/audiobooks/libraries": { status: 200, body: [{ id: "lib1", name: "Fiction", mediaType: "book" }, { id: "lib2", name: "Podcasts", mediaType: "book" }] },
    "/api/audiobooks/search/status": { status: 200, body: { configured: true, prowlarr: true, qbittorrent: true } },
    "/api/audible/auth-status": { status: 200, body: { authenticated: true } },
    "/api/audible/import-tools": { status: 200, body: { ffmpeg: true } },
    "/api/audible/imports": { status: 200, body: { jobs: [] } },
    "/api/audible/library": { status: 200, body: { items: [] } },
    "/api/audiobooks/downloads": { status: 200, body: { totalRecords: 3, records: [record("a", 40), record("b", 100), record("c", 75)] } },
    "/api/audiobooks/library/lib1": { status: 200, body: { results: [], total: 0, limit: 500, page: 0 } },
    "/api/audiobooks/library/lib2": { status: 200, body: { results: [], total: 0, limit: 500, page: 0 } },
    "/api/audiobooks/library/lib1/personalized": { status: 200, body: [] },
    "/api/audiobooks/library/lib2/personalized": { status: 200, body: [] },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Audiobooks window sidebar", () => {
  it("opens an audiobook with the keyboard", async () => {
    embedded.value = false;
    routes["/api/audiobooks/library/lib1"] = {
      status: 200,
      body: { results: [{ id: "book-1", media: { metadata: { title: "Test Book", authorName: "Author" } } }], total: 1, limit: 500, page: 0 },
    };
    renderPage();
    const book = await screen.findByRole("button", { name: "Open Test Book" });
    book.focus();
    await userEvent.keyboard("{Enter}");
    expect(navigate).toHaveBeenCalledWith("/dashboard/audiobooks/book-1");
  });

  it("lists the libraries, Audible, Search and Downloads", async () => {
    renderPage();
    const nav = await sidebar();
    const libraries = within(nav).getByRole("heading", { name: "Libraries" }).closest("section")!;
    expect(await within(libraries).findByRole("button", { name: "Fiction" })).toBeInTheDocument();
    expect(within(libraries).getByRole("button", { name: "Podcasts" })).toBeInTheDocument();
    expect(await within(libraries).findByRole("button", { name: "Audible" })).toBeInTheDocument();

    const find = within(nav).getByRole("heading", { name: "Find" }).closest("section")!;
    expect(within(find).getByRole("button", { name: "Search" })).toBeInTheDocument();
    // Two downloads in flight (the finished one doesn't count)
    // (jsdom has no layout, so it joins the label and the count without a space)
    expect(await within(find).findByRole("button", { name: /^Downloads\s*2$/ })).toBeInTheDocument();
  });

  it("picking a library opens it on the library tab; Search and Downloads switch the view", async () => {
    renderPage();
    const nav = await sidebar();
    const fiction = await within(nav).findByRole("button", { name: "Fiction" });
    await waitFor(() => expect(fiction).toHaveAttribute("aria-current", "page"));

    fireEvent.click(within(nav).getByRole("button", { name: "Search" }));
    expect(within(nav).getByRole("button", { name: "Search" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByPlaceholderText("Search audiobooks across indexers…")).toBeInTheDocument();
    expect(fiction).not.toHaveAttribute("aria-current");

    fireEvent.click(within(nav).getByRole("button", { name: "Podcasts" }));
    const podcasts = within(nav).getByRole("button", { name: "Podcasts" });
    expect(podcasts).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(requested).toContain("/api/audiobooks/library/lib2"));
    expect(screen.getByRole("tab", { name: "Library" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(within(nav).getByRole("button", { name: "Audible" }));
    expect(within(nav).getByRole("button", { name: "Audible" })).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(requested).toContain("/api/audible/library"));
  });

  it("shows the downloads count only when something is in flight", async () => {
    routes["/api/audiobooks/downloads"] = { status: 200, body: { totalRecords: 1, records: [record("b", 100)] } };
    renderPage();
    const nav = await sidebar();
    await waitFor(() => expect(requested).toContain("/api/audiobooks/downloads"));
    const downloads = within(nav).getByRole("button", { name: "Downloads" });
    expect(downloads.textContent).toBe("Downloads");
  });

  it("hides the tabs and the library picker exactly when the sidebar shows; the tabs are named", async () => {
    renderPage();
    await sidebar();
    const tablist = screen.getByRole("tablist");
    expect(tablist.closest('[class*="@3xl/window:hidden"]')).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Library" })).toHaveAttribute("title", "Library");
    expect(screen.getByRole("tab", { name: "Search" })).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: "Downloads, 2 in progress" })).toBeInTheDocument();

    // On the library tab the sidebar lists the libraries, so the pickers step aside
    const pickers = await screen.findAllByRole("combobox", { name: "Library" });
    for (const picker of pickers) {
      expect(picker.closest('[class*="@3xl/window:hidden"]')).not.toBeNull();
    }

    // On Search the picker says where downloads go, so it stays
    fireEvent.click(screen.getByRole("tab", { name: "Search" }));
    const searchPicker = await screen.findByRole("combobox", { name: "Library" });
    expect(searchPicker.closest('[class*="@3xl/window:hidden"]')).toBeNull();
  });

  it("says when libraries can't be loaded, and Retry asks again", async () => {
    routes["/api/audiobooks/libraries"] = { status: 500, body: { error: "down" } };
    renderPage();
    const nav = await sidebar();
    expect(await within(nav).findByText("Couldn't load libraries.")).toBeInTheDocument();
    const before = requested.filter((p) => p === "/api/audiobooks/libraries").length;

    routes["/api/audiobooks/libraries"] = { status: 200, body: [{ id: "lib1", name: "Fiction", mediaType: "book" }] };
    fireEvent.click(within(nav).getByRole("button", { name: "Retry" }));
    expect(await within(nav).findByRole("button", { name: "Fiction" })).toBeInTheDocument();
    expect(requested.filter((p) => p === "/api/audiobooks/libraries").length).toBeGreaterThan(before);
  });

  it("offers one Library row when there are no libraries yet", async () => {
    routes["/api/audiobooks/libraries"] = { status: 200, body: [] };
    routes["/api/audible/auth-status"] = { status: 200, body: { authenticated: false } };
    renderPage();
    const nav = await sidebar();
    expect(await within(nav).findByRole("button", { name: "Library" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).queryByRole("button", { name: "Audible" })).toBeNull();
  });

  it("keeps Audible reachable when there are no libraries, and Library goes back", async () => {
    routes["/api/audiobooks/libraries"] = { status: 200, body: [] };
    renderPage();
    const nav = await sidebar();
    const library = await within(nav).findByRole("button", { name: "Library" });
    const audible = await within(nav).findByRole("button", { name: "Audible" });

    fireEvent.click(audible);
    expect(audible).toHaveAttribute("aria-current", "page");
    // Only one row is current
    expect(library).not.toHaveAttribute("aria-current");
    await waitFor(() => expect(requested).toContain("/api/audible/library"));

    fireEvent.click(library);
    expect(library).toHaveAttribute("aria-current", "page");
    expect(audible).not.toHaveAttribute("aria-current");
    expect(await screen.findByText("Connect Audiobookshelf")).toBeInTheDocument();
  });

  it("keeps Audible reachable when the libraries can't be loaded", async () => {
    routes["/api/audiobooks/libraries"] = { status: 500, body: { error: "down" } };
    renderPage();
    const nav = await sidebar();
    await within(nav).findByText("Couldn't load libraries.");
    fireEvent.click(await within(nav).findByRole("button", { name: "Audible" }));
    expect(within(nav).getByRole("button", { name: "Audible" })).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(requested).toContain("/api/audible/library"));
  });

  it("shows no sidebar while Audiobooks still needs setting up", async () => {
    books.readiness = 0;
    renderPage();
    expect(await screen.findByText("Set up Audiobooks")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Audiobooks" })).toBeNull();
  });
});

describe("Audiobooks in classic mode", () => {
  it("has no sidebar and keeps named tabs", async () => {
    embedded.value = false;
    renderPage();
    expect(await screen.findByRole("tab", { name: "Library" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Audiobooks" })).toBeNull();
    // Downloads are only fetched for the Downloads tab when there is no sidebar to count them
    expect(requested).not.toContain("/api/audiobooks/downloads");
  });

  // Parity with the window's sidebar: Audible stays in the library pickers
  // with no libraries, or when they can't be loaded.
  for (const [when, route] of [
    ["there are no libraries", { status: 200, body: [] }],
    ["the libraries can't be loaded", { status: 500, body: { error: "down" } }],
  ] as const) {
    it(`offers Audible in the library picker when ${when}`, async () => {
      embedded.value = false;
      routes["/api/audiobooks/libraries"] = route;
      renderPage();
      await waitFor(() => expect(requested).toContain("/api/audible/auth-status"));
      const pickers = await screen.findAllByRole("combobox", { name: "Library" });
      expect(pickers.length).toBeGreaterThan(0);
      // Radix Select scrolls the chosen option into view, which jsdom lacks
      const scrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = vi.fn();
      try {
        fireEvent.click(pickers[pickers.length - 1]);
        expect(await screen.findByRole("option", { name: "Audible" })).toBeInTheDocument();
      } finally {
        Element.prototype.scrollIntoView = scrollIntoView;
      }
    });
  }
});
