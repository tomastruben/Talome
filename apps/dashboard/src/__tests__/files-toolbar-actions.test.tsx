/**
 * Files' verbs and selection bar, in a desktop window and in classic mode:
 *
 * - A window's title bar holds only Back and the title, so Files publishes no
 *   title-bar actions; Upload (Files… or Folder…) and New folder sit at the
 *   trailing end of the toolbar, before the search field (Finder order).
 * - Classic mode reaches the same verbs from the page header.
 * - The selection bar floats above the status bar (whatever its height on a
 *   phone) and its buttons keep their names when the labels are hidden.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SWRConfig } from "swr";
import { Provider, createStore } from "jotai";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn() }) }));
const mode = vi.hoisted(() => ({ embedded: true }));
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => mode.embedded }));
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
import { desktopAppActionsAtom } from "@/atoms/desktop-app-actions";
import { pageActionAtom } from "@/atoms/page-action";

const SRC = join(__dirname, "..");

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/api/files/list")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        path: "/root/docs",
        parent: "/root",
        allowedRoots: ["/root"],
        roots: [{ id: "root", path: "/root", label: "Files", kind: "talome-files" }],
        items: ["a.txt", "b.txt"].map((name) => ({
          name,
          path: `/root/docs/${name}`,
          isDirectory: false,
          size: 10,
          modified: "2026-09-29T10:00:00.000Z",
        })),
      }),
    } as Response;
  }
  return { ok: false, status: 500, json: async () => ({ error: "not mocked" }) } as Response;
});

let store: ReturnType<typeof createStore>;

function renderWindow() {
  store = createStore();
  return render(
    <Provider store={store}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <main className="@container/window flex">
          <WindowSidebarSlot />
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

function renderClassic() {
  store = createStore();
  return render(
    <Provider store={store}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <FilesPage />
      </SWRConfig>
    </Provider>,
  );
}

function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  return screen.findByRole("menu");
}

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  mode.embedded = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Files verbs in a window", () => {
  it("publishes no title-bar actions and puts Upload and New folder in the toolbar, before the search", async () => {
    renderWindow();
    await screen.findByText("a.txt");

    expect(store.get(desktopAppActionsAtom)).toEqual([]);
    const toolbar = screen.getByTestId("toolbar-slot");
    const upload = within(toolbar).getByRole("button", { name: "Upload" });
    const newFolder = within(toolbar).getByRole("button", { name: "New folder" });
    const search = within(toolbar).getByRole("combobox", { name: "Search docs" });
    // Finder order: verbs, then the search field at the trailing end
    expect(upload.compareDocumentPosition(newFolder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(newFolder.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Icon buttons with names where the column is narrow, labelled where it's wide
    expect(within(upload).getByText("Upload").className).toMatch(/sr-only @2xl:not-sr-only/);
    // Classic's header action stays empty in a window
    expect(store.get(pageActionAtom)).toBeNull();
  });

  it("uploads a folder from the Upload menu (regression: only files could be uploaded in a window)", async () => {
    renderWindow();
    await screen.findByText("a.txt");
    const clicked: HTMLInputElement[] = [];
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      clicked.push(this);
    });

    const menu = await openMenu(within(screen.getByTestId("toolbar-slot")).getByRole("button", { name: "Upload" }));
    expect(within(menu).getByRole("menuitem", { name: "Files…" })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Folder…" }));
    });
    expect(clicked).toHaveLength(1);
    expect(clicked[0].hasAttribute("webkitdirectory")).toBe(true);
  });

  it("shows a named selection bar above the column's bottom edge", async () => {
    renderWindow();
    await screen.findByText("a.txt");
    fireEvent.click(screen.getByRole("button", { name: "Select a.txt" }));

    const bar = await screen.findByRole("group", { name: "1 selected" });
    for (const name of ["Move", "Download", "Delete"]) {
      const button = within(bar).getByRole("button", { name });
      expect(button.className).toMatch(/pointer-coarse:h-11/);
      expect(within(button).getByText(name).className).toMatch(/sr-only @md:not-sr-only/);
    }
    expect(within(bar).getByRole("button", { name: "Delete" }).className).toMatch(/text-status-critical-inverse/);
    // Anchored to the status bar's place; in a window the status bar lives on the window's edge
    const anchor = bar.closest("[data-files-bottom]")!;
    expect(anchor).not.toBeNull();
    expect(anchor.className).toMatch(/relative/);
    expect(bar.parentElement!.className).toMatch(/absolute inset-x-0 bottom-full mb-3/);
    expect(within(screen.getByTestId("statusbar-slot")).getByRole("navigation", { name: "Folder path" })).toBeInTheDocument();
  });
});

describe("Files verbs in classic mode", () => {
  it("reaches Upload (files or a folder) and New folder from the page header", async () => {
    mode.embedded = false;
    renderClassic();
    await screen.findByText("a.txt");

    expect(store.get(desktopAppActionsAtom)).toEqual([]);
    const { container } = render(<>{store.get(pageActionAtom)}</>);
    const header = within(container);
    expect(header.getByRole("button", { name: "New folder" })).toBeInTheDocument();
    // site-header renders the action straight into its title-first flex row:
    // one wrapper pushes the verbs to the trailing end (regression: they sat
    // beside the title as two loose buttons)
    expect(container.childElementCount).toBe(1);
    expect((container.firstElementChild as HTMLElement).className).toMatch(/\bml-auto\b/);
    expect((container.firstElementChild as HTMLElement).className).toMatch(/\bshrink-0\b/);
    const menu = await openMenu(header.getByRole("button", { name: "Upload" }));
    expect(within(menu).getByRole("menuitem", { name: "Files…" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Folder…" })).toBeInTheDocument();
  });

  it("floats the selection bar above the status bar, not over it (regression: covered it on iPhone)", async () => {
    mode.embedded = false;
    const { container } = renderClassic();
    await screen.findByText("a.txt");
    fireEvent.click(screen.getByRole("button", { name: "Select a.txt" }));
    const bar = await screen.findByRole("group", { name: "1 selected" });

    // The anchor wraps the status bar, so the bar's offset follows the bar's real
    // height (44px touch targets plus the home indicator's safe area).
    const anchor = bar.closest("[data-files-bottom]")!;
    expect(within(anchor as HTMLElement).getByRole("navigation", { name: "Folder path" })).toBeInTheDocument();
    expect(bar.parentElement!.className).toMatch(/bottom-full/);
    expect(container.innerHTML).not.toMatch(/bottom-14/);
  });
});

describe("Files on touch", () => {
  it("shows the row select mark and row menu without hover where there is no hover", () => {
    const page = readFileSync(join(SRC, "app/dashboard/files/page.tsx"), "utf-8");
    // Hover reveal only with a mouse or trackpad (iPad in classic mode is sm+ and touch)
    expect(page).not.toMatch(/sm:opacity-0/);
    expect(page).not.toMatch(/"opacity-0 group-hover:opacity-100/);
    expect(page).toMatch(/pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100/);
    const header = readFileSync(join(SRC, "components/files/files-list-header.tsx"), "utf-8");
    expect(header).toMatch(/pointer-fine:opacity-0 pointer-fine:group-hover\/header:opacity-100/);
    expect(header).toMatch(/pointer-coarse:size-11/);
  });
});
