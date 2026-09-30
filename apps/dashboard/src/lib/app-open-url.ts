/**
 * Where an app's "Open" button goes.
 *
 * The scheme comes from what the app actually serves, never a blanket
 * `http://`: the web UI Talome detected on the container (protocol and
 * path), then the well-known TLS container ports, otherwise HTTP. The
 * dashboard's own scheme is deliberately not used: a dashboard served over
 * HTTPS behind a proxy does not make an app's raw port speak TLS, and an
 * `https://host:8096` link to a plain-HTTP app can't load.
 */

/** Container ports that conventionally serve HTTPS. */
const TLS_CONTAINER_PORTS = new Set([443, 8443, 9443]);

export interface AppOpenTarget {
  /** The host port the app is published on. */
  port: number;
  /** The container port behind it, when known (used for the TLS heuristic). */
  containerPort?: number;
  /** A detected or configured web UI on the container. */
  webUi?: { port: number; protocol: "http" | "https"; path?: string } | null;
}

export interface PageLocation {
  hostname: string;
}

function currentLocation(): PageLocation {
  if (typeof window === "undefined") return { hostname: "localhost" };
  return { hostname: window.location.hostname };
}

export function appOpenUrl(target: AppOpenTarget, location: PageLocation = currentLocation()): string {
  const host = location.hostname.toLowerCase() || "localhost";
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const ui = target.webUi && target.webUi.port === target.port ? target.webUi : null;

  let scheme: "http" | "https";
  if (ui) scheme = ui.protocol;
  else if (target.containerPort !== undefined && TLS_CONTAINER_PORTS.has(target.containerPort)) scheme = "https";
  else scheme = "http";

  const rawPath = ui?.path ?? "";
  const path = rawPath && rawPath !== "/" ? (rawPath.startsWith("/") ? rawPath : `/${rawPath}`) : "";
  return `${scheme}://${hostPart}:${target.port}${path}`;
}
