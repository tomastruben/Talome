/**
 * In-process coordination for backup/restore/verify operations:
 * one backup-or-restore per app at a time, progress stages for the UI and
 * cancellation.
 */

export type AppOperationKind = "backup" | "restore";

export interface AppOperation {
  kind: AppOperationKind;
  id: string;
  appId: string;
  stage: string;
  startedAt: number;
  controller: AbortController;
}

export interface OperationHandle {
  op: AppOperation;
  setStage: (stage: string) => void;
  release: () => void;
}

const operations = new Map<string, AppOperation>();
const verifying = new Set<string>();

export function acquireAppOperation(appId: string, kind: AppOperationKind, id: string): OperationHandle | null {
  if (operations.has(appId)) return null;
  const op: AppOperation = { kind, id, appId, stage: "preparing", startedAt: Date.now(), controller: new AbortController() };
  operations.set(appId, op);
  return {
    op,
    setStage: (stage) => {
      op.stage = stage;
    },
    release: () => {
      if (operations.get(appId) === op) operations.delete(appId);
    },
  };
}

export function getAppOperation(appId: string): AppOperation | null {
  return operations.get(appId) ?? null;
}

export function listAppOperations(): AppOperation[] {
  return [...operations.values()];
}

/** Progress of running backups keyed by appId (shape kept for older callers). */
export function getBackupProgress(): Map<string, { backupId: string; stage: string; startedAt: number }> {
  const out = new Map<string, { backupId: string; stage: string; startedAt: number }>();
  for (const op of operations.values()) {
    if (op.kind === "backup") out.set(op.appId, { backupId: op.id, stage: op.stage, startedAt: op.startedAt });
  }
  return out;
}

export function isAppBackupRunning(appId?: string): boolean {
  if (appId) return operations.get(appId)?.kind === "backup";
  return [...operations.values()].some((op) => op.kind === "backup");
}

/** Cancel a running backup for an app. Restores are never cancelled mid-way. */
export function cancelAppBackup(appId: string): boolean {
  const op = operations.get(appId);
  if (!op || op.kind !== "backup") return false;
  op.controller.abort();
  return true;
}

export function tryStartVerify(backupId: string): boolean {
  if (verifying.has(backupId)) return false;
  verifying.add(backupId);
  return true;
}

export function endVerify(backupId: string): void {
  verifying.delete(backupId);
}

export function activeIds(): { backups: Set<string>; restores: Set<string>; verifies: Set<string> } {
  const backups = new Set<string>();
  const restores = new Set<string>();
  for (const op of operations.values()) (op.kind === "backup" ? backups : restores).add(op.id);
  return { backups, restores, verifies: new Set(verifying) };
}

// ── Maintenance window ──────────────────────────────────────────────────────
// Containers stopped or recreated on purpose — by a backup/restore, an update
// or a rollback. Monitors, detectors and the agent loop consult this so an
// intentional stop doesn't raise "container down" alerts or trigger
// auto-remediation (which would restart the app mid-operation).
//
// Two layers:
//   • container keys (name/id) marked by whoever stops a container;
//   • app holds (holdAppMaintenance) taken for the whole of an update,
//     rollback or restore. While an app is held, releasing its container keys
//     (e.g. a pre-update backup finishing inside an update) does not end the
//     window, and every container named after the app counts as in the window
//     (recreated containers get new ids). The window ends — after a short
//     grace period — when the last hold is released.

const MAINTENANCE_GRACE_MS = 2 * 60 * 1000;
const maintenance = new Map<string, { appId: string; until: number }>();
const appHolds = new Map<string, Map<symbol, { reason: string; since: number }>>();
/** Grace period after the last hold on an app was released. */
const appGraceUntil = new Map<string, number>();

