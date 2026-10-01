/**
 * Files in a desktop window: a fill route that owns its column, with no
 * negative margins against shell padding, no opaque or blurred surfaces of its
 * own (the window's glass shows through), states that fill the column, and a
 * toolbar, sidebar and status bar that stay when a folder fails to open.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { Provider, createStore } from "jotai";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }) }));
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => true }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("path=%2Froot%2Fdocs"),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard/files",
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/hooks/use-system-stats", () => ({ useSystemStats: () => ({ stats: null }) }));

import FilesPage from "@/app/dashboard/files/page";
import { WindowSidebarSlot } from "@/components/ui/source-list";
import { WindowStatusBarSlot, WindowToolbarSlot } from "@/components/desktop/window-content";

type Route = { status: number; body: unknown };
let routes: Array<{ match: string; route: Route }>;
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  const hit = routes.find((r) => url.includes(r.match));
  const route = hit?.route ?? { status: 500, body: { error: "not mocked" } };
  return { ok: route.status >= 200 && route.status < 300, status: route.status, json: async () => route.body } as Response;
});

const listing = (names: string[], path = "/root/docs") => ({
  path,
  parent: "/root",
  allowedRoots: ["/root"],
  roots: [{ id: "root", path: "/root", label: "Files", kind: "talome-files" }],
  items: names.map((name) => ({
    name,
    path: `${path}/${name}`,
    isDirectory: !name.includes("."),
    size: 10,
    modified: "2026-09-29T10:00:00.000Z",
  })),
});

/** The window shell's content column, as dashboard-shell.tsx lays it out. */
function renderWindow() {
  return render(
    <Provider store={createStore()}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <main className="@container/window flex">
          <div data-testid="sidebar-slot">
            <WindowSidebarSlot />
          </div>
          <div data-window-content="" className="tm-window-content @container/content flex flex-col">
            <div data-testid="toolbar-slot">
              <WindowToolbarSlot />
            </div>
            <div data-content-scroll="" data-window-layout="fill" data-testid="files-column" className="flex flex-col">
              <FilesPage />
            </div>
            <div data-testid="statusbar-slot">
              <WindowStatusBarSlot />
            </div>
          </div>
        </main>
      </SWRConfig>
    </Provider>,
  );
}

const classesIn = (root: Element) =>
  [root, ...root.querySelectorAll("*")].map((el) => el.getAttribute("class") ?? "").filter(Boolean);

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("files in a window", () => {
  it("fills its column without negative margins, and paints no opaque or blurred surface", async () => {
    routes = [{ match: "/api/files/list", route: { status: 200, body: listing(["a.txt", "Photos"]) } }];
    renderWindow();
    await screen.findByText("a.txt");

    const column = screen.getByTestId("files-column");
    const all = [...classesIn(column), ...classesIn(screen.getByTestId("toolbar-slot")), ...classesIn(screen.getByTestId("statusbar-slot"))];
    for (const cls of all) {
      expect(cls).not.toMatch(/(^|\s)-m-4(\s|$)/);
      expect(cls).not.toMatch(/backdrop-blur/);
      expect(cls).not.toMatch(/bg-background\//);
      expect(cls).not.toMatch(/bg-white/);
      expect(cls).not.toMatch(/from-background/);
    }
    // The list scrolls in its own scroller between the header and the window's status bar.
    const scroller = column.querySelector("#files-results")!;
    expect(scroller.className).toMatch(/min-h-0 flex-1 overflow-y-auto/);
    expect(scroller.parentElement!.className).toBe("relative flex min-h-0 flex-1 flex-col");
  });

  it("puts the search in the window's toolbar and the path in its status bar", async () => {
    routes = [{ match: "/api/files/list", route: { status: 200, body: listing(["a.txt"]) } }];
    renderWindow();
    await screen.findByText("a.txt");

    const toolbar = screen.getByTestId("toolbar-slot");
    expect(within(toolbar).getByRole("combobox", { name: "Search docs" })).toBeInTheDocument();
    expect(toolbar.querySelector("[data-desktop-app-toolbar]")).not.toBeNull();

    const statusBar = screen.getByTestId("statusbar-slot");
    expect(statusBar.querySelector("[data-window-statusbar]")).not.toBeNull();
    const path = within(statusBar).getByRole("navigation", { name: "Folder path" });
    expect(within(path).getByText("docs")).toHaveAttribute("aria-current", "page");
    expect(within(path).getByRole("button", { name: "Files" })).toBeInTheDocument();
    expect(within(statusBar).getByText("1 item")).toBeInTheDocument();
  });

  it("shows an empty folder as a state that fills the column, without a dashed card", async () => {
    routes = [{ match: "/api/files/list", route: { status: 200, body: listing([]) } }];
    renderWindow();
    const title = await screen.findByText("This folder is empty");
    const state = title.closest('[data-slot="empty-state"]')!;
    expect(state).not.toBeNull();
    expect(state.className).not.toMatch(/border-dashed/);
    expect(state.className).toMatch(/flex-1/);
    expect(state.parentElement!.className).toMatch(/flex min-h-full flex-col/);
    expect(screen.getByText("Drop files here, or upload them.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload files" })).toBeInTheDocument();
  });

  it("toggles hidden files with a pressed button", async () => {
    routes = [{ match: "/api/files/list", route: { status: 200, body: listing(["a.txt"]) } }];
    renderWindow();
    await screen.findByText("a.txt");
    const toggle = screen.getByRole("button", { name: "Hidden files" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("showHidden=true"))).toBe(true);
  });

  it("keeps the sidebar, toolbar and status bar when a folder fails to open", async () => {
    routes = [
      { match: "path=%2Froot%2Fdocs%2Fgone", route: { status: 404, body: { error: "This folder doesn't exist any more." } } },
      { match: "/api/files/list", route: { status: 200, body: listing(["gone", "a.txt"]) } },
    ];
    renderWindow();
    fireEvent.click(await screen.findByText("gone"));

    expect(await screen.findByText("gone isn't there any more")).toBeInTheDocument();
    const error = screen.getByText("gone isn't there any more").closest('[data-slot="error-state"]')!;
    expect(error.className).not.toMatch(/border-dashed/);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to Files" })).toBeInTheDocument();

    expect(within(screen.getByTestId("sidebar-slot")).getByRole("navigation", { name: "Files sidebar" })).toBeInTheDocument();
    expect(within(screen.getByTestId("toolbar-slot")).getByRole("combobox")).toBeInTheDocument();
    const statusBar = screen.getByTestId("statusbar-slot");
    expect(statusBar.querySelector("[data-window-statusbar]")).not.toBeNull();
    expect(within(statusBar).getByRole("button", { name: "Hidden files" })).toBeInTheDocument();
  });
});
