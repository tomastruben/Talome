/**
 * Client-side model of the core app-operations journal (apps/core/src/ops).
 *
 * Every lifecycle action (install, update, start, …) runs as a journaled
 * operation with honest step + progress. The dashboard learns about them from
 * two sources that this module reconciles:
 *   • the live SSE stream GET /api/operations/stream (OperationEvent)
 *   • the persisted history GET /api/apps/:appId/operations (OperationRecord)
 *
 * Everything here is pure so it can be unit-tested without a DOM.
 */

export const OPERATION_KINDS = [
  "install",
  "update",
  "uninstall",
  "start",
  "stop",
  "restart",
  "rollback",
  "backup",
  "restore",
  "configure",
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const OPERATION_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "rolled_back",
  "interrupted",
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

/** Live event from GET /api/operations/stream (event name "operation"). */
export interface OperationEvent {
  operationId: string;
  appId: string;
  kind: OperationKind;
  actor: string;
  status: OperationStatus;
  step: string | null;
  progress: number;
  message?: string;
  error?: string;
  at: string;
}

/** Journal row from GET /api/apps/:appId/operations and GET /api/operations/:id. */
export interface OperationRecord {
  id: string;
  appId: string;
  kind: OperationKind;
  actor: string;
  status: OperationStatus;
  step: string | null;
  progress: number;
  detail: Record<string, unknown> | null;
  error: string | null;
  idempotencyKey?: string | null;
  startedAt: string;
  updatedAt: string;
  heartbeatAt?: string | null;
  finishedAt: string | null;
}

/** What the app detail page renders for the current operation. */
export interface LiveOperation {
  operationId: string;
  appId: string;
  kind: OperationKind;
  actor: string;
  status: OperationStatus;
  step: string | null;
  progress: number;
  message: string | null;
  error: string | null;
  startedAt: string;
  updatedAt: string;
}

const KIND_SET = new Set<string>(OPERATION_KINDS);
const STATUS_SET = new Set<string>(OPERATION_STATUSES);
const ACTIVE_STATUSES = new Set<OperationStatus>(["queued", "running"]);

export function isOperationKind(value: unknown): value is OperationKind {
  return typeof value === "string" && KIND_SET.has(value);
}

export function isOperationStatus(value: unknown): value is OperationStatus {
  return typeof value === "string" && STATUS_SET.has(value);
}

export function isActiveOperationStatus(status: OperationStatus | null | undefined): boolean {
  return !!status && ACTIVE_STATUSES.has(status);
}

function clampProgress(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Validate an SSE payload (already JSON-parsed). Returns null when malformed. */
export function parseOperationEvent(raw: unknown): OperationEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.operationId !== "string" || !r.operationId) return null;
  if (typeof r.appId !== "string" || !r.appId) return null;
  if (!isOperationKind(r.kind) || !isOperationStatus(r.status)) return null;
  if (typeof r.at !== "string") return null;
  return {
    operationId: r.operationId,
    appId: r.appId,
    kind: r.kind,
    actor: typeof r.actor === "string" ? r.actor : "system",
    status: r.status,
    step: typeof r.step === "string" ? r.step : null,
    progress: clampProgress(r.progress),
    ...(optionalString(r.message) ? { message: optionalString(r.message) } : {}),
    ...(optionalString(r.error) ? { error: optionalString(r.error) } : {}),
    at: r.at,
  };
}

/** Validate a journal row. Returns null when malformed. */
export function parseOperationRecord(raw: unknown): OperationRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.appId !== "string") return null;
  if (!isOperationKind(r.kind) || !isOperationStatus(r.status)) return null;
  if (typeof r.startedAt !== "string") return null;
  const detail = r.detail && typeof r.detail === "object" && !Array.isArray(r.detail)
    ? (r.detail as Record<string, unknown>)
    : null;
  return {
    id: r.id,
    appId: r.appId,
    kind: r.kind,
    actor: typeof r.actor === "string" ? r.actor : "system",
    status: r.status,
    step: typeof r.step === "string" ? r.step : null,
    progress: clampProgress(r.progress),
    detail,
    error: typeof r.error === "string" && r.error ? r.error : null,
    startedAt: r.startedAt,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : r.startedAt,
    finishedAt: typeof r.finishedAt === "string" ? r.finishedAt : null,
  };
}

/** Validate a history payload; drops malformed rows. */
export function parseOperationHistory(raw: unknown): OperationRecord[] {
  if (!Array.isArray(raw)) return [];
  const rows: OperationRecord[] = [];
  for (const item of raw) {
    const rec = parseOperationRecord(item);
    if (rec) rows.push(rec);
  }
  return rows;
}

export function operationFromRecord(rec: OperationRecord): LiveOperation {
  return {
    operationId: rec.id,
    appId: rec.appId,
    kind: rec.kind,
    actor: rec.actor,
    status: rec.status,
    step: rec.step,
    progress: rec.progress,
    message: null,
    error: rec.error,
    startedAt: rec.startedAt,
    updatedAt: rec.updatedAt,
  };
}

