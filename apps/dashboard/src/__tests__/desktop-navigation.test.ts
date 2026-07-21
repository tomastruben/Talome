import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_OPEN_ROUTE_EVENT,
  DESKTOP_OPEN_ROUTE_MESSAGE,
  dashboardRouteFromHref,
  desktopRouteFromEvent,
  desktopRouteFromMessage,
  requestDesktopNavigation,
} from "@/lib/desktop-navigation";

afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("desktop navigation", () => {
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
      "/dashboard/desktop",
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

  it("falls back to normal navigation outside desktop mode", () => {
    window.history.replaceState({}, "", "/dashboard");
    expect(requestDesktopNavigation("/dashboard/media")).toBe(false);
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
