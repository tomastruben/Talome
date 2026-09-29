// ── Pre-update backup ─────────────────────────────────────────────────────────
//
// Taken through the backup engine (backup/index.ts createAppBackup): application
// consistent (database dump or a brief stop of the app), checksummed, with a
// manifest, verifiable, and restorable per app with restore_app / the Backups
// UI. The backup id is recorded on the update operation so a data restore can
// be offered after a rollback.
//
// Lock interplay: the update already holds the app operation (and the compose
// lock). createAppBackup only takes the backup module's own per-app lock and
// talks to Docker directly — it never calls a public lifecycle entry point, so
// it cannot re-enter the app operation (conflict) or the compose lock
// (deadlock). Containers it stops for the "stop" method are always started
// again before it returns.
//
// Never throws: the result says whether a backup happened and, when it did
// not, whether that is a failure (the update is aborted unless forced) or a
// skip (the app has nothing a backup could capture).

import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { BackupFailureCode, CreateAppBackupResult } from "../backup/types.js";

export interface PreUpdateBackupResult {
  attempted: boolean;
  success: boolean;
  /** Backup id in the backups table (restore with restore_app / POST /api/backups/:id/restore) */
  backupId?: string;
  backupFile?: string;
  manifestPath?: string;
  sizeBytes?: number;
  method?: string;
  warnings?: string[];
  error?: string;
  /** Machine-readable failure reason from the backup engine */
  code?: BackupFailureCode;
  /**
   * True when nothing could be backed up (named Docker volumes only / no bind
   * mounts): not a failure, the update proceeds with a warning.
   */
  skipped?: boolean;
  /** Why no backup was attempted */
  reason?: string;
}

/**
 * Opt-in: only an explicit update policy with preBackup enables it (matches
 * GET /api/updates/policies/:appId, whose default is preBackup: false).
 * Pre-update backups are pruned by the backup maintenance job (the newest few
 * safety backups per app are kept).
 */
export function isPreUpdateBackupEnabled(appId: string): boolean {
  try {
    const policy = db
      .select({ preBackup: schema.appUpdatePolicies.preBackup })
      .from(schema.appUpdatePolicies)
      .where(eq(schema.appUpdatePolicies.appId, appId))
      .get();
    return policy?.preBackup ?? false;
  } catch {
    return false;
  }
}

export type PreUpdateBackupTrigger = "manual" | "schedule";

export interface PreUpdateBackupOptions {
  /** Called with backup engine stages (preparing, dumping, pausing, archiving, …) */
  onStage?: (stage: string) => void;
  /** Who started the update: a person/assistant ("manual") or a schedule/automation */
  triggeredBy?: PreUpdateBackupTrigger;
  /** Test seam */
  createBackup?: (appId: string, opts: { purpose: "pre-update"; triggeredBy: PreUpdateBackupTrigger; onStage?: (stage: string) => void }) => Promise<CreateAppBackupResult>;
}

/** Backup trigger for an operation actor ("schedule:<id>", "automation:<id>" → schedule). */
export function backupTriggerForActor(actor: string): PreUpdateBackupTrigger {
  return /^(schedule|automation|auto-update)(:|$)/.test(actor) ? "schedule" : "manual";
}

export async function takePreUpdateBackup(appId: string, opts: PreUpdateBackupOptions = {}): Promise<PreUpdateBackupResult> {
  let createBackup = opts.createBackup;
  if (!createBackup) {
    try {
      createBackup = (await import("../backup/index.js")).createAppBackup;
    } catch (err) {
      // Only called when the policy requires a backup: an unloadable backup
      // module is a failed backup (aborts the update unless forced), not a skip.
      return { attempted: true, success: false, error: `Backup module unavailable: ${err instanceof Error ? err.message : String(err)}`, code: "failed" };
    }
  }

  let result: CreateAppBackupResult;
  try {
    result = await createBackup(appId, { purpose: "pre-update", triggeredBy: opts.triggeredBy ?? "manual", onStage: opts.onStage });
  } catch (err) {
    return { attempted: true, success: false, error: err instanceof Error ? err.message : String(err), code: "failed" };
  }

  if (!result.success) {
    const code = result.code ?? "failed";
    return {
      attempted: true,
      success: false,
      error: result.error,
      code,
      ...(result.backupId ? { backupId: result.backupId } : {}),
      ...(code === "nothing_to_backup" ? { skipped: true } : {}),
    };
  }
  return {
    attempted: true,
    success: true,
    backupId: result.backupId,
    backupFile: result.archivePath,
    manifestPath: result.manifestPath,
    sizeBytes: result.sizeBytes,
    method: result.method,
    warnings: result.warnings,
  };
}

/** True when the backup still exists and completed (safety backups get pruned). */
function isRestorableBackup(backupId: string): boolean {
  const row = db
    .select({ status: schema.backups.status })
    .from(schema.backups)
    .where(eq(schema.backups.id, backupId))
    .get();
  return row?.status === "completed";
}

/**
 * Find the pre-update backup taken by an update operation (for offering a data
 * restore after a rollback). Falls back to the archive path recorded on the
 * update snapshot. Null when that backup was pruned or never completed.
 */
export function findPreUpdateBackupId(snapshot: { operationId?: string | null; backupPath?: string | null }): string | null {
  try {
    if (snapshot.operationId) {
      const op = db
        .select({ detail: schema.appOperations.detail })
        .from(schema.appOperations)
        .where(eq(schema.appOperations.id, snapshot.operationId))
        .get();
      if (op?.detail) {
        const detail = JSON.parse(op.detail) as { backup?: { backupId?: unknown; success?: unknown } };
        if (detail.backup?.success === true && typeof detail.backup.backupId === "string") {
          return isRestorableBackup(detail.backup.backupId) ? detail.backup.backupId : null;
        }
      }
    }
    if (snapshot.backupPath) {
      const row = db
        .select({ id: schema.backups.id, status: schema.backups.status })
        .from(schema.backups)
        .where(eq(schema.backups.filePath, snapshot.backupPath))
        .get();
      if (row?.status === "completed") return row.id;
    }
  } catch {
    // Best effort
  }
  return null;
}
