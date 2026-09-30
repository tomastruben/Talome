import type { Container, ServiceStack } from "@talome/types";

/**
 * One mapping from Docker's container state to what a person should read
 * from a status dot. Every view (container cards, the detail sheet, the
 * services list) uses it, so a container never shows two colours.
 *
 * - `restarting` is Docker's restart policy relaunching a container that
 *   exited, usually a crash-loop. It needs attention: a static warning dot,
 *   not the breathing "work in flight" info dot.
 * - `exited` covers both a clean stop and a crash (non-zero exit, OOM-kill).
 *   The container list does not carry the exit code yet, so an exit is
 *   treated as a failure unless an exit code says it was a clean stop.
 * - `stopped`, `created` and `paused` were put there on purpose: a hollow
 *   ring (never a faint fill, which falls below 3:1).
 */
export type ContainerHealth = "healthy" | "attention" | "stopped" | "failed";

/** Exit codes of a deliberate stop: clean exit, SIGINT, SIGTERM (`docker stop`). */
const CLEAN_EXIT_CODES = new Set([0, 130, 143]);

export function containerHealth(container: { status: Container["status"]; exitCode?: number | null }): ContainerHealth {
  switch (container.status) {
    case "running":
      return "healthy";
    case "restarting":
      return "attention";
    case "exited":
      return typeof container.exitCode === "number" && CLEAN_EXIT_CODES.has(container.exitCode)
        ? "stopped"
        : "failed";
    case "stopped":
    case "created":
    case "paused":
      return "stopped";
    default:
      return "failed";
  }
}

/**
 * Aggregate for a stack. A partly running stack needs a look (warning); a
 * stack with nothing running is failed if any of its containers failed.
 */
export function stackHealth(stack: Pick<ServiceStack, "status" | "containers">): ContainerHealth {
  if (stack.status === "running") return "healthy";
  if (stack.status === "partial") return "attention";
  return stack.containers.some((c) => containerHealth(c) === "failed") ? "failed" : "stopped";
}

/** Dot fill for each state. Shapes and colours meet 3:1 against the surface. */
export const CONTAINER_HEALTH_DOT_CLASS: Record<ContainerHealth, string> = {
  healthy: "bg-status-healthy",
  attention: "bg-status-warning",
  stopped: "bg-transparent ring-1 ring-inset ring-muted-foreground",
  failed: "bg-status-critical",
};
