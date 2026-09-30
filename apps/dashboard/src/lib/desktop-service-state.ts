import type { Container, ServiceStack } from "@talome/types";
import type { OperationRecord } from "@/lib/app-operations";

/**
 * What a service app pinned to the desktop dock (or listed in Launchpad) is
 * doing right now, from its container: never from "a window is open".
 *
 * - `running`: the container is up.
 * - `working`: in transition (Docker restarting it, or an app operation such
 *   as an update recreating it). The window keeps its page; the dock shows
 *   the breathing info dot.
 * - `stopped`: stopped on purpose (grey, not red).
 * - `unhealthy`: exited with a crash's exit code.
 * - `missing`: no container by that name any more (uninstalled or renamed).
 * - `unknown`: the container list couldn't be loaded, so nothing is claimed.
 */
export type DesktopServiceState = "running" | "working" | "stopped" | "unhealthy" | "missing" | "unknown";

export interface DesktopServiceStatus {
  state: DesktopServiceState;
  /** What a `working` service is doing ("Restarting", "Updating"). */
  activity?: string;
  /** The container, when one was found (for Start and Diagnose). */
  container?: Container;
  /** Store and app id when Talome installed it: Start goes through the gated app route. */
  storeId?: string;
  appId?: string;
}

/** Exit codes of a deliberate stop: clean exit, SIGINT, SIGTERM (`docker stop`). */
const CLEAN_EXIT_CODES = new Set([0, 130, 143]);

/**
 * A container's state for the dock. Unlike the Services list, an exit whose
 * code is unknown counts as stopped: every `docker stop` leaves "exited", and
 * a dock full of red dots for apps someone stopped on purpose is untrue.
 * Only a known crash exit code is `unhealthy`; Docker restarting a container
 * is `working` (it may come straight back).
 */
export function desktopContainerState(container: Pick<Container, "status" | "exitCode">): DesktopServiceState {
  switch (container.status) {
    case "running":
      return "running";
    case "restarting":
      return "working";
    case "exited":
      return typeof container.exitCode === "number" && !CLEAN_EXIT_CODES.has(container.exitCode)
        ? "unhealthy"
        : "stopped";
    default:
      return "stopped";
  }
}

function statusOf(container: Container, stack: ServiceStack): DesktopServiceStatus {
  const state = desktopContainerState(container);
  const managed = stack.kind === "talome" && stack.storeId && stack.appId;
  return {
    state,
    ...(state === "working" ? { activity: "Restarting" } : {}),
    container,
    ...(managed ? { storeId: stack.storeId, appId: stack.appId } : {}),
  };
}

/**
 * Indexes every container by name (the id the dock and Launchpad use for
 * service apps; container names survive image upgrades). A native app is
 * indexed by its primary container. Returns a lookup that answers `missing`
 * only when the list loaded, and `unknown` otherwise.
 */
export function desktopServiceStatusLookup(
  stacks: readonly ServiceStack[],
  loaded: boolean,
): (serviceId: string) => DesktopServiceStatus {
  const byName = new Map<string, DesktopServiceStatus>();
  for (const stack of stacks) {
    for (const container of stack.containers) {
      byName.set(container.name, statusOf(container, stack));
    }
    const primary = stack.primaryContainer;
    if (primary && !byName.has(primary.name)) {
      byName.set(primary.name, statusOf(primary, stack));
    }
  }
  return (serviceId: string) => byName.get(serviceId) ?? { state: loaded ? "missing" : "unknown" };
}

const OPERATION_ACTIVITY: Record<string, string> = {
  install: "Installing",
  update: "Updating",
  rollback: "Rolling back",
  backup: "Backing up",
  restore: "Restoring",
  start: "Starting",
  stop: "Stopping",
  restart: "Restarting",
  configure: "Configuring",
  uninstall: "Uninstalling",
};

/** True when an app operation's app id names this service (container "immich_server" for app "immich"). */
function operationCoversService(appId: string, serviceId: string, knownAppId?: string): boolean {
  if (knownAppId) return knownAppId === appId;
  if (serviceId === appId) return true;
  return serviceId.startsWith(`${appId}-`) || serviceId.startsWith(`${appId}_`) || serviceId.startsWith(`${appId}.`);
}

/**
 * While an app operation (update, backup, restore…) runs for this app, its
 * containers are stopped and recreated on purpose: the service is `working`,
 * never `missing` or `stopped` (which would replace the window's page).
 */
export function withActiveOperation(
  status: DesktopServiceStatus,
  serviceId: string,
  operations: readonly Pick<OperationRecord, "appId" | "kind" | "status">[],
): DesktopServiceStatus {
  if (status.state === "running" || status.state === "unknown") return status;
  const op = operations.find((candidate) =>
    (candidate.status === "queued" || candidate.status === "running")
    && operationCoversService(candidate.appId, serviceId, status.appId));
  if (!op) return status;
  return { ...status, state: "working", activity: OPERATION_ACTIVITY[op.kind] ?? "Working" };
}

