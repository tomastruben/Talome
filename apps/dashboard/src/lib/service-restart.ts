/**
 * Honest restart states for Settings → Services (core, dashboard, terminal).
 *
 * The old flow fired the POST without checking `res.ok`, then showed
 * "Restarting…" for a fixed 3 or 8 seconds and went back to idle whether or
 * not the service came back. Now: confirm first when work is in flight,
 * check the response, and poll the supervisor until the process is healthy
 * again under a new pid (or say that it couldn't be confirmed).
 */

export type SupervisedService = "core" | "dashboard" | "terminal_daemon";

export const SUPERVISED_SERVICES: readonly SupervisedService[] = ["core", "dashboard", "terminal_daemon"];

export interface SupervisorProcess {
  pid: number | null;
  /** stopped | starting | healthy | unhealthy | crashed */
  status: string;
}

export interface SupervisorState {
  processes: Record<string, SupervisorProcess | undefined>;
}

export const SERVICE_LABELS: Record<SupervisedService, string> = {
  core: "Core",
  dashboard: "Dashboard",
  terminal_daemon: "Terminal",
};

export type ProcessDotState = "healthy" | "working" | "failed" | "stopped" | "unknown";

/** The status grammar for a supervised process. */
export function processDotState(proc: SupervisorProcess | undefined): { state: ProcessDotState; label: string } {
  switch (proc?.status) {
    case "healthy":
      return { state: "healthy", label: "Running" };
    case "starting":
      return { state: "working", label: "Starting" };
    case "unhealthy":
      return { state: "failed", label: "Not responding" };
    case "crashed":
      return { state: "failed", label: "Crashed" };
    case "stopped":
      return { state: "stopped", label: "Stopped" };
    default:
      return { state: "unknown", label: "Status unknown" };
  }
}

/** Which processes a restart request covers. */
export function restartTargets(service: SupervisedService | "all"): SupervisedService[] {
  return service === "all" ? [...SUPERVISED_SERVICES] : [service];
}

/**
 * True once every target is healthy again under a new pid. A pid that didn't
 * change means the old process is still the one answering (the restart
 * hasn't happened yet), so a quick "healthy" read right after the POST is
 * not mistaken for a finished restart.
 */
export function restartSettled(
  before: SupervisorState | null,
  after: SupervisorState | null,
  targets: readonly SupervisedService[],
): boolean {
  if (!after) return false;
  return targets.every((key) => {
    const next = after.processes[key];
    if (!next || next.status !== "healthy" || next.pid == null) return false;
    const previousPid = before?.processes[key]?.pid ?? null;
    return previousPid == null || next.pid !== previousPid;
  });
}

export interface InFlightWork {
  /** Journaled app operations still running: "Updating jellyfin". */
  operations: string[];
  /** Self-improvement runs in progress. */
  evolutionRuns: number;
  /** The Assistant is replying in this browser. */
  assistantReplying: boolean;
  /** A check failed, so running work could not be ruled out. */
  unknown: boolean;
}

const KIND_VERBS: Record<string, string> = {
  install: "Installing",
  uninstall: "Uninstalling",
  update: "Updating",
  rollback: "Rolling back",
  backup: "Backing up",
  restore: "Restoring",
  start: "Starting",
  stop: "Stopping",
  restart: "Restarting",
  configure: "Configuring",
};

export function describeOperation(op: { kind: string; appId: string }): string {
  const verb = KIND_VERBS[op.kind] ?? "Working on";
  return `${verb} ${op.appId}`;
}

export function hasInFlightWork(work: InFlightWork): boolean {
  return work.operations.length > 0 || work.evolutionRuns > 0 || work.assistantReplying || work.unknown;
}

/**
 * The confirmation's consequence sentence: what the restart interrupts.
 * Returns null when nothing is in flight (no confirm needed).
 */
export function inFlightConsequence(work: InFlightWork, service: SupervisedService | "all"): string | null {
  if (!hasInFlightWork(work)) return null;
  const parts: string[] = [];
  if (work.operations.length > 0) {
    const shown = work.operations.slice(0, 2).join(", ");
    const more = work.operations.length > 2 ? ` and ${work.operations.length - 2} more` : "";
    parts.push(`${shown}${more}`);
  }
  if (work.evolutionRuns > 0) {
    parts.push(work.evolutionRuns === 1 ? "a self-improvement run" : `${work.evolutionRuns} self-improvement runs`);
  }
  if (work.assistantReplying) parts.push("the Assistant's reply");
  const what = service === "all" ? "Restarting every service" : `Restarting ${SERVICE_LABELS[service]}`;
  if (parts.length === 0) {
    return `${what} may interrupt running work: Talome couldn't check what is running.`;
  }
  return `${what} interrupts ${joinWords(parts)}.`;
}

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export type RestartOutcome =
  | { ok: true }
  | { ok: false; reason: "request"; error: string }
  | { ok: false; reason: "timeout" };

export interface RestartDeps {
  /** POST /api/supervisor/restart. */
  request: (service: SupervisedService | undefined) => Promise<Response>;
  /** GET /api/supervisor/status; null when it can't be read (service down). */
  readStatus: () => Promise<SupervisorState | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const RESTART_POLL_MS = 1_000;
export const RESTART_TIMEOUT_MS = 90_000;

/** Runs a restart and resolves once it is verified, failed, or timed out. */
export async function runVerifiedRestart(
  service: SupervisedService | "all",
  before: SupervisorState | null,
  deps: RestartDeps,
  { pollMs = RESTART_POLL_MS, timeoutMs = RESTART_TIMEOUT_MS }: { pollMs?: number; timeoutMs?: number } = {},
): Promise<RestartOutcome> {
  let res: Response;
  try {
    res = await deps.request(service === "all" ? undefined : service);
  } catch {
    return { ok: false, reason: "request", error: "Couldn't reach Talome to restart. Check your connection, then retry." };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    const detail = typeof body?.error === "string" && body.error ? body.error : `the server answered ${res.status}`;
    return { ok: false, reason: "request", error: `Couldn't restart: ${detail}.` };
  }

  const targets = restartTargets(service);
  const started = deps.now();
  while (deps.now() - started < timeoutMs) {
    await deps.sleep(pollMs);
    let state: SupervisorState | null = null;
    try {
      state = await deps.readStatus();
    } catch {
      state = null; // Still restarting: keep polling.
    }
    if (restartSettled(before, state, targets)) return { ok: true };
  }
  return { ok: false, reason: "timeout" };
}
