import { act, render } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopShellActionsAtom } from "@/atoms/desktop-app-actions";
import { pageTitleAtom } from "@/atoms/page-title";
import { DesktopShellHeaderActions } from "@/components/desktop/desktop-shell-header-actions";

const navigation = vi.hoisted(() => ({
  pathname: "/dashboard/settings/security",
  embedded: true,
  push: vi.fn(),
  back: vi.fn(),
  requestDesktopNavigation: vi.fn(() => false),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => navigation,
}));
vi.mock("@/hooks/use-desktop-mode", () => ({
  useIsEmbeddedFrame: () => navigation.embedded,
}));
vi.mock("@/lib/desktop-navigation", () => ({
  requestDesktopNavigation: navigation.requestDesktopNavigation,
}));
vi.mock("@/components/automations/automation-context", () => ({ useAutomation: vi.fn() }));
vi.mock("@/components/widgets/widget-edit-context", () => ({ useWidgetEdit: vi.fn() }));
vi.mock("@/hooks/use-widget-layout", () => ({ useWidgetLayout: vi.fn() }));
vi.mock("@/hooks/use-check-service-updates", () => ({ useCheckServiceUpdates: vi.fn() }));
const windowSidebar = vi.hoisted(() => ({ shown: false }));
vi.mock("@/components/ui/source-list", () => ({
  useWindowSidebarShown: () => navigation.embedded && windowSidebar.shown,
}));

function invokeBack() {
  const store = createStore();
  render(<Provider store={store}><DesktopShellHeaderActions /></Provider>);
  const back = store.get(desktopShellActionsAtom).find((action) => action.id === "shell-route-back");
  expect(back).toBeDefined();
  act(() => back?.onSelect?.());
}

describe("desktop shell Back", () => {
  beforeEach(() => {
    navigation.embedded = true;
    windowSidebar.shown = false;
    navigation.push.mockReset();
    navigation.back.mockReset();
    navigation.requestDesktopNavigation.mockReset();
    navigation.requestDesktopNavigation.mockReturnValue(false);
  });

  it.each([
    ["/dashboard/settings/security", "/dashboard/settings"],
    ["/dashboard/apps/community/photos", "/dashboard/apps"],
    ["/dashboard/apps/stacks/photos", "/dashboard/apps"],
    ["/dashboard/apps/community/photos/configure", "/dashboard/apps/community/photos"],
  ])("returns a directly opened %s window to %s", (pathname, expected) => {
    navigation.pathname = pathname;
    invokeBack();
    expect(navigation.push).toHaveBeenCalledWith(expected);
    expect(navigation.back).not.toHaveBeenCalled();
  });

  it("preserves browser Back in the classic dashboard", () => {
    navigation.embedded = false;
    navigation.pathname = "/dashboard/settings/security";
    invokeBack();
    expect(navigation.back).toHaveBeenCalledOnce();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("does not publish a dashboard Back action for the root Share window", () => {
    navigation.pathname = "/dashboard/share";
    const store = createStore();
    render(<Provider store={store}><DesktopShellHeaderActions /></Provider>);
    expect(store.get(desktopShellActionsAtom)).toEqual([]);
    expect(navigation.requestDesktopNavigation).not.toHaveBeenCalled();
  });

  it("keeps Share's return to Home in the classic dashboard", () => {
    navigation.pathname = "/dashboard/share";
    navigation.embedded = false;
    invokeBack();
    expect(navigation.push).toHaveBeenCalledWith("/dashboard");
    expect(navigation.back).not.toHaveBeenCalled();
  });

  it("clears the Share Back action once the embedded frame hydrates", () => {
    navigation.pathname = "/dashboard/share";
    navigation.embedded = false;
    const store = createStore();
    const view = render(<Provider store={store}><DesktopShellHeaderActions /></Provider>);
    expect(store.get(desktopShellActionsAtom)).toHaveLength(1);
    navigation.embedded = true;
    view.rerender(<Provider store={store}><DesktopShellHeaderActions /></Provider>);
    expect(store.get(desktopShellActionsAtom)).toEqual([]);
  });

  it("publishes no Back in a wide Settings window, where the sidebar lists every section", () => {
    navigation.pathname = "/dashboard/settings/security";
    windowSidebar.shown = true;
    const store = createStore();
    render(<Provider store={store}><DesktopShellHeaderActions /></Provider>);
    expect(store.get(desktopShellActionsAtom)).toEqual([]);
  });

  it("brings Back when the Settings window narrows to the stacked layout", () => {
    navigation.pathname = "/dashboard/settings/security";
    windowSidebar.shown = true;
    const store = createStore();
    const view = render(<Provider store={store}><DesktopShellHeaderActions /></Provider>);
    expect(store.get(desktopShellActionsAtom)).toEqual([]);
    windowSidebar.shown = false;
    view.rerender(<Provider store={store}><DesktopShellHeaderActions /></Provider>);
    expect(store.get(desktopShellActionsAtom).map((action) => action.id)).toEqual(["shell-route-back"]);
  });

  it("keeps Back on an App Store detail window even when a sidebar shows", () => {
    navigation.pathname = "/dashboard/apps/community/photos";
    windowSidebar.shown = true;
    invokeBack();
    expect(navigation.push).toHaveBeenCalledWith("/dashboard/apps");
  });
});

describe("App Store title bar", () => {
  beforeEach(() => {
    navigation.embedded = true;
    windowSidebar.shown = false;
  });

  it("publishes no title-bar verbs: Create lives in the App Store's toolbar row", () => {
    navigation.pathname = "/dashboard/apps";
    const store = createStore();
    // What the previous route left behind is replaced, not kept
    store.set(desktopShellActionsAtom, [{ id: "app-store-create", label: "Create", icon: "add" }]);
    render(<Provider store={store}><DesktopShellHeaderActions /></Provider>);
    expect(store.get(desktopShellActionsAtom)).toEqual([]);
  });

  it("clears a detail page's title in classic mode, where the page does not publish a window title", () => {
    navigation.embedded = false;
    navigation.pathname = "/dashboard/apps";
    const store = createStore();
    store.set(pageTitleAtom, "Photos");
    render(<Provider store={store}><DesktopShellHeaderActions /></Provider>);
    expect(store.get(pageTitleAtom)).toBeNull();
  });
});
