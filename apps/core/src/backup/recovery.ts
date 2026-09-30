/**
 * Crash recovery for backups and restores.
 *
 * Maintenance windows and stopped-container lists live in memory, so a server
 * restart in the middle of a stop-method backup or a restore used to leave
 * apps stopped (explicitly stopped containers are not revived by their restart
 * policy) and restored data half-swapped. Both operations persist their
 * pending work in `backup_recovery`; this module:
 *
 *   - backup:  starts the containers the backup had stopped
 *   - restore: puts the previous data back (undoing directory swaps), starts
 *              the app again when it was running, and marks the restore row —
 *              or, when the restore had already succeeded ("committed") and
 *              only its cleanup was cut short, finishes the cleanup
 *
 * and writes a notification either way.
 *
 * Backups and restores also run in the MCP stdio process, which shares the
 * database. A record is only recovered once its owner is provably gone: not
 * running in this process, not written by this process since it started, and
 * its operation (app_operations, heartbeat + owner PID) no longer live. The
 * server runs this periodically, not only at startup, so work left behind by
 * a stdio process that died is undone without waiting for a server restart.
 * Recovery itself runs as an app operation, so nothing else touches the app
 * while its data is being put back.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { writeNotification } from "../db/notifications.js";
import {
  ACTIVE_OPERATION_STATUSES,
  HEARTBEAT_STALE_MS,
  OWNER_HOST,
  OperationConflictError,
  hasLiveOperation,
  isForeignOwnerLive,
  isPidAlive,
  withAppOperation,
} from "../ops/operations.js";
import { createLogger } from "../utils/logger.js";
import { startAppViaLifecycle, type AppContainer } from "./docker-ops.js";
import { restartContainers } from "./engine.js";
import { errorMessage, getBackupRoot, isWithin } from "./fs-utils.js";
import { undoSwaps } from "./restore.js";
import { clearRecoveryRecord, listRecoveryRecords, type RecoveryRecord } from "./store.js";

const log = createLogger("backup-recovery");

/** Records written by this process belong to live operations, never to a crashed one. */
const PROCESS_STARTED_AT = Date.now();

/** Actor recorded on the app operations recovery runs in. */
export const RECOVERY_ACTOR = "system:backup-recovery";

export interface RecoveryOutcome {
  id: string;
  appId: string;
  kind: RecoveryRecord["kind"];
  restarted: number;
  undone: boolean;
  /** The restore had succeeded; only its cleanup was finished */
  committed?: boolean;
  errors: string[];
}

function asContainers(list: RecoveryRecord["state"]["containers"]): AppContainer[] {
  return (list ?? []).map((c) => ({ id: c.id, name: c.name, service: null, status: "exited", image: "" }));
}

/**
 * Why a record must be left alone for now (its operation may still be
 * running somewhere), or null when its owner is provably gone.
 */
export function recoveryDeferredReason(
  rec: RecoveryRecord,
  active: { backups: Set<string>; restores: Set<string> },
  startedAt: number = PROCESS_STARTED_AT,
  now: number = Date.now(),
): string | null {
  if (rec.kind === "backup" ? active.backups.has(rec.id) : active.restores.has(rec.id)) return "running in this process";
  const owner = rec.state.owner;
  const updated = Date.parse(rec.updatedAt);
  const writtenSinceStart = Number.isFinite(updated) && updated >= startedAt;
  const ownProcess = !owner || (owner.pid === process.pid && owner.host === OWNER_HOST);
  // Written by this process since it started → an operation still running here
  // (e.g. the safety backup inside a restore, which has no operation of its own).
  // An older record with our PID was written by a previous process (PID reuse).
  if (ownProcess && writtenSinceStart) return "written by this process";
  if (owner && !ownProcess) {
    let opKnown = false;
    if (owner.operationId) {
      try {
        const op = db.select().from(schema.appOperations).where(eq(schema.appOperations.id, owner.operationId)).get();
        if (op) {
          opKnown = true;
          const activeStatus = (ACTIVE_OPERATION_STATUSES as string[]).includes(op.status);
          if (activeStatus && isForeignOwnerLive(op, now, HEARTBEAT_STALE_MS)) return `operation ${op.id} is still running in process ${owner.pid}`;
        }
      } catch {
        return "cannot read the operations journal";
      }
    }
    // No journal row to judge by: a live owner process on this host keeps its record
    if (!opKnown && owner.host === OWNER_HOST && isPidAlive(owner.pid)) return `owner process ${owner.pid} is alive`;
  }
  // Never recover underneath another operation on the app (retried later)
  if (hasLiveOperation(rec.appId)) return "another operation is running on the app";
  return null;
}

async function recoverBackup(rec: RecoveryRecord): Promise<RecoveryOutcome> {
  const containers = asContainers(rec.state.containers);
  const errors = containers.length > 0 ? await restartContainers(rec.appId, containers) : [];
  if (containers.length > 0) {
    writeNotification(
      errors.length > 0 ? "critical" : "warning",
      `Backup of ${rec.appId} was interrupted`,
      errors.length > 0
        ? `Talome restarted while ${rec.appId} was stopped for a backup. Some containers could not be started: ${errors.join("; ")}`
        : `Talome restarted while ${rec.appId} was stopped for a backup. ${containers.length} container(s) were started again.`,
      rec.appId,
    );
  }
  return { id: rec.id, appId: rec.appId, kind: "backup", restarted: containers.length - errors.length, undone: true, errors };
}

