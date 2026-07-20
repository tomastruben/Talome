export const DESKTOP_OPEN_ROUTE_EVENT = "talome:desktop-open-route";

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
    if (targetUrl.pathname === "/dashboard/desktop") return null;
    return `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
  } catch {
    return null;
  }
}

export function requestDesktopNavigation(href: string): boolean {
  if (typeof window === "undefined") return false;
  if (window.self !== window.top) return false;
  if (window.location.pathname !== "/dashboard/desktop") return false;

  const url = dashboardRouteFromHref(href);
  if (!url) return false;

  window.dispatchEvent(new CustomEvent<DesktopOpenRouteDetail>(
    DESKTOP_OPEN_ROUTE_EVENT,
    { detail: { url } },
  ));
  return true;
}

export function desktopRouteFromEvent(event: Event): string | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail = event.detail as Partial<DesktopOpenRouteDetail> | null;
  return detail && typeof detail.url === "string"
    ? dashboardRouteFromHref(detail.url)
    : null;
}
