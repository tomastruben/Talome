/**
 * The App Store's toolbar in a desktop window and in classic mode (phones):
 *
 * - A window's title bar holds only the window controls, Back and the title.
 *   The page publishes no title-bar actions (it used to publish My Apps and
 *   Installed); Create sits in the toolbar row, before the search (Finder
 *   order: view, verbs, search), and opens the Assistant.
 * - Classic mode keeps Create in the page header, so the toolbar has none.
 * - On touch the category pills and source tabs are 44px targets, and the
 *   tab strip scrolls sideways instead of pushing a phone's page sideways.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard/apps",
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
const mode = vi.hoisted(() => ({ embedded: true }));
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => mode.embedded }));
vi.mock("@/hooks/use-system-stats", () => ({ useSystemStats: () => ({ stats: null }) }));

import AppsPage from "@/app/dashboard/apps/page";
import { WindowToolbarSlot } from "@/components/desktop/window-content";
import { desktopAppActionsAtom } from "@/atoms/desktop-app-actions";

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  const body = url.includes("/api/apps/categories")
    ? ["media", "ai"]
    : url.includes("/api/stores")
      ? [
          { id: "umbrel", type: "umbrel", name: "Umbrel" },
          { id: "talome", type: "talome", name: "Talome" },
          { id: "casaos", type: "casaos", name: "CasaOS" },
          { id: "user-apps", type: "user-created", name: "My Apps" },
        ]
      : url.includes("/api/stacks")
        ? { stacks: [] }
        : [];
  return { ok: true, status: 200, json: async () => body } as Response;
});

let store: ReturnType<typeof createStore>;

function renderPage() {
  store = createStore();
  return render(
    <Provider store={store}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        {mode.embedded && (
          <div data-testid="toolbar-slot">
            <WindowToolbarSlot />
          </div>
        )}
        <AppsPage />
      </SWRConfig>
    </Provider>,
  );
}

beforeEach(() => {
  mode.embedded = true;
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App Store in a desktop window", () => {
  it("puts Create in the toolbar, before the search, and publishes no title-bar actions", async () => {
    renderPage();
    const toolbar = await screen.findByTestId("toolbar-slot");
    const create = await within(toolbar).findByRole("link", { name: "Create app" });
    expect(create).toHaveAttribute("href", "/dashboard/assistant?prompt=I+want+to+create+a+new+app");
    const search = within(toolbar).getByRole("textbox", { name: "Search apps" });
    expect(create.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(create).toHaveAccessibleName("Create app");
    expect(create).toHaveClass("pointer-coarse:size-11");
    // The title bar keeps only the window controls, Back and the title
    expect(store.get(desktopAppActionsAtom)).toEqual([]);
  });

  it("reaches My Apps, Installed and categories from one compact menu", async () => {
    renderPage();
    const toolbar = await screen.findByTestId("toolbar-slot");
    const view = await within(toolbar).findByRole("button", { name: "View options" });
    fireEvent.keyDown(view, { key: "Enter" });
    expect(await screen.findByRole("menuitemradio", { name: "My Apps" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Installed" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Media" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "All apps" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Installed" }));
    expect(within(toolbar).queryByRole("tablist")).toBeNull();
  });

  it("keeps search in the header row and preserves its query when collapsed", async () => {
    renderPage();
    const toolbar = await screen.findByTestId("toolbar-slot");
    const search = within(toolbar).getByRole("textbox", { name: "Search apps" });
    const field = search.closest(".search-field");
    expect(field).toHaveClass("min-w-0", "flex-1");
    expect(field?.parentElement).toHaveClass("flex", "flex-nowrap");
    fireEvent.click(within(toolbar).getByRole("button", { name: "Search apps", exact: true }));
    fireEvent.change(search, { target: { value: "coffee" } });
    fireEvent.click(within(toolbar).getByRole("button", { name: "Collapse search" }));
    expect(search).toHaveValue("coffee");
    expect(within(toolbar).getByRole("button", { name: "Search apps, filtered by coffee" })).toHaveAttribute("aria-expanded", "false");
    expect(within(toolbar).queryByRole("tablist")).toBeNull();
  });
});

describe("App Store in classic mode", () => {
  it("leaves Create to the page header", async () => {
    mode.embedded = false;
    renderPage();
    await screen.findByRole("textbox", { name: "Search apps" });
    await screen.findByRole("button", { name: "Media" });
    expect(screen.queryByRole("link", { name: "Create" })).toBeNull();
  });
});

describe("App Store on touch", () => {
  it("makes every category pill a 44px target with an inset focus ring", async () => {
    mode.embedded = false;
    renderPage();
    await screen.findByRole("button", { name: "Media" });
    for (const name of ["All", "Media", "AI"]) {
      const pill = screen.getByRole("button", { name });
      expect(pill).toHaveAttribute("aria-pressed");
      expect(pill).toHaveClass("h-6", "pointer-coarse:h-11", "pointer-coarse:px-3", "focus-visible:ring-inset");
    }
  });

  it("makes every source tab a 44px target in a strip that scrolls sideways", async () => {
    mode.embedded = false;
    renderPage();
    const tablist = await screen.findByRole("tablist");
    await within(tablist).findByRole("tab", { name: "CasaOS" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent || tab.getAttribute("aria-label"))).toEqual([
      "All",
      "Umbrel",
      "Talome",
      "CasaOS",
      "My Apps",
      "Installed",
    ]);
    for (const tab of tabs) expect(tab).toHaveClass("pointer-coarse:h-11");
    // With every source, the strip is wider than a 375px phone: it scrolls in
    // its own row rather than widening the page.
    const strip = tablist.closest('[data-slot="tabs"]');
    expect(strip).toHaveClass("min-w-0", "max-w-full", "overflow-x-auto");
  });
});
