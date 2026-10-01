/**
 * Files search: typing filters the folder on screen with no request; Enter (or
 * "Include subfolders") searches below it on the server, with one abortable
 * request at a time; ⌘F/Ctrl+F, Escape, the arrows and Enter work like a
 * desktop file manager; results can be shown in their folder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { SWRConfig } from "swr";
import { Provider, createStore } from "jotai";

const { toastFns } = vi.hoisted(() => ({
  toastFns: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn(() => "t1") },
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toastFns) }));

const nav = vi.hoisted(() => ({ search: "path=%2Froot%2Fdocs", replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/hooks/use-system-stats", () => ({ useSystemStats: () => ({ stats: null }) }));

import FilesPage from "@/app/dashboard/files/page";
import { ConfirmDialogHost, confirmStore } from "@/components/ui/confirm-dialog";
import {
  displaySegments,
  filesCountLabel,
  filterByQuery,
  highlightRanges,
  matchScore,
  matchesQuery,
  searchErrorCopy,
  searchTruncationNote,
} from "@/components/files/file-helpers";

type Route = { status: number; body: unknown } | { reject: Error } | { pending: true };
let routes: Array<{ match: string; route: Route | ((url: string, init?: RequestInit) => Route) }>;
const pending: Array<{ url: string; signal: AbortSignal | undefined; resolve: (r: Response) => void }> = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const hit = routes.find((r) => url.includes(r.match));
  const route: Route = hit ? (typeof hit.route === "function" ? hit.route(url, init) : hit.route) : { status: 500, body: { error: "not mocked" } };
  if ("reject" in route) throw route.reject;
  if ("pending" in route) {
    return new Promise<Response>((resolve, reject) => {
      pending.push({ url, signal: init?.signal ?? undefined, resolve });
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
  }
  return { ok: route.status >= 200 && route.status < 300, status: route.status, json: async () => route.body } as Response;
});

const item = (name: string, dir = "/root/docs", isDirectory = false) => ({
  name,
  path: `${dir}/${name}`,
  isDirectory,
  size: 10,
  modified: "2026-09-29T10:00:00.000Z",
});

const listing = (names: string[], path = "/root/docs") => ({
  path,
  parent: "/root",
  allowedRoots: ["/root"],
  roots: [{ id: "root", path: "/root", label: "Files", kind: "talome-files" }],
  items: names.map((name) => item(name, path, !name.includes("."))),
});

const searchBody = (items: ReturnType<typeof item>[], extra: Record<string, unknown> = {}) => ({
  path: "/root/docs",
  query: "report",
  items,
  truncated: null,
  skipped: 0,
  limits: { results: 200, maxDepth: 12, timeBudgetMs: 4000, maxEntries: 100000 },
  elapsedMs: 12,
  ...extra,
});

let store: ReturnType<typeof createStore>;
function renderPage() {
  store = createStore();
  return render(
    <Provider store={store}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <FilesPage />
        <ConfirmDialogHost />
      </SWRConfig>
    </Provider>,
  );
}

const field = () => screen.getByRole("combobox", { name: "Search docs" });
const searchCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/files/search"));
const sleep = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  nav.replace.mockClear();
  nav.search = "path=%2Froot%2Fdocs";
  pending.length = 0;
  Object.values(toastFns).forEach((fn) => fn.mockClear());
});

afterEach(() => {
  confirmStore.reset();
  vi.unstubAllGlobals();
});

describe("search helpers", () => {
  it("scores whole names, prefixes, word starts and anywhere", () => {
    expect(matchScore("report.pdf", "report")).toBe(0);
    expect(matchScore("Reports", "report")).toBe(1);
    expect(matchScore("q3 report.pdf", "report")).toBe(2);
    expect(matchScore("misreported.txt", "report")).toBe(3);
    expect(matchScore("notes.txt", "report")).toBeNull();
    expect(matchScore("anything", "  ")).toBeNull();
  });

  it("matches every word in any order, case and normalization aside", () => {
    expect(matchesQuery("Tax Return 2024.pdf", "2024 tax")).toBe(true);
    expect(matchesQuery("tax-2023.pdf", "2024 tax")).toBe(false);
    expect(matchesQuery("Café menu.pdf", "café")).toBe(true);
    expect(matchesQuery("whatever", "")).toBe(true);
    const items = [{ name: "b-report" }, { name: "notes" }, { name: "a-report" }];
    expect(filterByQuery(items, "report").map((i) => i.name)).toEqual(["b-report", "a-report"]);
  });

  it("marks each word once, preferring a word start, and merges overlaps", () => {
    expect(highlightRanges("misreport report.pdf", "report")).toEqual([[10, 16]]);
    expect(highlightRanges("Tax Return 2024.pdf", "2024 tax")).toEqual([[0, 3], [11, 15]]);
    expect(highlightRanges("abcdef", "abc bcd")).toEqual([[0, 4]]);
    // An NFD name is marked in its NFC form.
    expect(highlightRanges("Café", "café")).toEqual([[0, 4]]);
    expect(highlightRanges("x", "")).toEqual([]);
  });

  it("builds the path from the location's label, never a host path", () => {
    const roots = [{ path: "/Users/me/.talome/files", label: "Talome Files" }, { path: "/Volumes/Media", label: "Media" }];
    expect(displaySegments("/Users/me/.talome/files/Photos/2025", roots)).toEqual([
      { name: "Talome Files", path: "/Users/me/.talome/files" },
      { name: "Photos", path: "/Users/me/.talome/files/Photos" },
      { name: "2025", path: "/Users/me/.talome/files/Photos/2025" },
    ]);
    expect(displaySegments("/Volumes/Media", roots)).toEqual([{ name: "Media", path: "/Volumes/Media" }]);
    expect(displaySegments("/srv/elsewhere/folder", roots)).toEqual([{ name: "folder", path: "/srv/elsewhere/folder" }]);
    expect(displaySegments(null, roots)).toEqual([]);
  });

  it("counts with the locale's numbers and plurals", () => {
    expect(filesCountLabel({ kind: "folder", total: 1 })).toBe("1 item");
    expect(filesCountLabel({ kind: "folder", total: 1204 })).toBe("1,204 items");
    expect(filesCountLabel({ kind: "filtered", shown: 3, total: 12 })).toBe("3 of 12 items");
    expect(filesCountLabel({ kind: "searching" })).toBe("Searching…");
    expect(filesCountLabel({ kind: "results", count: 37, truncated: null })).toBe("37 results");
    expect(filesCountLabel({ kind: "results", count: 200, truncated: "results" })).toBe("First 200 results");
    expect(filesCountLabel({ kind: "roots" })).toBe("All locations");
  });

  it("explains a cut-short search from the server's limits", () => {
    const limits = { results: 200, maxDepth: 12, timeBudgetMs: 4000, maxEntries: 100000 };
    const items = new Array(200).fill(null);
    expect(searchTruncationNote({ truncated: null, skipped: 0, limits, items })).toBeNull();
    expect(searchTruncationNote({ truncated: "results", skipped: 0, limits, items })).toMatch(/^Showing the first 200 results\./);
    expect(searchTruncationNote({ truncated: "time", skipped: 0, limits, items })).toMatch(/stopped after 4 seconds/);
    expect(searchTruncationNote({ truncated: "entries", skipped: 0, limits, items })).toMatch(/checking 100,000 items/);
    expect(searchTruncationNote({ truncated: "depth", skipped: 2, limits, items })).toBe(
      "Folders more than 12 levels deep weren't searched. 2 folders couldn't be read.",
    );
  });

  it("names the fix for each search failure", () => {
    expect(searchErrorCopy(403, null, "Photos").title).toBe("Talome can't search Photos");
    expect(searchErrorCopy(404, null, "Photos", "ENOENT").title).toBe("Photos isn't there any more");
    // A 404 without the server's "folder is gone" code: an older server with no search.
    expect(searchErrorCopy(404, "Not found", "Photos", null).title).toBe("Search isn't available on this server");
    expect(searchErrorCopy(429, null, "Photos")).toEqual({
      title: "Too many searches at once",
      description: "Other searches are still running on this server. Retry in a moment.",
    });
    expect(searchErrorCopy(400, "Type at least 2 characters to search.", "Photos").description).toBe("Type at least 2 characters to search.");
    // A drive that isn't answering, in the server's words.
    expect(searchErrorCopy(503, "A drive isn't answering, so search is paused. Check that your drives are connected, then retry.", "Photos")).toEqual({
      title: "Couldn't search Photos",
      description: "A drive isn't answering, so search is paused. Check that your drives are connected, then retry.",
    });
    // A 503 with no message came from something in between, not from search.
    expect(searchErrorCopy(503, null, "Photos").description).toBe("Check that the Talome server is reachable, then retry.");
    expect(searchErrorCopy(null, null, "Photos")).toEqual({
      title: "Couldn't search Photos",
      description: "Check that the Talome server is reachable, then retry.",
    });
  });
});

describe("files search", () => {
  it("filters the folder as you type, with no request, and counts what's shown", async () => {
    routes = [{ match: "/api/files/list", route: { status: 200, body: listing(["report.pdf", "q3 report.txt", "notes.txt", "photo.jpg", "Archive"]) } }];
    renderPage();
    await screen.findByText("notes.txt");
    expect(screen.getByText("5 items")).toBeInTheDocument();

    fireEvent.change(field(), { target: { value: "report" } });
    expect(screen.queryByText("notes.txt")).toBeNull();
    expect(screen.getByText("2 of 5 items")).toBeInTheDocument();
    // The match is marked in each name.
    const marks = document.querySelectorAll("mark");
    expect([...marks].map((mark) => mark.textContent)).toEqual(["report", "report"]);
    expect(screen.getByRole("button", { name: /Search “report” in docs and its subfolders/ })).toBeInTheDocument();

    await sleep(400);
    expect(searchCalls()).toHaveLength(0);
  });

  it("offers a subfolder search when nothing in the folder matches", async () => {
    routes = [{ match: "/api/files/list", route: { status: 200, body: listing(["notes.txt"]) } }];
    renderPage();
    await screen.findByText("notes.txt");
    fireEvent.change(field(), { target: { value: "zzz" } });
    expect(screen.getByText("Nothing in docs matches “zzz”")).toBeInTheDocument();
    expect(screen.getByText(/Hidden files aren't shown\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search subfolders" })).toBeInTheDocument();
  });

  it("searches below the folder on Enter, with path, q, limit and showHidden", async () => {
    routes = [
      { match: "/api/files/search", route: { status: 200, body: searchBody([item("report.pdf", "/root/docs/2024"), item("q3 report.txt")]) } },
      { match: "/api/files/list", route: { status: 200, body: listing(["notes.txt"]) } },
    ];
    renderPage();
    await screen.findByText("notes.txt");
    fireEvent.change(field(), { target: { value: "report" } });
    fireEvent.keyDown(field(), { key: "Enter" });

    await waitFor(() => expect(searchCalls()).toHaveLength(1));
    const url = new URL(String(searchCalls()[0][0]), "http://localhost");
    expect(url.pathname).toMatch(/\/api\/files\/search$/);
    expect(Object.fromEntries(url.searchParams)).toEqual({ path: "/root/docs", q: "report", limit: "200", showHidden: "false" });

    const grid = await screen.findByRole("grid", { name: "Results for “report”" });
    const rows = within(grid).getAllByRole("row");
    expect(rows).toHaveLength(2);
    // Each result shows its folder from the location's label, never a host path.
    expect(within(rows[0]).getByText("Files / docs / 2024")).toBeInTheDocument();
    expect(screen.getByText("2 results")).toBeInTheDocument();
    expect(field()).toHaveAttribute("aria-expanded", "true");
    expect(field()).toHaveAttribute("aria-haspopup", "grid");
    expect(field()).toHaveAttribute("aria-controls", grid.id);
  });

  it("keeps each result and its actions menu in separate cells, named by name and folder", async () => {
    routes = [
      {
        match: "/api/files/search",
        route: {
          status: 200,
          body: searchBody([
            item("report.pdf", "/root/docs/2024"),
            // The server couldn't read this one's details in time.
            { ...item("q3 report.txt"), size: 0, modified: null },
          ]),
        },
      },
      { match: "/api/files/list", route: { status: 200, body: listing(["notes.txt"]) } },
    ];
    renderPage();
    await screen.findByText("notes.txt");
    fireEvent.change(field(), { target: { value: "report" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    const grid = await screen.findByRole("grid");
    const rows = within(grid).getAllByRole("row");

    for (const row of rows) {
      const [result, actions, ...rest] = within(row).getAllByRole("gridcell");
      expect(rest).toHaveLength(0);
      // Nothing interactive inside the result's own cell.
      expect(result.querySelector("button, a, input, [tabindex]")).toBeNull();
      expect(within(actions).getAllByRole("button")).toHaveLength(1);
    }
    const [first, second] = rows.map((row) => within(row).getAllByRole("gridcell")[0]);
    expect(first).toHaveAccessibleName("report.pdf Files / docs / 2024");
    expect(first).toHaveAccessibleDescription(/^.+, 10 B$/);
    // No details from the server: none shown, rather than a made-up 0 B.
    expect(second).toHaveAccessibleName("q3 report.txt Files / docs");
    expect(second).not.toHaveAttribute("aria-describedby");
    expect(within(rows[1]).queryByText("0 B")).toBeNull();
    // One tab stop for the whole grid.
    expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it("controls the results grid only while it's on screen", async () => {
    routes = [
      { match: "/api/files/search", route: { status: 200, body: searchBody([item("report.pdf")]) } },
      { match: "/api/files/list", route: { status: 200, body: listing(["notes.txt", "report-old.txt"]) } },
    ];
    renderPage();
    await screen.findByText("notes.txt");
    // Filtering the folder: no popup to control.
    fireEvent.change(field(), { target: { value: "report" } });
    expect(field()).toHaveAttribute("aria-expanded", "false");
    expect(field()).not.toHaveAttribute("aria-controls");

    fireEvent.keyDown(field(), { key: "Enter" });
    const grid = await screen.findByRole("grid");
    expect(field()).toHaveAttribute("aria-controls", grid.id);

    // Too short to search: the old results leave the screen, and the reference with them.
    fireEvent.change(field(), { target: { value: "r" } });
    expect(screen.queryByRole("grid")).toBeNull();
    expect(field()).toHaveAttribute("aria-expanded", "false");
    expect(field()).not.toHaveAttribute("aria-controls");
  });

  it("aborts the request in flight when the query changes", async () => {
    routes = [
      { match: "/api/files/search", route: { pending: true } },
      { match: "/api/files/list", route: { status: 200, body: listing(["notes.txt"]) } },
    ];
    renderPage();
    await screen.findByText("notes.txt");
    fireEvent.change(field(), { target: { value: "rep" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(screen.getByText("Searching…")).toBeInTheDocument();

    fireEvent.change(field(), { target: { value: "repo" } });
    expect(pending[0].signal?.aborted).toBe(true);
    // The next one waits for typing to pause, then starts.
    await waitFor(() => expect(pending).toHaveLength(2), { timeout: 2000 });
    expect(new URL(pending[1].url, "http://localhost").searchParams.get("q")).toBe("repo");
    expect(pending[1].signal?.aborted).toBe(false);
    // An aborted request is never shown as an error.
    expect(screen.queryByText(/Couldn't search/)).toBeNull();
  });

  it("focuses the field on ⌘F and Ctrl+F, and leaves a second press to the browser", async () => {
    routes = [{ match: "/api/files/list", route: { status: 200, body: listing(["notes.txt"]) } }];
    renderPage();
    await screen.findByText("notes.txt");
    expect(screen.getByText("⌘F")).toBeInTheDocument();

    const meta = fireEvent.keyDown(document, { key: "f", metaKey: true });
    expect(meta).toBe(false); // default prevented
    expect(document.activeElement).toBe(field());

    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document, { key: "F", ctrlKey: true });
    expect(document.activeElement).toBe(field());

    // Already in the field: not handled, so the browser's find opens.
    expect(fireEvent.keyDown(field(), { key: "f", metaKey: true })).toBe(true);
  });

  it("clears with the first Escape and leaves the field with the second", async () => {
    routes = [{ match: "/api/files/list", route: { status: 200, body: listing(["notes.txt", "photo.jpg"]) } }];
    renderPage();
    await screen.findByText("notes.txt");
    field().focus();
    fireEvent.change(field(), { target: { value: "photo" } });
    expect(screen.queryByText("notes.txt")).toBeNull();

    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field()).toHaveValue("");
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(document.activeElement).toBe(field());

    fireEvent.keyDown(field(), { key: "Escape" });
    expect(document.activeElement).not.toBe(field());
  });

  it("moves through results with the arrows, back to the field with Escape, and opens with Enter", async () => {
    routes = [
      {
        match: "/api/files/search",
        route: { status: 200, body: searchBody([item("Reports", "/root/docs", true), item("report.pdf", "/root/docs/2024")]) },
      },
      { match: "/api/files/list", route: { status: 200, body: listing(["notes.txt"]) } },
    ];
    renderPage();
    await screen.findByText("notes.txt");
    fireEvent.change(field(), { target: { value: "report" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    const grid = await screen.findByRole("grid");
    const rows = within(grid).getAllByRole("row");
    const cell = (row: number) => within(rows[row]).getAllByRole("gridcell")[0];
    const menu = (row: number) => within(rows[row]).getByRole("button", { name: /^Actions for / });

    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(cell(0));
    fireEvent.keyDown(cell(0), { key: "ArrowDown" });
    expect(document.activeElement).toBe(cell(1));
    expect(cell(1)).toHaveAttribute("tabindex", "0");
    expect(cell(0)).toHaveAttribute("tabindex", "-1");

    // Right reaches the row's actions menu; Up and Down stay in that column, without opening it.
    fireEvent.keyDown(cell(1), { key: "ArrowRight" });
    expect(document.activeElement).toBe(menu(1));
    fireEvent.keyDown(menu(1), { key: "ArrowUp" });
    expect(document.activeElement).toBe(menu(0));
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.keyDown(menu(0), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(cell(0));
    fireEvent.keyDown(cell(0), { key: "End", ctrlKey: true });
    expect(document.activeElement).toBe(menu(1));
    fireEvent.keyDown(menu(1), { key: "Home" });
    expect(document.activeElement).toBe(cell(1));
    fireEvent.keyDown(cell(1), { key: "Home", metaKey: true });
    expect(document.activeElement).toBe(cell(0));
    fireEvent.keyDown(cell(0), { key: "Escape" });
    expect(document.activeElement).toBe(field());

    // Enter in the field opens the first result (a folder: it navigates there).
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(nav.replace).toHaveBeenCalledWith("/dashboard/files?path=%2Froot%2Fdocs%2FReports", { scroll: false });
  });

  it("moves through the folder's rows with the arrows and selects with Space", async () => {
    routes = [{ match: "/api/files/list", route: { status: 200, body: listing(["a.txt", "b.txt", "c.txt"]) } }];
    renderPage();
    await screen.findByText("a.txt");
    const rows = () => [...document.querySelectorAll<HTMLElement>("tr[data-file-path]")];
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows()[0]);
    fireEvent.keyDown(rows()[0], { key: "End" });
    expect(document.activeElement).toBe(rows()[2]);
    fireEvent.keyDown(rows()[2], { key: " " });
    expect(await screen.findByText("1 selected")).toBeInTheDocument();
    fireEvent.keyDown(rows()[2], { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows()[1]);
    fireEvent.keyDown(rows()[1], { key: "Escape" });
    expect(document.activeElement).toBe(field());
    // Escape on a row goes back to the field without dropping the selection.
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("says what failed, by status", async () => {
    const cases: Array<[Route, string]> = [
      [{ status: 403, body: { error: "Access denied" } }, "Talome can't search docs"],
      [{ status: 429, body: { error: "busy" } }, "Too many searches at once"],
      [{ status: 400, body: { error: "Type at least 2 characters to search." } }, "Couldn't search for that"],
      [{ status: 503, body: { error: "A drive isn't answering, so search is paused. Check that your drives are connected, then retry." } }, "A drive isn't answering, so search is paused. Check that your drives are connected, then retry."],
      [{ reject: new TypeError("Failed to fetch") }, "Couldn't search docs"],
    ];
    for (const [route, title] of cases) {
      routes = [
        { match: "/api/files/search", route },
        { match: "/api/files/list", route: { status: 200, body: listing(["notes.txt"]) } },
      ];
      const view = renderPage();
      await screen.findByText("notes.txt");
      fireEvent.change(field(), { target: { value: "report" } });
      fireEvent.keyDown(field(), { key: "Enter" });
      expect(await screen.findByText(title)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
      view.unmount();
    }
  });

  it("says when results were cut short, and offers a wider search when nothing matched", async () => {
    let body: unknown = searchBody([item("report-1.pdf"), item("report-2.pdf")], { truncated: "results", limits: { results: 2, maxDepth: 12, timeBudgetMs: 4000, maxEntries: 100000 } });
    routes = [
      { match: "/api/files/search", route: () => ({ status: 200, body }) },
      { match: "/api/files/list", route: { status: 200, body: listing(["notes.txt"]) } },
    ];
    renderPage();
    await screen.findByText("notes.txt");
    fireEvent.change(field(), { target: { value: "report" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(await screen.findByText(/^Showing the first 2 results\./)).toBeInTheDocument();
    expect(screen.getByText("First 2 results")).toBeInTheDocument();

    body = searchBody([], { query: "zzz" });
    fireEvent.change(field(), { target: { value: "zzz" } });
    expect(await screen.findByText("Nothing matches “zzz”")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Search all of Files" }));
    expect(nav.replace).toHaveBeenLastCalledWith("/dashboard/files?path=%2Froot&q=zzz", { scroll: false });
    expect(screen.getByRole("button", { name: "Include hidden files" })).toBeInTheDocument();
  });

  it("shows a result from another folder there, selected", async () => {
    routes = [
      { match: "/api/files/search", route: { status: 200, body: searchBody([item("deep.txt", "/root/docs/sub")]) } },
      { match: "/api/files/list", route: { status: 200, body: listing(["notes.txt"]) } },
    ];
    renderPage();
    await screen.findByText("notes.txt");
    fireEvent.change(field(), { target: { value: "deep" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    const row = await screen.findByRole("row");
    const trigger = within(row).getByRole("button", { name: "Actions for deep.txt" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    const menu = await screen.findByRole("menu");
    // Results can't be renamed, moved or deleted from here.
    expect(within(menu).queryByRole("menuitem", { name: /Rename|Move|Delete/ })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Show in folder" }));
    expect(nav.replace).toHaveBeenCalledWith("/dashboard/files?path=%2Froot%2Fdocs%2Fsub&reveal=deep.txt", { scroll: false });
  });

  it("opens with ?reveal= selecting that item", async () => {
    nav.search = "path=%2Froot%2Fdocs%2Fsub&reveal=deep.txt";
    routes = [{ match: "/api/files/list", route: { status: 200, body: listing(["a.txt", "deep.txt", "z.txt"], "/root/docs/sub") } }];
    renderPage();
    await screen.findByText("deep.txt");
    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('tr[data-file-path="/root/docs/sub/deep.txt"]');
      expect(found).toHaveAttribute("aria-selected", "true");
      return found!;
    });
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    expect(row.tabIndex).toBe(0);
  });

  it("selects and acts on visible items only", async () => {
    routes = [{ match: "/api/files/list", route: { status: 200, body: listing(["alpha.txt", "beta.txt", "alpine.txt", "gamma.txt"]) } }];
    renderPage();
    await screen.findByText("beta.txt");
    fireEvent.click(screen.getByRole("button", { name: "Select beta.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "Select alpha.txt" }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    fireEvent.change(field(), { target: { value: "alp" } });
    // beta.txt is hidden by the filter, so it leaves the selection.
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    const clicks: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(decodeURIComponent(this.href.split("path=")[1] ?? ""));
    });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(clicks.sort()).toEqual(["/root/docs/alpha.txt", "/root/docs/alpine.txt"]);
    click.mockRestore();

    fireEvent.change(field(), { target: { value: "" } });
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });
});
