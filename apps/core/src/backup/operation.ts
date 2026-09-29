/**
 * Backups and restores as journaled app operations.
 *
 * User-, assistant- and schedule-initiated backups and restores run through
 * withAppOperation (kind "backup" / "restore"): they show up in the operations
 * journal with progress, and they conflict cleanly with any other operation on
 * the same app — no restore during an update, no backup stopping containers
 * while an install recreates them.
 *
 * Lock hierarchy (see ops/operations.ts): app operation → compose lock →
 * backup lock (backup/state.ts) → Docker. The engine functions called here
 * (createAppBackup / restoreAppBackup) take the backup lock themselves. A
 * restore that starts the app again does so on the operation it is already
 * running in (startAppWithinHeldOperation), never through a new one.
 *
 * The pre-update backup taken by an update is NOT routed through here: it runs
 * inside the update's own operation and calls createAppBackup directly.
 */

import { randomUUID } from "node:crypto";
import {
  OperationConflictError,
  currentActor,
  hasLiveOperation,
  getActiveOperation,
  withAppOperation,
  type OperationContext,
} from "../ops/operations.js";
import { withAppLock } from "../stores/compose-exec.js";
import { createAppBackup, type CreateAppBackupOptions } from "./engine.js";
import { restoreAppBackup, type RestoreOptions } from "./restore.js";
import { getAppOperation, holdAppMaintenance } from "./state.js";
import type { CreateAppBackupResult, RestoreAppBackupResult } from "./types.js";

export interface OperationMeta {
  /** Journal id of the operation (GET /api/operations/:id) */
  operationId?: string;
  /** True when refused because another operation on the app is running */
  conflict?: boolean;
}

export interface OperationRunOptions {
  /** Who requested it — "user:<id>", "assistant", "schedule:<id>"… (default: current actor) */
  actor?: string;
  /** Called once the operation is journaled and running (not on conflict). */
  onStarted?: (operationId: string) => void;
}

const BACKUP_STAGE_PROGRESS: Record<string, number> = {
  preparing: 5,
  dumping: 20,
  pausing: 30,
  archiving: 40,
  resuming: 80,
  validating: 85,
  uploading: 90,
};

const RESTORE_STAGE_PROGRESS: Record<string, number> = {
  checking: 5,
  "safety-backup": 15,
  stopping: 35,
  extracting: 45,
  "restoring-files": 60,
  starting: 80,
  "health-check": 90,
  "rolling-back": 95,
};

function stageProgress(table: Record<string, number>, stage: string, fallback: number): number {
  if (stage in table) return table[stage];
  if (stage.startsWith("loading-")) return 70;
  return fallback;
}

/**
 * Why a backup/restore of the app cannot start right now, or null. Checks both
 * the app operation journal (updates, installs, … in any process) and the
 * backup module's own lock (e.g. a scheduled backup already running).
 */
export function backupBlockedReason(appId: string): string | null {
  const op = getActiveOperation(appId);
  if (op) return `${/^[aeiou]/.test(op.kind) ? "An" : "A"} ${op.kind} operation is running on '${appId}' (step "${op.step ?? "starting"}", ${op.progress}%). Try again when it finishes.`;
  if (hasLiveOperation(appId)) return `Another operation is running on '${appId}'. Try again when it finishes.`;
  if (getAppOperation(appId)) return `A backup or restore is already running for '${appId}'.`;
  return null;
}

async function runAsOperation<T extends { success: boolean }>(
  appId: string,
  kind: "backup" | "restore",
  opts: OperationRunOptions,
  conflictResult: (error: string) => T,
  fn: (ctx: OperationContext) => Promise<T>,
): Promise<T & OperationMeta> {
  let operationId: string | undefined;
  try {
    const result = await withAppOperation(
      appId,
      kind,
      opts.actor ?? currentActor(),
      (ctx) => {
        operationId = ctx.id;
        try {
          opts.onStarted?.(ctx.id);
        } catch {
          // Callers' notification hooks never break the operation
        }
        // The compose lock serializes against non-journaled compose writers (env edits).
        return withAppLock(appId, () => fn(ctx));
      },
    );
    return { ...result, operationId };
  } catch (err) {
    if (err instanceof OperationConflictError) {
      return { ...conflictResult(err.message), conflict: true, operationId: err.running.id };
    }
    throw err;
  }
}