export function markContainersInMaintenance(appId: string, keys: Array<string | null | undefined>): void {
  for (const key of keys) if (key) maintenance.set(key.replace(/^\//, ""), { appId, until: Number.POSITIVE_INFINITY });
}

function expireAppEntries(appId: string, graceMs: number): void {
  const until = Date.now() + graceMs;
  for (const entry of maintenance.values()) if (entry.appId === appId) entry.until = until;
}

/**
 * End the window for an app's containers after a short grace period (restart
 * settling). No-op while an operation still holds the app in maintenance: the
 * holder ends the window when it releases its hold.
 */
export function releaseAppMaintenance(appId: string, graceMs = MAINTENANCE_GRACE_MS): void {
  if ((appHolds.get(appId)?.size ?? 0) > 0) return;
  expireAppEntries(appId, graceMs);
}

/**
 * Hold an app in maintenance for the duration of an operation that stops or
 * recreates its containers. Returns an idempotent release function — call it
 * in `finally`.
 */
export function holdAppMaintenance(
  appId: string,
  reason: string,
  keys: Array<string | null | undefined> = [],
  graceMs = MAINTENANCE_GRACE_MS,
): () => void {
  const token = Symbol(reason);
  const holds = appHolds.get(appId) ?? new Map<symbol, { reason: string; since: number }>();
  holds.set(token, { reason, since: Date.now() });
  appHolds.set(appId, holds);
  appGraceUntil.delete(appId);
  markContainersInMaintenance(appId, keys);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = appHolds.get(appId);
    current?.delete(token);
    if (current && current.size > 0) return;
    appHolds.delete(appId);
    appGraceUntil.set(appId, Date.now() + graceMs);
    expireAppEntries(appId, graceMs);
  };
}

/** Why an app is held in maintenance right now (empty when it is not held). */
export function getAppMaintenanceReasons(appId: string): string[] {
  return [...(appHolds.get(appId)?.values() ?? [])].map((h) => h.reason);
}

/** True while an app is held in maintenance, inside the grace period after it, or has containers marked. */
export function isAppInMaintenance(appId: string): boolean {
  if ((appHolds.get(appId)?.size ?? 0) > 0) return true;
  const now = Date.now();
  const grace = appGraceUntil.get(appId);
  if (grace !== undefined) {
    if (grace >= now) return true;
    appGraceUntil.delete(appId);
  }
  for (const entry of maintenance.values()) if (entry.appId === appId && entry.until >= now) return true;
  return false;
}

/** Container names Docker Compose (or a plain `container_name`) gives an app's containers. */
function nameBelongsToApp(name: string, appId: string): boolean {
  const n = name.toLowerCase();
  const a = appId.toLowerCase();
  return n === a || n.startsWith(`${a}-`) || n.startsWith(`${a}_`);
}

/** Apps currently held (or in their post-hold grace period). */
function appsInHoldWindow(now: number): string[] {
  const ids = new Set<string>(appHolds.keys());
  for (const [appId, until] of appGraceUntil) {
    if (until >= now) ids.add(appId);
    else appGraceUntil.delete(appId);
  }
  return [...ids];
}

/**
 * True when a container (by name or id, short or full) is stopped or recreated
 * on purpose by a backup, restore, update or rollback.
 */
export function isContainerInMaintenanceWindow(...keys: Array<string | null | undefined>): boolean {
  return isContainerInBackupWindow(...keys);
}

/** True when a container (by name or id, short or full) is stopped on purpose by a backup/restore/update. */
export function isContainerInBackupWindow(...keys: Array<string | null | undefined>): boolean {
  const now = Date.now();
  for (const [key, entry] of maintenance) {
    if (entry.until < now && (appHolds.get(entry.appId)?.size ?? 0) === 0) maintenance.delete(key);
  }
  const heldApps = appsInHoldWindow(now);
  for (const k of keys) {
    if (!k) continue;
    const name = k.replace(/^\//, "");
    if (maintenance.has(name)) return true;
    if (heldApps.some((appId) => nameBelongsToApp(name, appId))) return true;
    // Container ids: short (12) and full (64) hex forms refer to the same container
    if (/^[0-9a-f]{12,64}$/.test(name)) {
      for (const key of maintenance.keys()) {
        if (/^[0-9a-f]{12,64}$/.test(key) && (key.startsWith(name) || name.startsWith(key))) return true;
      }
    }
  }
  return false;
}

/** Test-only: forget every maintenance window and hold. */
export function __resetMaintenanceForTests(): void {
  maintenance.clear();
  appHolds.clear();
  appGraceUntil.clear();
}