/** The restore succeeded before the interruption: delete what it replaced, keep the restored data. */
async function finishCommittedRestore(rec: RecoveryRecord): Promise<RecoveryOutcome> {
  const short = rec.id.slice(0, 8);
  const errors: string[] = [];
  for (const s of rec.state.swaps ?? []) {
    // Only ever delete the copy the restore moved aside (never the live data)
    if (!s.existed || s.old !== `${s.hostPath}.talome-old-${short}`) continue;
    await rm(s.old, { recursive: true, force: true }).catch(() => {});
    if (existsSync(s.old)) errors.push(`${s.old} could not be deleted`);
  }
  const staging = rec.state.stagingDir;
  if (staging && isWithin(join(getBackupRoot(), ".restore"), staging)) await rm(staging, { recursive: true, force: true }).catch(() => {});
  try {
    db.run(sql`UPDATE backup_restores SET status = 'completed', stage = NULL, completed_at = ${new Date().toISOString()}
      WHERE id = ${rec.id} AND status = 'running'`);
  } catch {
    // the row may already be final
  }
  writeNotification(
    errors.length > 0 ? "warning" : "info",
    `Restore of ${rec.appId} completed`,
    `Talome restarted while it was deleting the data the restore replaced. The restored data is in place.` +
      (errors.length > 0 ? ` Some of the previous data could not be deleted — delete it by hand to free the space: ${errors.join("; ")}.` : ""),
    rec.appId,
  );
  return { id: rec.id, appId: rec.appId, kind: "restore", restarted: 0, undone: false, committed: true, errors };
}

async function recoverRestore(rec: RecoveryRecord): Promise<RecoveryOutcome> {
  if (rec.state.committed) return finishCommittedRestore(rec);
  const short = rec.id.slice(0, 8);
  const swaps = rec.state.swaps ?? [];
  const keptAside: string[] = [];
  const errors = swaps.length > 0 ? await undoSwaps(swaps, short, true, keptAside) : [];
  let restarted = 0;
  if (rec.state.restartApp) {
    try {
      const started = await startAppViaLifecycle(rec.appId);
      if (started.success) restarted = 1;
      else errors.push(`start: ${started.error ?? "unknown error"}`);
    } catch (err) {
      errors.push(`start: ${errorMessage(err)}`);
    }
    if (restarted === 0 && (rec.state.containers?.length ?? 0) > 0) {
      const startErrors = await restartContainers(rec.appId, asContainers(rec.state.containers));
      if (startErrors.length === 0) restarted = rec.state.containers!.length;
    }
  }
  const undone = errors.length === 0 && !rec.state.inPlace;
  try {
    db.run(sql`UPDATE backup_restores SET status = ${undone ? "rolled_back" : "failed"}, stage = NULL,
      error = 'Interrupted (Talome restarted or the process running it stopped)', completed_at = ${new Date().toISOString()}
      WHERE id = ${rec.id} AND status = 'running'`);
  } catch {
    // the row may not exist (crash before it was written)
  }
  const parts: string[] = ["A restore was interrupted (Talome restarted, or the process running it stopped)."];
  if (swaps.length > 0) parts.push(errors.length === 0 ? "The previous data was put back." : `Putting the previous data back failed: ${errors.join("; ")}.`);
  if (rec.state.inPlace) {
    parts.push(
      rec.state.safetyBackupId
        ? `Some data was changed in place — restore the safety backup ${rec.state.safetyBackupId} to be sure.`
        : "Some data was changed in place and no safety backup exists — check the app.",
    );
  }
  if (keptAside.length > 0) parts.push(`Partially restored data was kept at: ${keptAside.join(", ")}.`);
  writeNotification(undone ? "warning" : "critical", `Restore of ${rec.appId} was interrupted`, parts.join(" "), rec.appId, { operationId: rec.id });
  return { id: rec.id, appId: rec.appId, kind: "restore", restarted, undone, errors };
}

/**
 * Undo work left pending by operations that are no longer running (server
 * restarted, or the process running them died). Records whose operation may
 * still be running are left for a later pass. Never throws.
 */
export async function recoverPendingOperations(
  active: { backups: Set<string>; restores: Set<string> },
  startedAt: number = PROCESS_STARTED_AT,
): Promise<RecoveryOutcome[]> {
  const outcomes: RecoveryOutcome[] = [];
  let records: RecoveryRecord[] = [];
  try {
    records = listRecoveryRecords();
  } catch (err) {
    log.error("cannot read recovery records", err);
    return outcomes;
  }
  for (const rec of records) {
    const deferred = recoveryDeferredReason(rec, active, startedAt);
    if (deferred) continue;
    try {
      // As an app operation: no update/backup/restore can start on the app while its data is put back
      const outcome = await withAppOperation(rec.appId, rec.kind === "backup" ? "start" : "restore", RECOVERY_ACTOR, async (ctx) => {
        ctx.setDetail({ recovery: rec.id, recoveredKind: rec.kind });
        // Re-check under the operation lock (the owner may have finished meanwhile)
        const latest = listRecoveryRecords().find((r) => r.id === rec.id);
        if (!latest) return null;
        const outcome = latest.kind === "backup" ? await recoverBackup(latest) : await recoverRestore(latest);
        clearRecoveryRecord(latest.id);
        return outcome;
      });
      if (outcome) {
        outcomes.push(outcome);
        log.warn(`recovered interrupted ${rec.kind} ${rec.id} for ${rec.appId}`, outcome.errors);
      }
    } catch (err) {
      if (err instanceof OperationConflictError) continue; // retried on the next pass
      log.error(`recovery of ${rec.kind} ${rec.id} failed`, err);
      clearRecoveryRecord(rec.id);
    }
  }
  return outcomes;
}