/** createAppBackup as a journaled "backup" operation. Never throws. */
export async function runBackupOperation(
  appId: string,
  backupOpts: CreateAppBackupOptions = {},
  opts: OperationRunOptions = {},
): Promise<CreateAppBackupResult & OperationMeta> {
  try {
    return await runAsOperation<CreateAppBackupResult>(
      appId,
      "backup",
      opts,
      (error) => ({ success: false, appId, error, code: "busy" }),
      async (ctx) => {
        ctx.step("preparing", 2, "Starting backup");
        const result = await createAppBackup(appId, {
          ...backupOpts,
          onStage: (stage) => {
            ctx.step(stage, stageProgress(BACKUP_STAGE_PROGRESS, stage, 50));
            backupOpts.onStage?.(stage);
          },
        });
        ctx.setDetail(
          result.success
            ? { backupId: result.backupId, method: result.method, sizeBytes: result.sizeBytes, purpose: backupOpts.purpose ?? "manual", warnings: result.warnings }
            : { ...(result.backupId ? { backupId: result.backupId } : {}), error: result.error, code: result.code ?? "failed" },
        );
        return result;
      },
    );
  } catch (err) {
    return { success: false, appId, error: err instanceof Error ? err.message : String(err), code: "failed" };
  }
}

/** restoreAppBackup as a journaled "restore" operation. Never throws. */
export async function runRestoreOperation(
  appId: string,
  backupId: string,
  restoreOpts: RestoreOptions = {},
  opts: OperationRunOptions = {},
): Promise<RestoreAppBackupResult & OperationMeta> {
  const restoreId = restoreOpts.restoreId ?? randomUUID();
  const failed = (error: string): RestoreAppBackupResult => ({
    success: false,
    backupId,
    appId,
    error,
    rolledBack: false,
    safetyBackupId: null,
  });
  try {
    return await runAsOperation<RestoreAppBackupResult>(appId, "restore", opts, failed, async (ctx) => {
      ctx.setDetail({ backupId, restoreId });
      // The whole restore — stop, swap, start, health check — is intentional downtime.
      const releaseMaintenance = holdAppMaintenance(appId, "restore");
      try {
        const result = await restoreAppBackup(backupId, {
          ...restoreOpts,
          restoreId,
          onStage: (stage) => {
            ctx.step(stage, stageProgress(RESTORE_STAGE_PROGRESS, stage, 50));
            restoreOpts.onStage?.(stage);
          },
        });
        ctx.setDetail(
          result.success
            ? { safetyBackupId: result.safetyBackupId, health: result.health.detail, warnings: result.warnings }
            : { error: result.error, rolledBack: result.rolledBack, safetyBackupId: result.safetyBackupId },
        );
        if (!result.success && result.rolledBack) ctx.markRolledBack(result.error);
        return result;
      } finally {
        releaseMaintenance();
      }
    });
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Run arbitrary restore-like work (the legacy restore path) as a journaled
 * operation with a maintenance hold. Never throws.
 */
export async function runLegacyRestoreOperation<T extends { success: boolean; error?: string }>(
  appId: string,
  opts: OperationRunOptions,
  fn: (ctx: OperationContext) => Promise<T>,
): Promise<T | ({ success: false; error: string } & OperationMeta)> {
  try {
    return await runAsOperation<T | { success: false; error: string }>(
      appId,
      "restore",
      opts,
      (error) => ({ success: false, error }),
      async (ctx) => {
        const releaseMaintenance = holdAppMaintenance(appId, "restore");
        try {
          return await fn(ctx);
        } finally {
          releaseMaintenance();
        }
      },
    );
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Start a backup/restore operation in the background and wait only until it
 * is either running (journaled) or refused. Lets fire-and-forget endpoints
 * answer 202/409 honestly.
 */
export async function startInBackground<R extends { success: boolean; error?: string } & OperationMeta>(
  run: (onStarted: (operationId: string) => void) => Promise<R>,
): Promise<{ started: true; operationId: string; done: Promise<R> } | { started: false; conflict: boolean; error: string; operationId?: string; done: Promise<R> }> {
  let signalStarted!: (id: string) => void;
  const started = new Promise<string>((resolve) => {
    signalStarted = resolve;
  });
  const done = run((id) => signalStarted(id));
  const first = await Promise.race([
    started.then((id) => ({ kind: "started" as const, id })),
    done.then((r) => ({ kind: "done" as const, r })),
  ]);
  if (first.kind === "started") return { started: true, operationId: first.id, done };
  const r = first.r;
  if (r.operationId && !r.conflict) return { started: true, operationId: r.operationId, done };
  return { started: false, conflict: r.conflict === true, error: r.error ?? "Operation failed to start", operationId: r.operationId, done };
}
