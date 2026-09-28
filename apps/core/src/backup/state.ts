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
// Containers stopped on purpose by a backup/restore. Monitors and the agent
// loop consult this so an intentional stop doesn't raise "container down"
// alerts or trigger auto-remediation (which would restart the app mid-backup).

const MAINTENANCE_GRACE_MS = 2 * 60 * 1000;
const maintenance = new Map<string, { appId: string; until: number }>();

export function markContainersInMaintenance(appId: string, keys: Array<string | null | undefined>): void {
  for (const key of keys) if (key) maintenance.set(key, { appId, until: Number.POSITIVE_INFINITY });
}

/** End the window for an app's containers after a short grace period (restart settling). */
export function releaseAppMaintenance(appId: string, graceMs = MAINTENANCE_GRACE_MS): void {
  const until = Date.now() + graceMs;
  for (const entry of maintenance.values()) if (entry.appId === appId) entry.until = until;
}

/** True when a container (by name or id, short or full) is stopped on purpose by a backup/restore. */
export function isContainerInBackupWindow(...keys: Array<string | null | undefined>): boolean {
  const now = Date.now();
  for (const [key, entry] of maintenance) if (entry.until < now) maintenance.delete(key);
  for (const k of keys) {
    if (!k) continue;
    const name = k.replace(/^\//, "");
    if (maintenance.has(name)) return true;
    // Container ids: short (12) and full (64) hex forms refer to the same container
    if (/^[0-9a-f]{12,64}$/.test(name)) {
      for (const key of maintenance.keys()) {
        if (/^[0-9a-f]{12,64}$/.test(key) && (key.startsWith(name) || name.startsWith(key))) return true;
      }
    }
  }
  return false;
}
