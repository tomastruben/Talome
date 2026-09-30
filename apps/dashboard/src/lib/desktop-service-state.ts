import type { Container, ServiceStack } from "@talome/types";
import { containerHealth } from "@/lib/container-status";

/**
 * What a service app pinned to the desktop dock (or listed in Launchpad) is
 * doing right now, from its container: never from "a window is open".
 *
 * - `running`: the container is up.
 * - `stopped`: stopped on purpose (grey, not red).
 * - `unhealthy`: exited unexpectedly or crash-looping.
 * - `missing`: no container by that name any more (uninstalled or renamed).
 * - `unknown`: the container list couldn't be loaded, so nothing is claimed.
 */
export type DesktopServiceState = "running" | "stopped" | "unhealthy" | "missing" | "unknown";

export interface DesktopServiceStatus {
  state: DesktopServiceState;
  /** The container, when one was found (for Start and Diagnose). */
  container?: Container;
  /** The stack's app id when Talome installed it (the gated app route can start it). */
  appId?: string;
}

function stateOf(container: Container): DesktopServiceState {
  const health = containerHealth(container as Container & { exitCode?: number | null });
  if (health === "healthy") return "running";
  if (health === "stopped") return "stopped";
  return "unhealthy";
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
      byName.set(container.name, {
        state: stateOf(container),
        container,
        appId: stack.kind === "talome" ? stack.appId : undefined,
      });
    }
    const primary = stack.primaryContainer;
    if (primary && !byName.has(primary.name)) {
      byName.set(primary.name, { state: stateOf(primary), container: primary, appId: stack.appId });
    }
  }
  return (serviceId: string) => byName.get(serviceId) ?? { state: loaded ? "missing" : "unknown" };
}

/** Tooltip and accessible-name text for a service's state ("Stopped", "Not installed"). */
export function desktopServiceStateLabel(state: DesktopServiceState): string | null {
  switch (state) {
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
 * A dock button's accessible name carries its state ("Files, minimized",
 * "Jellyfin, stopped"), because a dock button activates something rather
 * than toggling it (spec §6.6): no aria-pressed.
 */
export function desktopDockItemName({
  label,
  running,
  minimized,
  serviceState,
  stateNote,
}: {
  label: string;
  running: boolean;
  minimized?: boolean;
  serviceState?: DesktopServiceState;
  stateNote?: string;
}): string {
  const parts = [label];
  const serviceLabel = serviceState ? desktopServiceStateLabel(serviceState) : null;
  if (serviceLabel) parts.push(serviceLabel.toLocaleLowerCase());
  if (stateNote) parts.push(stateNote);
  else if (minimized) parts.push("minimized");
  else if (running) parts.push("open");
  return parts.join(", ");
}