/**
 * Fold one stream event into the live state for `appId`.
 *
 * - Events for other apps are ignored (the stream is also filtered server-side).
 * - A different operation id replaces the state (one operation per app at a time).
 * - Out-of-order events for the same operation (older `at`) are ignored, so a
 *   late "running" never resurrects a finished operation.
 */
export function reduceOperationEvent(
  state: LiveOperation | null,
  event: OperationEvent,
  appId: string,
): LiveOperation | null {
  if (event.appId !== appId) return state;
  if (state && state.operationId === event.operationId) {
    if (event.at < state.updatedAt) return state;
    const sameStep = event.step === state.step;
    return {
      ...state,
      kind: event.kind,
      actor: event.actor,
      status: event.status,
      step: event.step,
      progress: event.status === "succeeded" ? 100 : event.progress,
      message: event.message ?? (sameStep ? state.message : null),
      error: event.error ?? state.error,
      updatedAt: event.at,
    };
  }
  return {
    operationId: event.operationId,
    appId: event.appId,
    kind: event.kind,
    actor: event.actor,
    status: event.status,
    step: event.step,
    progress: event.progress,
    message: event.message ?? null,
    error: event.error ?? null,
    startedAt: event.at,
    updatedAt: event.at,
  };
}

/** The newest still-active operation in a history list, if any. */
export function activeOperationFromHistory(history: readonly OperationRecord[] | null | undefined): LiveOperation | null {
  if (!history) return null;
  const active = history.find((rec) => isActiveOperationStatus(rec.status));
  return active ? operationFromRecord(active) : null;
}

/**
 * Pick what to show from the stream state and the polled journal. The more
 * recently updated view of the same operation wins; for different operations
 * the more recently started one wins.
 */
export function pickLiveOperation(
  streamed: LiveOperation | null,
  polled: LiveOperation | null,
  appId: string,
): LiveOperation | null {
  const a = streamed && streamed.appId === appId ? streamed : null;
  const b = polled && polled.appId === appId ? polled : null;
  if (!a) return b;
  if (!b) return a;
  if (a.operationId === b.operationId) return b.updatedAt > a.updatedAt ? b : a;
  return b.startedAt > a.startedAt ? b : a;
}

// ── Labels ────────────────────────────────────────────────────────────────────

export const OPERATION_KIND_PROGRESS_LABELS: Record<OperationKind, string> = {
  install: "Installing",
  update: "Updating",
  uninstall: "Removing",
  start: "Starting",
  stop: "Stopping",
  restart: "Restarting",
  rollback: "Rolling back",
  backup: "Backing up",
  restore: "Restoring",
  configure: "Applying changes",
};

export const OPERATION_KIND_LABELS: Record<OperationKind, string> = {
  install: "Install",
  update: "Update",
  uninstall: "Uninstall",
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  rollback: "Rollback",
  backup: "Backup",
  restore: "Restore",
  configure: "Configuration change",
};

export const OPERATION_STATUS_LABELS: Record<OperationStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  rolled_back: "Rolled back",
  interrupted: "Interrupted",
};

export type OperationTone = "healthy" | "warning" | "critical" | "muted";

export function operationStatusTone(status: OperationStatus): OperationTone {
  switch (status) {
    case "succeeded":
      return "healthy";
    case "rolled_back":
      return "warning";
    case "failed":
    case "interrupted":
      return "critical";
    default:
      return "muted";
  }
}

/** Step ids written by core stores/lifecycle.ts and backup/**. */
const STEP_LABELS: Record<string, string> = {
  starting: "Starting",
  preparing: "Preparing",
  prepare: "Preparing",
  pulling: "Downloading images",
  creating: "Creating containers",
  running: "Waiting for the app to come up",
  preflight: "Checking the app",
  snapshot: "Saving a rollback point",
  pull: "Downloading new images",
  backup: "Backing up app data",
  recreate: "Switching to the new version",
  verify: "Verifying the app works",
  finalize: "Finishing up",
  rollback: "Rolling back",
  rollback_verify: "Verifying the restored version",
  restore: "Restoring the previous version",
  dependencies: "Starting dependencies",
  start_containers: "Starting containers",
  stop_containers: "Stopping containers",
  recreate_containers: "Recreating containers",
  pre_uninstall_hook: "Running uninstall hook",
  remove_containers: "Removing containers",
  cleanup: "Cleaning up",
  edit_ports: "Updating port mappings",
  done: "Done",
};

export function operationStepLabel(step: string | null | undefined): string {
  if (!step) return "Working";
  const known = STEP_LABELS[step];
  if (known) return known;
  const words = step.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Working";
}