/** Tooltip and accessible-name text for a service's state ("Stopped", "Not installed"). */
export function desktopServiceStateLabel(state: DesktopServiceState, activity?: string): string | null {
  switch (state) {
    case "working":
      return activity ?? "Restarting";
    case "stopped":
      return "Stopped";
    case "unhealthy":
      return "Unhealthy";
    case "missing":
      return "Not installed";
    default:
      return null;
  }
}

/** True when opening the app would show a dead page: the window shows Talome's own state instead. */
export function isServiceUnavailable(state: DesktopServiceState | undefined): boolean {
  return state === "stopped" || state === "unhealthy" || state === "missing";
}

/**
 * Start a service through the gated app route when Talome installed it (the
 * whole stack starts, journaled, under the security mode), and through the
 * container route only for containers Talome doesn't manage.
 */
export function desktopServiceStartPath(status: Pick<DesktopServiceStatus, "storeId" | "appId" | "container">): string | null {
  if (status.storeId && status.appId) {
    return `/api/apps/${encodeURIComponent(status.storeId)}/${encodeURIComponent(status.appId)}/start`;
  }
  return status.container ? `/api/containers/${encodeURIComponent(status.container.id)}/start` : null;
}

/**
 * How long a window keeps a page it already loaded after its service goes
 * down: two container polls. A restart or an update's recreate is usually
 * back by then, and tearing the page down would lose the person's place.
 */
export const SERVICE_DOWN_GRACE_MS = 10_000;

/** Per-window memory of when its service went down, and whether the window gave up on the page. */
export interface ServiceWindowGate {
  downSince: number | null;
  showUnavailable: boolean;
}

/**
 * The next gate for one window. A window opened while its service is down
 * shows Talome's own state at once; a window whose page loaded keeps it
 * until the service has been down for the grace period. Once shown, the
 * state stays until the service is back (no flicker between polls).
 */
export function nextServiceWindowGate(
  previous: ServiceWindowGate | undefined,
  { state, frameLoaded, now, graceMs = SERVICE_DOWN_GRACE_MS }: {
    state: DesktopServiceState | undefined;
    frameLoaded: boolean;
    now: number;
    graceMs?: number;
  },
): ServiceWindowGate {
  if (!isServiceUnavailable(state)) return { downSince: null, showUnavailable: false };
  const downSince = previous?.downSince ?? now;
  if (previous?.showUnavailable || !frameLoaded) return { downSince, showUnavailable: true };
  return { downSince, showUnavailable: now - downSince >= graceMs };
}

/**
 * A dock button's accessible name carries its state ("Files, minimized",
 * "Jellyfin, stopped"), because a dock button activates something rather
 * than toggling it (spec §6.6): no aria-pressed.
 */
export function desktopDockItemName({
  label,
  running,
  minimized,
  serviceState,
  serviceActivity,
  stateNote,
}: {
  label: string;
  running: boolean;
  minimized?: boolean;
  serviceState?: DesktopServiceState;
  serviceActivity?: string;
  stateNote?: string;
}): string {
  const parts = [label];
  const serviceLabel = serviceState ? desktopServiceStateLabel(serviceState, serviceActivity) : null;
  if (serviceLabel) parts.push(serviceLabel.toLocaleLowerCase());
  if (stateNote) parts.push(stateNote);
  else if (minimized) parts.push("minimized");
  else if (running) parts.push("open");
  return parts.join(", ");
}

export interface ServiceWindowEntry {
  windowId: string;
  state: DesktopServiceState | undefined;
  frameLoaded: boolean;
}

/** Advances every window's gate; returns `previous` itself when nothing changed. */
export function advanceServiceWindowGates(
  previous: Readonly<Record<string, ServiceWindowGate>>,
  entries: readonly ServiceWindowEntry[],
  now: number,
  graceMs = SERVICE_DOWN_GRACE_MS,
): Record<string, ServiceWindowGate> {
  const next: Record<string, ServiceWindowGate> = {};
  let changed = Object.keys(previous).length !== entries.length;
  for (const entry of entries) {
    const before = previous[entry.windowId];
    const after = nextServiceWindowGate(before, { state: entry.state, frameLoaded: entry.frameLoaded, now, graceMs });
    next[entry.windowId] = before && before.downSince === after.downSince && before.showUnavailable === after.showUnavailable
      ? before
      : after;
    if (next[entry.windowId] !== before) changed = true;
  }
  return changed ? next : (previous as Record<string, ServiceWindowGate>);
}

/**
 * Whether a window shows Talome's own "isn't running" state instead of its
 * page. Decided at render: a service that is back shows its page at once.
 */
export function showsServiceUnavailable(
  entry: ServiceWindowEntry,
  gate: ServiceWindowGate | undefined,
): boolean {
  if (!isServiceUnavailable(entry.state)) return false;
  if (!entry.frameLoaded) return true;
  return gate?.showUnavailable === true;
}
