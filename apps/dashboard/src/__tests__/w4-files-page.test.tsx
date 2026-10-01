/**
 * Files reliability (design P0-12): a failed listing is an error with Retry,
 * a single-file delete asks first, "New" picks a free name, and an oversized
 * text file opens a "Too large" Quick Look.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { SWRConfig } from "swr";
import { Provider, createStore } from "jotai";

const { toastFns } = vi.hoisted(() => ({
  toastFns: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn(() => "t1") },
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toastFns) }));

const nav = vi.hoisted(() => ({ path: "/root/docs" as string | null }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.path ? `path=${encodeURIComponent(nav.path)}` : ""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/hooks/use-system-stats", () => ({ useSystemStats: () => ({ stats: null }) }));

import FilesPage from "@/app/dashboard/files/page";
import { ConfirmDialogHost, confirmStore } from "@/components/ui/confirm-dialog";
import { pageActionAtom } from "@/atoms/page-action";

type Route = { status: number; body: unknown };
let routes: Array<{ method: string; match: string; route: Route | (() => Route) }>;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const hit = routes.find((r) => r.method === method && url.includes(r.match));
  const route = hit ? (typeof hit.route === "function" ? hit.route() : hit.route) : { status: 500, body: { error: "not mocked" } };
  return { ok: route.status >= 200 && route.status < 300, status: route.status, json: async () => route.body } as Response;
});

const listing = (items: Array<{ name: string; isDirectory?: boolean; size?: number }>) => ({
  path: "/root/docs",
  parent: "/root",
  allowedRoots: ["/root"],
  roots: [{ id: "root", path: "/root", label: "Files", kind: "talome-files" }],
  items: items.map((i) => ({
    name: i.name,
    path: `/root/docs/${i.name}`,
    isDirectory: !!i.isDirectory,
    size: i.size ?? 10,
    modified: "2026-09-29T10:00:00.000Z",
  })),
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

async function openRowMenu(name: string) {
  const row = (await screen.findByText(name)).closest("tr")!;
  const trigger = within(row).getByRole("button", { name: "File actions" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  return screen.findByRole("menu");
}

beforeEach(() => {
  // jsdom has no scrolling.
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  Object.values(toastFns).forEach((fn) => fn.mockClear());
  nav.path = "/root/docs";
});

afterEach(() => {
  confirmStore.reset();
  vi.unstubAllGlobals();
});

describe("files page", () => {
  it("shows an error with Retry when the listing fails (regression: skeleton forever)", async () => {
    let fail = true;
    routes = [
      {
        method: "GET",
        match: "/api/files/list",
        route: () => (fail ? { status: 403, body: { error: "Access denied" } } : { status: 200, body: listing([{ name: "a.txt" }]) }),
      },
    ];
    renderPage();
    expect(await screen.findByText("Talome can't open docs")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("a.txt")).toBeInTheDocument();
  });

  it("asks before deleting a single file (regression: instant, permanent delete)", async () => {
    routes = [
      { method: "GET", match: "/api/files/list", route: { status: 200, body: listing([{ name: "report.pdf" }]) } },
      { method: "DELETE", match: "/api/files", route: { status: 200, body: { ok: true } } },
    ];
    renderPage();
    const menu = await openRowMenu("report.pdf");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Delete permanently/ }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete report.pdf permanently?")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
  });

  it("creates New Folder 2 when New Folder exists (regression: silent no-op)", async () => {
    routes = [
      { method: "GET", match: "/api/files/list", route: { status: 200, body: listing([{ name: "New Folder", isDirectory: true }]) } },
      { method: "POST", match: "/api/files/mkdir", route: { status: 200, body: { ok: true } } },
    ];
    renderPage();
    await screen.findByText("New Folder");
    const actions = store.get(pageActionAtom);
    expect(actions).toBeTruthy();
    // Scoped to the header actions: rows now carry "Select New Folder" buttons too.
    const { container } = render(<>{actions}</>);
    await act(async () => {
      fireEvent.click(within(container).getByRole("button", { name: /New/ }));
    });
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/files/mkdir"))).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/files/mkdir"))!;
    expect(JSON.parse(String(init?.body))).toEqual({ path: "/root/docs/New Folder 2" });
  });

  it("opens a Too large preview for text over 5MB (regression: click did nothing)", async () => {
    routes = [
      { method: "GET", match: "/api/files/list", route: { status: 200, body: listing([{ name: "huge.log", size: 12 * 1024 * 1024 }]) } },
    ];
    renderPage();
    fireEvent.click(await screen.findByText("huge.log"));
    expect(await screen.findByText("Too large to preview")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/files/read"))).toBe(false);
  });

  it("shows a Move dialog error for any folder, not just the first (regression: silent 403 in a subfolder)", async () => {
    const sub = {
      ...listing([]),
      path: "/root/docs/sub",
      parent: "/root/docs",
    };
    let subFails = true;
    routes = [
      {
        method: "GET",
        match: "path=%2Froot%2Fdocs%2Fsub",
        route: () => (subFails ? { status: 403, body: { error: "Access denied" } } : { status: 200, body: sub }),
      },
      { method: "GET", match: "/api/files/list", route: { status: 200, body: listing([{ name: "sub", isDirectory: true }, { name: "a.txt" }]) } },
    ];
    renderPage();
    const menu = await openRowMenu("a.txt");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Move to/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: /^sub$/ }));

    expect(await within(dialog).findByText("Talome can't open sub")).toBeInTheDocument();
    // "Move here" must not point at the folder still on screen.
    expect(within(dialog).getByRole("button", { name: "Move here" })).toBeDisabled();

    subFails = false;
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(await within(dialog).findByText("No subfolders")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Move here" })).toBeEnabled();
  });

  it("offers Back to the last folder after a failed click", async () => {
    routes = [
      { method: "GET", match: "path=%2Froot%2Fdocs%2Fsub", route: { status: 404, body: { error: "gone" } } },
      { method: "GET", match: "/api/files/list", route: { status: 200, body: listing([{ name: "sub", isDirectory: true }, { name: "a.txt" }]) } },
    ];
    renderPage();
    const menu = await openRowMenu("a.txt");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Move to/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: /^sub$/ }));
    expect(await within(dialog).findByText("sub isn't there any more")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(await within(dialog).findByRole("button", { name: /^sub$/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Move here" })).toBeEnabled();
  });
});
