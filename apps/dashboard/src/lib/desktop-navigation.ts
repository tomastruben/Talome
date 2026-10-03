import type { ServiceStack } from "@talome/types";
import { getHostUrl } from "@/lib/constants";

export const DESKTOP_OPEN_ROUTE_EVENT = "talome:desktop-open-route";
export const DESKTOP_ROUTE_STATE_MESSAGE = "talome:desktop-route-state";
export const DESKTOP_OPEN_ROUTE_MESSAGE = "talome:desktop-open-route-message";

export interface DesktopOpenRouteDetail {
  url: string;
}

export function dashboardRouteFromHref(
  href: string,
  currentHref = typeof window === "undefined"
    ? "http://localhost/dashboard/desktop"
    : window.location.href,
): string | null {
  try {
    const currentUrl = new URL(currentHref);
    const targetUrl = new URL(href, currentUrl);
    if (targetUrl.origin !== currentUrl.origin) return null;
    if (
      targetUrl.pathname !== "/dashboard"
      && !targetUrl.pathname.startsWith("/dashboard/")
    ) {
      return null;
    }
    if (targetUrl.pathname.replace(/\/+$/, "") === "/dashboard/desktop") return null;
    return `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
  } catch {
    return null;
  }
}

/** Native app identity includes the store; the same app id can exist in two stores. */
export function nativeDashboardAppKey(
  href: string,
  currentHref = typeof window === "undefined"
    ? "http://localhost/dashboard/desktop"
    : window.location.href,
): string | null {
  const route = dashboardRouteFromHref(href, currentHref);
  if (!route) return null;
  const parts = new URL(route, currentHref).pathname.split("/");
  if (parts[2] !== "native-apps" || !parts[3] || !parts[4]) return null;
  try {
    return parts.slice(3, 5).map((part) => encodeURIComponent(decodeURIComponent(part))).join("/");
  } catch {
    return null;
  }
}

export function findDesktopNativeService<T extends { url: string }>(
  href: string,
  services: readonly T[],
): T | undefined {
  const key = nativeDashboardAppKey(href);
  return key ? services.find((service) => nativeDashboardAppKey(service.url) === key) : undefined;
}

/** Routes within one built-in or generated app belong to its own router and history. */
export function isSameDashboardApp(href: string, currentHref: string): boolean {
  const route = dashboardRouteFromHref(href, currentHref);
  const currentRoute = dashboardRouteFromHref(currentHref, currentHref);
  if (!route || !currentRoute) return false;
  const appRoot = (url: string) => {
    const parts = new URL(url, currentHref).pathname.split("/");
    if (parts[2] === "containers" && parts[3] === "preview") return "containers/preview";
    if (parts[2] === "files" && parts[3] === "preview") return "files/preview";
    if (parts[2] !== "native-apps") return parts[2];
    const nativeKey = nativeDashboardAppKey(url, currentHref);
    return nativeKey ? `native-apps/${nativeKey}` : null;
  };
  const currentApp = appRoot(currentRoute);
  return !!currentApp && currentApp === appRoot(route);
}

/** Reports may update the registered window's own route, never a different app. */
export function desktopRouteBelongsToWindow(route: string, windowUrl: string): boolean {
  const source = dashboardRouteFromHref(windowUrl);
  if (!source) return false;
  const currentHref = typeof window === "undefined" ? "http://localhost/dashboard/desktop" : window.location.href;
  return isSameDashboardApp(route, new URL(source, currentHref).href);
}

/** Keep normal browser semantics for explicit targets, downloads and modified clicks. */
export function shouldHandleDesktopLink(
  event: Pick<MouseEvent, "defaultPrevented" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  anchor: HTMLAnchorElement,
): boolean {
  return !event.defaultPrevented
    && event.button === 0
    && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
    && anchor.dataset.desktopNavigation !== "bypass"
    && !anchor.hasAttribute("download")
    && (!anchor.target || anchor.target === "_self");
}

export function requestDesktopNavigation(href: string): boolean {
  if (typeof window === "undefined") return false;
  const url = dashboardRouteFromHref(href);
  if (!url) return false;

  if (window.self !== window.top) {
    // Replacing the parent's iframe src for a same-app link reloads the app,
    // discards its state, and breaks the router's Back behavior.
    if (isSameDashboardApp(url, window.location.href)) return false;
    window.parent.postMessage(
      { type: DESKTOP_OPEN_ROUTE_MESSAGE, url },
      window.location.origin,
    );
    return true;
  }

  if (window.location.pathname !== "/dashboard/desktop") return false;

  window.dispatchEvent(new CustomEvent<DesktopOpenRouteDetail>(
    DESKTOP_OPEN_ROUTE_EVENT,
    { detail: { url } },
  ));
  return true;
}

export function desktopRouteStateFromMessage(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as { type?: unknown; url?: unknown };
  return message.type === DESKTOP_ROUTE_STATE_MESSAGE && typeof message.url === "string"
    ? dashboardRouteFromHref(message.url)
    : null;
}

export function desktopRouteFromMessage(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as { type?: unknown; url?: unknown };
  if (
    message.type !== DESKTOP_OPEN_ROUTE_MESSAGE
    || typeof message.url !== "string"
  ) {
    return null;
  }
  return dashboardRouteFromHref(message.url);
}

export function desktopRouteFromEvent(event: Event): string | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail = event.detail as Partial<DesktopOpenRouteDetail> | null;
  return detail && typeof detail.url === "string"
    ? dashboardRouteFromHref(detail.url)
    : null;
}

export const DESKTOP_OPEN_SERVICE_PORT_MESSAGE = "talome:desktop-open-service-port";

export interface DesktopServicePortRequest {
  containerId: string;
  port: number;
}

export function desktopServicePortFromMessage(value: unknown): DesktopServicePortRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as { type?: unknown; containerId?: unknown; port?: unknown };
  if (message.type !== DESKTOP_OPEN_SERVICE_PORT_MESSAGE
    || typeof message.containerId !== "string" || !message.containerId
    || typeof message.port !== "number" || !Number.isInteger(message.port)
    || message.port < 1 || message.port > 65535) return null;
  return { containerId: message.containerId, port: message.port };
}

/** Only installed, running containers and their published TCP ports can be opened. */
export function desktopServicePortTarget(request: DesktopServicePortRequest, stacks: readonly ServiceStack[]) {
  const stack = stacks.find((candidate) => candidate.containers.some((container) => container.id === request.containerId));
  const container = stack?.containers.find((candidate) => candidate.id === request.containerId);
  if (!stack || !container || container.status !== "running"
    || !container.ports.some((port) => port.protocol === "tcp" && port.host === request.port)) return null;
  const ui = container.webUi?.port === request.port ? container.webUi : null;
  const metadata = stack.containerIcons?.[container.id];
  return {
    id: `${container.name}:port:${request.port}`,
    name: `${metadata?.name ?? (stack.containers.length === 1 ? stack.name : container.name)} · ${request.port}`,
    url: ui ? `${getHostUrl(request.port).replace(/^http:/, `${ui.protocol}:`)}${ui.path}` : getHostUrl(request.port),
    icon: metadata?.icon ?? stack.icon,
    iconUrl: metadata?.iconUrl ?? stack.iconUrl,
  };
}

export function requestDesktopServicePort(containerId: string, port: number): boolean {
  if (typeof window === "undefined" || window.self === window.top) return false;
  window.parent.postMessage({ type: DESKTOP_OPEN_SERVICE_PORT_MESSAGE, containerId, port }, window.location.origin);
  return true;
}