/** "user:abc" → "You", "automation:x" → "Automation", … */
export function operationActorLabel(actor: string | null | undefined): string {
  if (!actor) return "Talome";
  const kind = actor.split(":")[0].toLowerCase();
  switch (kind) {
    case "user":
      return "a user";
    case "automation":
      return "an automation";
    case "agent-loop":
      return "auto-remediation";
    case "assistant":
    case "chat":
      return "the assistant";
    case "mcp":
      return "an AI agent";
    case "scheduler":
    case "auto-update":
      return "the update scheduler";
    case "system":
    case "recovery":
      return "Talome";
    default:
      return kind.replace(/[_-]+/g, " ");
  }
}

// ── Last update result ────────────────────────────────────────────────────────

export interface UpdateResultSummary {
  tone: OperationTone;
  title: string;
  detail: string | null;
  at: string;
  inProgress: boolean;
}

function detailString(detail: Record<string, unknown> | null, key: string): string | null {
  const value = detail?.[key];
  return typeof value === "string" && value ? value : null;
}

/** Summarise `lastUpdateOperation` from GET /api/updates/:appId. */
export function summarizeUpdateOperation(raw: unknown): UpdateResultSummary | null {
  const op = parseOperationRecord(raw);
  if (!op) return null;
  const at = op.finishedAt ?? op.updatedAt;
  const toVersion = detailString(op.detail, "toVersion") ?? detailString(op.detail, "targetVersion");
  const outcome = detailString(op.detail, "outcome");

  if (isActiveOperationStatus(op.status)) {
    return {
      tone: "muted",
      title: op.kind === "rollback" ? "Rollback in progress" : "Update in progress",
      detail: `${operationStepLabel(op.step)} · ${op.progress}%`,
      at,
      inProgress: true,
    };
  }

  if (op.kind === "rollback") {
    if (op.status === "succeeded") {
      return { tone: "warning", title: toVersion ? `Rolled back to v${toVersion}` : "Rolled back", detail: null, at, inProgress: false };
    }
    return { tone: "critical", title: "Rollback failed", detail: op.error, at, inProgress: false };
  }

  switch (op.status) {
    case "succeeded":
      if (outcome === "no_change") {
        return { tone: "healthy", title: "Already up to date", detail: null, at, inProgress: false };
      }
      if (outcome === "unverified") {
        return {
          tone: "warning",
          title: toVersion ? `Updated to v${toVersion} (not verified)` : "Updated (not verified)",
          detail: "The new version started, but Talome could not confirm it works.",
          at,
          inProgress: false,
        };
      }
      return { tone: "healthy", title: toVersion ? `Updated to v${toVersion}` : "Update succeeded", detail: null, at, inProgress: false };
    case "rolled_back":
      return {
        tone: "warning",
        title: "Update rolled back",
        detail: op.error ?? "The new version failed its checks, so the previous version was restored.",
        at,
        inProgress: false,
      };
    case "interrupted":
      return { tone: "critical", title: "Update interrupted", detail: op.error ?? "Talome restarted while the update was running.", at, inProgress: false };
    default:
      return { tone: "critical", title: "Update failed", detail: op.error, at, inProgress: false };
  }
}

// ── Lifecycle API responses ───────────────────────────────────────────────────

export interface OperationConflict {
  operationId: string | null;
  message: string;
}

/** A 409 from install/update/start/stop/restart/uninstall: another operation is running. */
export function parseOperationConflict(status: number, body: unknown): OperationConflict | null {
  if (status !== 409 || !body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.conflict !== true && typeof b.operationId !== "string") return null;
  return {
    operationId: typeof b.operationId === "string" && b.operationId ? b.operationId : null,
    message: typeof b.error === "string" && b.error ? b.error : "Another operation is already running on this app.",
  };
}

export interface LifecycleOutcome {
  kind: "success" | "warning" | "error" | "conflict";
  title: string;
  description?: string;
  operationId: string | null;
}

/** Toast copy for the response of POST /api/apps/:storeId/:appId/update. */
export function describeUpdateResponse(appName: string, status: number, body: unknown): LifecycleOutcome {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const operationId = typeof b.operationId === "string" ? b.operationId : null;
  const error = typeof b.error === "string" && b.error ? b.error : undefined;

  const conflict = parseOperationConflict(status, body);
  if (conflict) {
    return { kind: "conflict", title: `${appName} is busy`, description: conflict.message, operationId: conflict.operationId };
  }
  if (status >= 200 && status < 300) {
    if (b.verified === false) {
      return {
        kind: "warning",
        title: `${appName} updated`,
        description: "The new version is running but could not be verified.",
        operationId,
      };
    }
    return { kind: "success", title: `${appName} updated`, operationId };
  }
  if (b.rolledBack === true) {
    return {
      kind: "warning",
      title: `${appName} update rolled back`,
      description: error ?? "The new version failed its checks; the previous version was restored.",
      operationId,
    };
  }
  return { kind: "error", title: `Failed to update ${appName}`, description: error, operationId };
}
