/**
 * Files on a phone (classic layout, coarse pointer):
 *
 * - The search scope switch (This folder / Include subfolders) shows at every
 *   width. Below `@md` it takes its own full-width row under the field, so
 *   after the keyboard's Search key (Enter, a subfolder search) a phone can go
 *   back to filtering the folder without retyping the query.
 * - The list header's Select all mark is a 44px target in a 44px row, like the
 *   rows' own marks.
 * - The toolbar search field is 44px tall on touch, like its Clear button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { SWRConfig } from "swr";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn() }) }));
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => false }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("path=%2Froot%2Fdocs"),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard/files",
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/hooks/use-system-stats", () => ({ useSystemStats: () => ({ stats: null }) }));

import FilesPage from "@/app/dashboard/files/page";

const file = (name: string, dir = "/root/docs") => ({
  name,
  path: `${dir}/${name}`,
  isDirectory: false,
  size: 10,
  modified: "2026-09-29T10:00:00.000Z",
});

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/api/files/search")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        path: "/root/docs",
        query: "report",
        items: [file("report.pdf", "/root/docs/2024")],
        truncated: null,
        skipped: 0,
        limits: { results: 200, maxDepth: 12, timeBudgetMs: 4000, maxEntries: 100000 },
        elapsedMs: 12,
      }),
    } as Response;
  }
  if (url.includes("/api/files/list")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        path: "/root/docs",
        parent: "/root",
        allowedRoots: ["/root"],
        roots: [{ id: "root", path: "/root", label: "Files", kind: "talome-files" }],
        items: ["q3 report.txt", "notes.txt", "photo.jpg"].map((name) => file(name)),
      }),
    } as Response;
  }
  return { ok: false, status: 500, json: async () => ({ error: "not mocked" }) } as Response;
});

function renderClassic() {
  const store = createStore();
  return render(
    <Provider store={store}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <FilesPage />
      </SWRConfig>
    </Provider>,
  );
}

const field = () => screen.getByRole("combobox", { name: "Search docs" });

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Files search scope on a phone", () => {
  it("shows the switch at every width, as a full-width row under the field below @md", async () => {
    renderClassic();
    await screen.findByText("notes.txt");
    // No query: nothing to scope
    expect(screen.queryByRole("group", { name: "Where to search" })).toBeNull();

    fireEvent.change(field(), { target: { value: "report" } });
    const scope = screen.getByRole("group", { name: "Where to search" });
    // Regression: `hidden @md:flex` hid it on every phone
    expect(scope).not.toHaveClass("hidden");
    expect(scope).toHaveClass("flex", "w-full", "order-last", "@md:order-none", "@md:w-auto");
    // The toolbar wraps, so the switch gets its own row
    expect(scope.parentElement).toHaveClass("flex-wrap");
    for (const name of ["This folder", "Include subfolders"]) {
      const item = within(scope).getByRole("radio", { name });
      expect(item).toHaveClass("flex-1", "@md:flex-none", "pointer-coarse:h-11");
    }
  });

  it("goes back to filtering the folder after the keyboard's Search key, keeping the query", async () => {
    renderClassic();
    await screen.findByText("notes.txt");
    fireEvent.change(field(), { target: { value: "report" } });
    // The iOS keyboard's Search key is Enter: a subfolder search
    fireEvent.keyDown(field(), { key: "Enter" });
    await screen.findByRole("grid", { name: "Results for “report”" });
    const scope = screen.getByRole("group", { name: "Where to search" });
    expect(within(scope).getByRole("radio", { name: "Include subfolders" })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(within(scope).getByRole("radio", { name: "This folder" }));
    await waitFor(() => expect(screen.queryByRole("grid", { name: "Results for “report”" })).toBeNull());
    expect(field()).toHaveValue("report");
    expect(within(scope).getByRole("radio", { name: "This folder" })).toHaveAttribute("aria-checked", "true");
    // The folder, filtered by the same query
    expect(screen.getByText("1 of 3 items")).toBeInTheDocument();
    expect(screen.queryByText("notes.txt")).toBeNull();
  });
});

describe("Files touch targets", () => {
  it("makes Select all a 44px target in a 44px header row", async () => {
    renderClassic();
    await screen.findByText("notes.txt");
    const selectAll = screen.getByRole("button", { name: "Select all" });
    expect(selectAll).toHaveClass("pointer-coarse:size-11");
    const row = selectAll.closest("tr")!;
    // The rows are pointer-coarse:h-11; the header matches so the mark isn't cramped
    expect(row).toHaveClass("[&>th]:h-9", "pointer-coarse:[&>th]:h-11");
  });

  it("makes the toolbar search field 44px tall on touch, like its Clear button", async () => {
    renderClassic();
    await screen.findByText("notes.txt");
    expect(field()).toHaveClass("h-8", "pointer-coarse:h-11", "pointer-coarse:text-base");
    fireEvent.change(field(), { target: { value: "report" } });
    expect(screen.getByRole("button", { name: "Clear search" })).toHaveClass("pointer-coarse:size-11");
  });
});
