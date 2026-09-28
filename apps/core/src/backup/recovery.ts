/**
 * Crash recovery for backups and restores.
 *
 * Maintenance windows and stopped-container lists live in memory, so a server
 * restart in the middle of a stop-method backup or a restore used to leave
 * apps stopped (explicitly stopped containers are not revived by their restart
 * policy) and restored data half-swapped. Both operations persist their
 * pending work in `backup_recovery`; on startup this module:
 *
 *   - backup:  starts the containers the backup had stopped
 *   - restore: puts the previous data back (undoing directory swaps), starts
 *              the app again when it was running, and marks the restore row
 *
 * and writes a notification either way.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { writeNotification } from "../db/notifications.js";
import { createLogger } from "../utils/logger.js";
import { startAppViaLifecycle, type AppContainer } from "./docker-ops.js";
import { restartContainers } from "./engine.js";
import { errorMessage } from "./fs-utils.js";
import { undoSwaps } from "./restore.js";
import { clearRecoveryRecord, listRecoveryRecords, type RecoveryRecord } from "./store.js";

const log = createLogger("backup-recovery");

/** Records written by this process belong to live operations, never to a crashed one. */
const PROCESS_STARTED_AT = Date.now();

export interface RecoveryOutcome {
  id: string;
  appId: string;
  kind: RecoveryRecord["kind"];
  restarted: number;
  undone: boolean;
  errors: string[];
}

function asContainers(list: RecoveryRecord["state"]["containers"]): AppContainer[] {
  return (list ?? []).map((c) => ({ id: c.id, name: c.name, service: null, status: "exited", image: "" }));
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

async function recoverRestore(rec: RecoveryRecord): Promise<RecoveryOutcome> {
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
      error = 'Interrupted by a server restart', completed_at = ${new Date().toISOString()}
      WHERE id = ${rec.id} AND status = 'running'`);
  } catch {
    // the row may not exist (crash before it was written)
  }
  const parts: string[] = ["Talome restarted in the middle of a restore."];
  if (swaps.length > 0) parts.push(errors.length === 0 ? "The previous data was put back." : `Putting the previous data back failed: ${errors.join("; ")}.`);
  if (rec.state.inPlace) {
    parts.push(
      rec.state.safetyBackupId
        ? `Some data was changed in place — restore the safety backup ${rec.state.safetyBackupId} to be sure.`
        : "Some data was changed in place and no safety backup exists — check the app.",
    );
  }
  if (keptAside.length > 0) parts.push(`Partially restored data was kept at: ${keptAside.join(", ")}.`);
  writeNotification(undone ? "warning" : "critical", `Restore of ${rec.appId} was interrupted`, parts.join(" "), rec.appId);
  return { id: rec.id, appId: rec.appId, kind: "restore", restarted, undone, errors };
}

/**
 * Undo work left pending by operations that are no longer running (server
 * restarted mid-way). Never throws.
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
    if (rec.kind === "backup" ? active.backups.has(rec.id) : active.restores.has(rec.id)) continue;
    // Written since this process started → an operation that is still running here
    // (e.g. the safety backup inside a restore, which has no operation of its own)
    const updated = Date.parse(rec.updatedAt);
    if (Number.isFinite(updated) && updated >= startedAt) continue;
    try {
      const outcome = rec.kind === "backup" ? await recoverBackup(rec) : await recoverRestore(rec);
      outcomes.push(outcome);
      log.warn(`recovered interrupted ${rec.kind} ${rec.id} for ${rec.appId}`, outcome.errors);
    } catch (err) {
      log.error(`recovery of ${rec.kind} ${rec.id} failed`, err);
    } finally {
      clearRecoveryRecord(rec.id);
    }
  }
  return outcomes;
}
