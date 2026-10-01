import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ embedded: false, pathname: "/dashboard/media" }));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/hooks/use-desktop-mode", () => ({
  useIsEmbeddedFrame: () => state.embedded,
}));
vi.mock("@/hooks/use-user", () => ({
  useUser: () => ({ user: { authenticated: true, role: "admin", permissions: undefined }, isLoading: false }),
}));
vi.mock("@/lib/register-sw", () => ({ registerServiceWorker: vi.fn() }));

// The shell's providers and overlays are not what this test is about.
const { Pass, Nothing } = vi.hoisted(() => ({
  Pass: ({ children }: { children?: React.ReactNode }) => children,
  Nothing: () => null,
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: Pass,
  SidebarInset: ({ children }: { children?: React.ReactNode }) => <div data-testid="sidebar-inset">{children}</div>,
}));
vi.mock("@/components/layout/app-sidebar", () => ({ AppSidebar: Nothing }));
vi.mock("@/components/layout/site-header", () => ({ SiteHeader: Nothing }));
vi.mock("@/components/media/media-detail-context", () => ({ MediaDetailProvider: Pass }));
vi.mock("@/components/assistant/assistant-context", () => ({ AssistantProvider: Pass }));
vi.mock("@/components/assistant/command-palette-launcher", () => ({ CommandPaletteLauncher: Nothing }));
vi.mock("@/components/widgets/widget-edit-context", () => ({ WidgetEditProvider: Pass }));
vi.mock("@/components/automations/automation-context", () => ({ AutomationProvider: Pass }));
vi.mock("@/components/system-health-banner", () => ({ SystemHealthBanner: Nothing }));
vi.mock("@/components/quick-look/quick-look-context", () => ({ QuickLookProvider: Pass }));
vi.mock("@/components/quick-look/quick-look", () => ({ QuickLookModal: Nothing }));
vi.mock("@/components/bug-hunt/bug-hunt-context", () => ({ BugHuntProvider: Pass }));
vi.mock("@/components/bug-hunt/bug-hunt-launcher", () => ({ BugHuntLauncher: Nothing }));
vi.mock("@/components/media/cinema-browser-context", () => ({ CinemaBrowserProvider: Pass }));
vi.mock("@/components/media/cinema-browser-launcher", () => ({ CinemaBrowserLauncher: Nothing }));
vi.mock("@/components/notifications/notification-toast-bridge", () => ({ NotificationToastBridge: Nothing }));
vi.mock("@/components/audiobooks/global-audio-player", () => ({ AudiobookAudioEngine: Nothing, GlobalAudioPlayer: Nothing }));
vi.mock("@/components/desktop/desktop-app-action-bridge", () => ({ DesktopAppActionBridge: Nothing }));
vi.mock("@/components/desktop/desktop-audiobook-player-bridge", () => ({ DesktopAudiobookPlayerBridge: Nothing }));
vi.mock("@/components/desktop/desktop-shell-header-actions", () => ({ DesktopShellHeaderActions: Nothing }));

import { DashboardShell } from "@/components/layout/dashboard-shell";

function renderShell() {
  return render(
    <DashboardShell>
      <p>Page</p>
    </DashboardShell>,
  );
}

const scroller = () => document.querySelector<HTMLElement>("[data-content-scroll]");

describe("dashboard shell in a desktop window", () => {
  beforeEach(() => {
    state.embedded = true;
    state.pathname = "/dashboard/media";
  });

  it("pads and scrolls a page on a thin tint over the window's glass", () => {
    renderShell();

    const main = document.getElementById("main-content")!;
    expect(main).toHaveClass("@container/window");
    expect(main.className).not.toContain("[container-type:inline-size]");

    const content = document.querySelector<HTMLElement>("[data-window-content]")!;
    expect(content).toHaveClass("tm-window-content", "@container/content", "flex-col");
    // The window's glass shows through: nothing in the column paints opaque
    for (const el of [main, content, scroller()!]) {
      expect(el.className).not.toMatch(/\bbg-(background|black|card)\b/);
    }

    const scroll = scroller()!;
    expect(scroll).toHaveAttribute("data-window-layout", "page");
    expect(scroll).toHaveClass("tm-window-scroll", "overflow-y-auto");
    expect(scroll.className).not.toMatch(/\bp-\d/);
    expect(scroll).toHaveTextContent("Page");
    // Toolbar slot, scroller, status-bar slot, in that order, inside the column
    expect(scroll.parentElement).toBe(content);
    expect(content.firstElementChild).toHaveClass("contents");
    expect(content.lastElementChild).toHaveClass("contents");
    // The sidebar slot sits beside the column, on the glass
    expect(content.previousElementSibling).toHaveClass("@2xl/window:flex");
  });

  it("lets Files own its panes and its scroller", () => {
    state.pathname = "/dashboard/files";
    renderShell();

    const scroll = scroller()!;
    expect(scroll).toHaveAttribute("data-window-layout", "fill");
    expect(scroll).not.toHaveClass("tm-window-scroll");
    expect(scroll).toHaveClass("overflow-hidden");
  });

  it("gives the player no background of its own (it paints its own black)", () => {
    state.pathname = "/dashboard/player";
    renderShell();

    expect(scroller()).toHaveAttribute("data-window-layout", "fill");
    expect(scroller()!.className).not.toContain("bg-black");
  });
});

describe("dashboard shell in classic mode", () => {
  beforeEach(() => {
    state.embedded = false;
    state.pathname = "/dashboard/media";
  });

  it("keeps an unnamed container, so window-only classes never apply", () => {
    renderShell();

    const main = document.getElementById("main-content")!;
    expect(main.className).not.toContain("@container/window");
    expect(main.className).toContain("[container-type:inline-size]");
    expect(document.querySelector("[data-window-content]")).toBeNull();
    expect(scroller()).toHaveTextContent("Page");
    expect(scroller()).not.toHaveAttribute("data-window-layout");
  });
});
