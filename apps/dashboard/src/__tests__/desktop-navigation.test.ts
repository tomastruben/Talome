import type { Container, ServiceStack } from "@talome/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_OPEN_SERVICE_PORT_MESSAGE,
  desktopServicePortFromMessage,
  desktopServicePortTarget,
  requestDesktopServicePort,
  DESKTOP_ROUTE_STATE_MESSAGE,
  desktopRouteStateFromMessage,
  DESKTOP_OPEN_ROUTE_EVENT,
  DESKTOP_OPEN_ROUTE_MESSAGE,
  dashboardRouteFromHref,
  isSameDashboardApp,
  desktopRouteBelongsToWindow,
  desktopRouteFromEvent,
  desktopRouteFromMessage,
  requestDesktopNavigation,
} from "@/lib/desktop-navigation";

afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("desktop navigation", () => {
  it("opens file previews separately while sibling navigation stays in the preview", () => {
    const files = "http://localhost/dashboard/files?path=/books";
    const preview = "http://localhost/dashboard/files/preview?path=/books/cover.jpg";
    expect(isSameDashboardApp(preview, files)).toBe(false);
    expect(isSameDashboardApp(files, preview)).toBe(false);
    expect(isSameDashboardApp("/dashboard/files/preview?path=/books/next.jpg", preview)).toBe(true);
    expect(desktopRouteBelongsToWindow("/dashboard/files?path=/books", "/dashboard/files/preview?path=/books/cover.jpg")).toBe(false);
    expect(desktopRouteBelongsToWindow("/dashboard/files/preview?path=/books/next.jpg", "/dashboard/files/preview?path=/books/cover.jpg")).toBe(true);
  });

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

describe("service port windows", () => {
  const container: Container = {
    id: "container-1", name: "plex", image: "plex:1", status: "running", created: "", labels: {},
    ports: [{ host: 32400, container: 32400, protocol: "tcp" }, { host: 32401, container: 32401, protocol: "tcp" }, { host: 32402, container: 32402, protocol: "udp" }],
    webUi: { port: 32400, path: "/web/index.html", protocol: "http", source: "configured" },
  };
  const stack: ServiceStack = { id: "plex", name: "Plex", kind: "talome", status: "running", primaryContainer: container, containers: [container], cpuPercent: 0, memoryUsageMb: 0, runningCount: 1, totalCount: 1 };

  it("keeps the detected GUI path and gives different ports separate identities", () => {
    const main = desktopServicePortTarget({ containerId: container.id, port: 32400 }, [stack]);
    const alternate = desktopServicePortTarget({ containerId: container.id, port: 32401 }, [stack]);
    expect(main?.url).toMatch(/:32400\/web\/index.html$/);
    expect(alternate?.url).toMatch(/:32401$/);
    expect(main?.id).not.toBe(alternate?.id);
    expect(main?.name).toBe("Plex · 32400");
  });

  it("rejects unknown, stopped, unpublished and UDP-only targets", () => {
    expect(desktopServicePortTarget({ containerId: "other", port: 32400 }, [stack])).toBeNull();
    expect(desktopServicePortTarget({ containerId: container.id, port: 9999 }, [stack])).toBeNull();
    expect(desktopServicePortTarget({ containerId: container.id, port: 32402 }, [stack])).toBeNull();
    expect(desktopServicePortTarget({ containerId: container.id, port: 32400 }, [{ ...stack, containers: [{ ...container, status: "stopped" }] }])).toBeNull();
  });

  it("accepts only typed container/port messages rather than arbitrary URLs", () => {
    const message = { type: DESKTOP_OPEN_SERVICE_PORT_MESSAGE, containerId: container.id, port: 32400 };
    expect(desktopServicePortFromMessage(message)).toEqual({ containerId: container.id, port: 32400 });
    for (const port of [0, 65536, 1.5, "32400", null]) expect(desktopServicePortFromMessage({ ...message, port })).toBeNull();
    expect(desktopServicePortFromMessage({ type: DESKTOP_OPEN_SERVICE_PORT_MESSAGE, url: "https://example.com" })).toBeNull();
    expect(desktopServicePortFromMessage(null)).toBeNull();
  });

  it("leaves classic mode to its existing preview", () => {
    window.history.replaceState({}, "", "/dashboard/containers");
    expect(requestDesktopServicePort(container.id, 32400)).toBe(false);
  });
});
