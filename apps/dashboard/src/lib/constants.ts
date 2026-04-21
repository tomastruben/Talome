function resolveCoreUrl(): string {
  if (process.env.NEXT_PUBLIC_CORE_URL) return process.env.NEXT_PUBLIC_CORE_URL;
  if (typeof window !== "undefined") return "";
  return "http://127.0.0.1:4000";
}

export const CORE_URL = resolveCoreUrl();

export function getCoreUrl(): string {
  return resolveCoreUrl();
}

export function getHostUrl(port: number): string {
  if (typeof window !== "undefined") return `http://${window.location.hostname.toLowerCase()}:${port}`;
  return `http://localhost:${port}`;
}

/** Direct URL to the core backend, bypassing the Next.js rewrite proxy.
 *  Required for streaming endpoints (SSE) which Next.js rewrites buffer. */
export function getDirectCoreUrl(): string {
  if (typeof window !== "undefined") {
    return `http://${window.location.hostname.toLowerCase()}:4000`;
  }
  return "http://127.0.0.1:4000";
}

export function getWsUrl(): string {
  if (typeof window !== "undefined") {
    return `ws://${window.location.hostname.toLowerCase()}:4000`;
  }
  return "ws://127.0.0.1:4000";
}

export function getTerminalDaemonWsUrl(): string {
  const port = process.env.NEXT_PUBLIC_TERMINAL_DAEMON_PORT ?? "4001";
  if (typeof window !== "undefined") {
    return `ws://${window.location.hostname.toLowerCase()}:${port}`;
  }
  return `ws://127.0.0.1:${port}`;
}

export function getTerminalDaemonHttpUrl(): string {
  const port = process.env.NEXT_PUBLIC_TERMINAL_DAEMON_PORT ?? "4001";
  if (typeof window !== "undefined") {
    return `http://${window.location.hostname.toLowerCase()}:${port}`;
  }
  return `http://127.0.0.1:${port}`;
}

export function resolvePosterUrl(poster: string | undefined | null, width?: 120 | 240 | 400): string | undefined {
  if (!poster) return undefined;
  // Proxy paths start with /api/media/poster — prefix with CORE_URL so the
  // browser hits the Talome backend regardless of where the dashboard is served.
  if (poster.startsWith("/api/media/poster")) {
    const sep = poster.includes("?") ? "&" : "?";
    const widthParam = width ? `${sep}w=${width}` : "";
    return `${CORE_URL}${poster}${widthParam}`;
  }
  return poster;
}

export function resolveBackdropUrl(backdrop: string | undefined | null, width?: 400 | 780 | 1280): string | undefined {
  if (!backdrop) return undefined;
  if (backdrop.startsWith("/api/media/backdrop")) {
    const sep = backdrop.includes("?") ? "&" : "?";
    const widthParam = width ? `${sep}w=${width}` : "";
    return `${CORE_URL}${backdrop}${widthParam}`;
  }
  return backdrop;
}

export const CONTAINERS_REFRESH_INTERVAL = 5000;
