import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_ROUTE_STATE_MESSAGE,
  desktopRouteStateFromMessage,
  DESKTOP_OPEN_ROUTE_EVENT,
  DESKTOP_OPEN_ROUTE_MESSAGE,
  dashboardRouteFromHref,
  isSameDashboardApp,
  desktopRouteFromEvent,
  desktopRouteFromMessage,
  requestDesktopNavigation,
} from "@/lib/desktop-navigation";

afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("desktop navigation", () => {
  it("treats each generated native app as a separate desktop destination", () => {
    const current = "http://localhost/dashboard/native-apps/user-apps/stopwatch";
    expect(isSameDashboardApp("/dashboard/native-apps/user-apps/stopwatch?view=history", current)).toBe(true);
    expect(isSameDashboardApp("/dashboard/native-apps/user-apps/budget-compass", current)).toBe(false);
    expect(isSameDashboardApp("/dashboard/native-apps/another-store/stopwatch", current)).toBe(false);
  });
  it("normalizes same-origin dashboard routes and preserves route state", () => {
    expect(dashboardRouteFromHref(
      "/dashboard/media?tab=downloads#queue",
      "http://localhost/dashboard/desktop",
    )).toBe("/dashboard/media?tab=downloads#queue");
    expect(dashboardRouteFromHref(
      "http://localhost/dashboard/audiobooks/book-1",
      "http://localhost/dashboard/desktop",
    )).toBe("/dashboard/audiobooks/book-1");
  });

  it("rejects external, non-dashboard, and recursive desktop routes", () => {
    expect(dashboardRouteFromHref(
      "https://example.com/dashboard/media",
      "http://localhost/dashboard/desktop",
    )).toBeNull();
    expect(dashboardRouteFromHref(
      "/settings",
      "http://localhost/dashboard/desktop",
    )).toBeNull();
    expect(dashboardRouteFromHref(
      "/dashboard/desktop/",
      "http://localhost/dashboard/desktop",
    )).toBeNull();
  });

  it("requests a desktop window only from the top-level desktop route", () => {
    window.history.replaceState({}, "", "/dashboard/desktop");
    const listener = vi.fn();
    window.addEventListener(DESKTOP_OPEN_ROUTE_EVENT, listener);

    expect(requestDesktopNavigation("/dashboard/media?tab=downloads")).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(desktopRouteFromEvent(listener.mock.calls[0][0])).toBe(
      "/dashboard/media?tab=downloads",
    );

    window.removeEventListener(DESKTOP_OPEN_ROUTE_EVENT, listener);
  });

  it("keeps same-app detail, query and hash navigation in the embedded router", () => {
    window.history.replaceState({}, "", "/dashboard/media");
    vi.spyOn(window, "self", "get").mockReturnValue({} as Window & typeof globalThis);
    const postMessage = vi.spyOn(window.parent, "postMessage");

    expect(requestDesktopNavigation("/dashboard/media/movie/448")).toBe(false);
    expect(requestDesktopNavigation("/dashboard/media?tab=downloads#queue")).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();

    expect(requestDesktopNavigation("/dashboard/settings")).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({
      type: DESKTOP_OPEN_ROUTE_MESSAGE,
      url: "/dashboard/settings",
    }, window.location.origin);
  });

  it("distinguishes app roots without grouping Home or similarly named routes", () => {
    const current = "http://localhost/dashboard/apps/store/app";
    expect(isSameDashboardApp("../app/configure", current)).toBe(true);
    expect(isSameDashboardApp("/dashboard/apps?search=photo", current)).toBe(true);
    expect(isSameDashboardApp("/dashboard/apps-other", current)).toBe(false);
    expect(isSameDashboardApp("/dashboard", current)).toBe(false);
    expect(isSameDashboardApp("https://elsewhere.test/dashboard/apps", current)).toBe(false);
  });

  it("falls back to normal navigation outside desktop mode", () => {
    window.history.replaceState({}, "", "/dashboard");
    expect(requestDesktopNavigation("/dashboard/media")).toBe(false);
  });

  it("validates route-state reports independently from requests to open an app", () => {
    const report = { type: DESKTOP_ROUTE_STATE_MESSAGE, url: "/dashboard/settings/security?tab=sessions" };
    expect(desktopRouteStateFromMessage(report)).toBe(report.url);
    expect(desktopRouteFromMessage(report)).toBeNull();
    expect(desktopRouteStateFromMessage({ ...report, url: "https://elsewhere.test/dashboard/settings" })).toBeNull();
    expect(desktopRouteStateFromMessage({ ...report, url: "/dashboard/desktop" })).toBeNull();
  });

  it("parses only safe same-origin desktop route messages", () => {
    expect(desktopRouteFromMessage({
      type: DESKTOP_OPEN_ROUTE_MESSAGE,
      url: "/dashboard/media/movie/448?autoplay=1",
    })).toBe("/dashboard/media/movie/448?autoplay=1");
    expect(desktopRouteFromMessage({
      type: DESKTOP_OPEN_ROUTE_MESSAGE,
      url: "https://example.com/dashboard/media",
    })).toBeNull();
    expect(desktopRouteFromMessage({
      type: "not-a-desktop-route",
      url: "/dashboard/media",
    })).toBeNull();
  });
});
