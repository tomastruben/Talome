/**
 * Settings in a desktop window: when the window is wide enough its sections
 * live in the window's sidebar (search, General, one section per category,
 * the amber approvals count), the page doesn't repeat the category list, and
 * a narrow window pushes from the index. Classic mode keeps its own aside.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

const nav = vi.hoisted(() => ({ path: "/dashboard/settings/security" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
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
const user = vi.hoisted(() => ({ isAdmin: true }));
vi.mock("@/hooks/use-user", () => ({ useUser: () => ({ isAdmin: user.isAdmin, user: { role: user.isAdmin ? "admin" : "member" } }) }));
const approvals = vi.hoisted(() => ({ count: 2 }));
vi.mock("@/components/trust/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/trust/api")>()),
  usePendingApprovals: () => ({ pending: [], count: approvals.count, error: undefined, isLoading: false, mutate: vi.fn() }),
}));
// The window decides: whether its sidebar slot is on screen (a container query).
const sidebarShown = vi.hoisted(() => ({ value: true }));
vi.mock("@/components/ui/source-list", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/source-list")>()),
  useWindowSidebarShown: () => embedded.value && sidebarShown.value,
}));
vi.mock("@/components/system/services-section", () => ({ ServicesSection: () => null }));

import SettingsLayout from "@/app/dashboard/settings/layout";
import SettingsPage from "@/app/dashboard/settings/page";
import { WindowSidebarSlot } from "@/components/ui/source-list";

const width = vi.hoisted(() => ({ value: 1200 }));

function renderSettings() {
  return render(
    <Provider store={createStore()}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        {embedded.value && <WindowSidebarSlot />}
        <SettingsLayout>
          <SettingsPage />
        </SettingsLayout>
      </SWRConfig>
    </Provider>,
  );
}

const windowSidebar = () => screen.getByRole("navigation", { name: "Settings" });

beforeEach(() => {
  nav.path = "/dashboard/settings";
  embedded.value = true;
  sidebarShown.value = true;
  user.isAdmin = true;
  approvals.count = 2;
  width.value = 1200;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width.value });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Settings in a desktop window", () => {
  it("lists the sections in the window sidebar and doesn't repeat them in the page", () => {
    renderSettings();
    const sidebar = windowSidebar();
    expect(within(sidebar).getByRole("link", { name: "General" })).toHaveAttribute("aria-current", "page");
    expect(within(sidebar).getByRole("heading", { name: "Infrastructure" })).toBeInTheDocument();
    // Each section once: in the sidebar, not again as the page's category list
    expect(screen.getAllByRole("link", { name: /Users & Access/ })).toHaveLength(1);
    // No classic aside or its sidebar
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull();
  });

  it("marks the open section current", () => {
    nav.path = "/dashboard/settings/security";
    renderSettings();
    const sidebar = windowSidebar();
    expect(within(sidebar).getByRole("link", { name: "Security" })).toHaveAttribute("aria-current", "page");
    expect(within(sidebar).getByRole("link", { name: "General" })).not.toHaveAttribute("aria-current");
  });

  it("pushes from the index when the window is too narrow for its sidebar", () => {
    sidebarShown.value = false;
    renderSettings();
    // The page lists the categories itself (the stack's index)
    expect(screen.getAllByRole("link", { name: /Users & Access/ }).length).toBeGreaterThanOrEqual(1);
    const pageLinks = screen.getAllByRole("link", { name: /Users & Access/ }).filter((link) => !windowSidebar().contains(link));
    expect(pageLinks).toHaveLength(1);
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull();
  });

  it("shows admin-only sections to admins only", () => {
    user.isAdmin = false;
    renderSettings();
    const sidebar = windowSidebar();
    expect(within(sidebar).queryByRole("link", { name: /Approvals/ })).toBeNull();
    expect(within(sidebar).queryByRole("link", { name: "Security" })).toBeNull();
    expect(within(sidebar).getByRole("link", { name: "AI Provider" })).toBeInTheDocument();
  });

  it("carries the amber count on Approvals while some wait", () => {
    renderSettings();
    const link = within(windowSidebar()).getByRole("link", { name: /Approvals/ });
    // jsdom has no layout, so it joins the inline parts without spaces
    expect(link).toHaveAccessibleName(/^Approvals\s*2\s*waiting$/);
    expect(link.querySelector('[data-variant="count"]')).toHaveTextContent("2");
  });

  it("shows no count when nothing waits", () => {
    approvals.count = 0;
    renderSettings();
    const link = within(windowSidebar()).getByRole("link", { name: /Approvals/ });
    expect(link).toHaveAccessibleName("Approvals");
    expect(link.querySelector('[data-variant="count"]')).toBeNull();
  });

  it("filters by search, says when nothing matches, and Escape clears", () => {
    renderSettings();
    const sidebar = windowSidebar();
    const search = within(sidebar).getByRole("searchbox", { name: "Search settings" });

    fireEvent.change(search, { target: { value: "memory" } });
    expect(within(sidebar).getByRole("link", { name: "Memory" })).toBeInTheDocument();
    expect(within(sidebar).queryByRole("link", { name: "Security" })).toBeNull();

    fireEvent.change(search, { target: { value: "zzz" } });
    expect(within(sidebar).getByText("No settings match “zzz”.")).toBeInTheDocument();

    fireEvent.keyDown(search, { key: "Escape" });
    expect(search).toHaveValue("");
    expect(within(sidebar).getByRole("link", { name: "Security" })).toBeInTheDocument();
  });
});

describe("Settings in classic mode", () => {
  it("keeps its own aside at 900px and wider, with the same amber count", () => {
    embedded.value = false;
    width.value = 1000;
    renderSettings();
    const aside = screen.getByRole("navigation", { name: "Settings sections" });
    expect(screen.queryByRole("navigation", { name: "Settings" })).toBeNull();
    expect(within(aside).getByRole("link", { name: /Approvals/ })).toHaveAccessibleName(/^Approvals\s*2\s*waiting$/);
    expect(within(aside).getByRole("link", { name: /Approvals/ }).querySelector('[data-variant="count"]')).not.toBeNull();
  });

  it("pushes from the index below 900px", () => {
    embedded.value = false;
    width.value = 700;
    renderSettings();
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull();
    // The index lists the categories, in sentence case (no uppercase micro-labels)
    const label = screen.getByText("Infrastructure");
    expect(label.className).not.toMatch(/uppercase/);
    expect(screen.getByRole("link", { name: /Approvals/ })).toHaveAccessibleName(/2\s*waiting$/);
  });
});
