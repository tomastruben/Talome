/**
 * Database access for the backup engine (backups, per-app config, restores).
 * Raw SQL keeps it compatible with rows written by older Talome versions.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { OWNER_HOST, getHeldOperation } from "../ops/operations.js";
import {
  appBackupConfigSchema,
  type AppBackupConfig,
  type AppBackupConfigPatch,
  type BackupPurpose,
  type ConsistencyMethod,
  type VerifyStatus,
} from "./types.js";

export interface BackupRow {
  id: string;
  app_id: string | null;
  status: string;
  file_path: string | null;
  size_bytes: number | null;
  cloud_target: string | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
  triggered_by: string;
  method: ConsistencyMethod | null;
  manifest_path: string | null;
  archive_sha256: string | null;
  purpose: BackupPurpose | null;
  schedule_id: string | null;
  destination_id: string | null;
  app_version: string | null;
  warnings: string | null;
  verify_status: VerifyStatus | null;
  verified_at: string | null;
  verify_detail: string | null;
}

export function getBackupRow(id: string): BackupRow | null {
  return (db.get(sql`SELECT * FROM backups WHERE id = ${id}`) as BackupRow | undefined) ?? null;
}

export function insertRunningBackup(row: {
  id: string;
  appId: string;
  startedAt: string;
  triggeredBy: "manual" | "schedule";
  purpose: BackupPurpose;
  scheduleId: string | null;
  appVersion: string | null;
}): void {
  db.run(sql`INSERT INTO backups (id, app_id, status, started_at, triggered_by, purpose, schedule_id, app_version)
    VALUES (${row.id}, ${row.appId}, 'running', ${row.startedAt}, ${row.triggeredBy}, ${row.purpose}, ${row.scheduleId}, ${row.appVersion})`);
}

export function markBackupCompleted(row: {
  id: string;
  filePath: string;
  manifestPath: string;
  sizeBytes: number;
  archiveSha256: string;
  method: ConsistencyMethod;
  warnings: string[];
  completedAt: string;
}): void {
  db.run(sql`UPDATE backups SET status = 'completed', file_path = ${row.filePath}, manifest_path = ${row.manifestPath},
    size_bytes = ${row.sizeBytes}, archive_sha256 = ${row.archiveSha256}, method = ${row.method},
    warnings = ${row.warnings.length > 0 ? JSON.stringify(row.warnings) : null}, completed_at = ${row.completedAt}, error = NULL
    WHERE id = ${row.id}`);
}

export function markBackupFailed(id: string, status: "failed" | "cancelled", error: string, method: ConsistencyMethod | null): void {
  db.run(sql`UPDATE backups SET status = ${status}, error = ${error}, method = ${method}, completed_at = ${new Date().toISOString()} WHERE id = ${id}`);
}

export function setBackupDestination(id: string, destinationId: string | null, location: string | null): void {
  db.run(sql`UPDATE backups SET destination_id = ${destinationId}, cloud_target = ${location} WHERE id = ${id}`);
}

export function appendBackupWarning(id: string, warning: string): void {
  const row = getBackupRow(id);
  if (!row) return;
  const list = parseJsonArray(row.warnings);
  list.push(warning);
  db.run(sql`UPDATE backups SET warnings = ${JSON.stringify(list)} WHERE id = ${id}`);
}

export function setVerifyState(id: string, status: VerifyStatus | null, verifiedAt: string | null, detail: string | null): void {
  db.run(sql`UPDATE backups SET verify_status = ${status}, verified_at = ${verifiedAt}, verify_detail = ${detail} WHERE id = ${id}`);
}

export function deleteBackupRow(id: string): void {
  db.run(sql`DELETE FROM backups WHERE id = ${id}`);
}

export function listCompletedBackups(appId: string): BackupRow[] {
  return db.all(
    sql`SELECT * FROM backups WHERE app_id = ${appId} AND status = 'completed' ORDER BY completed_at DESC`,
  ) as BackupRow[];
}

export function listAppBackups(appId: string, limit = 50): BackupRow[] {
  return db.all(sql`SELECT * FROM backups WHERE app_id = ${appId} ORDER BY started_at DESC LIMIT ${limit}`) as BackupRow[];
}

export function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

// ── Per-app config ──────────────────────────────────────────────────────────

interface ConfigRow {
  app_id: string;
  method: string;
  exclude_patterns: string;
  include_volumes: string | null;
  health_url: string | null;
  updated_at: string;
}

export function getAppBackupConfig(appId: string): AppBackupConfig {
  const row = db.get(sql`SELECT * FROM app_backup_configs WHERE app_id = ${appId}`) as ConfigRow | undefined;
  if (!row) return appBackupConfigSchema.parse({});
  const parsed = appBackupConfigSchema.safeParse({
    method: row.method,
    excludePatterns: parseJsonArray(row.exclude_patterns),
    includeVolumes: row.include_volumes === null ? null : parseJsonArray(row.include_volumes),
    healthUrl: row.health_url,
  });
  return parsed.success ? parsed.data : appBackupConfigSchema.parse({});
}

/** Merge a partial update into an app's backup config (creates the row if needed). */
export function setAppBackupConfig(appId: string, patch: AppBackupConfigPatch): AppBackupConfig {
  const current = getAppBackupConfig(appId);
  const next = appBackupConfigSchema.parse({
    method: patch.method ?? current.method,
    excludePatterns: patch.excludePatterns ?? current.excludePatterns,
    includeVolumes: patch.includeVolumes === undefined ? current.includeVolumes : patch.includeVolumes,
    healthUrl: patch.healthUrl === undefined ? current.healthUrl : patch.healthUrl,
  });
  const now = new Date().toISOString();
  const excludes = JSON.stringify(next.excludePatterns);
  const includes = next.includeVolumes === null ? null : JSON.stringify(next.includeVolumes);
  db.run(sql`INSERT INTO app_backup_configs (app_id, method, exclude_patterns, include_volumes, health_url, updated_at)
    VALUES (${appId}, ${next.method}, ${excludes}, ${includes}, ${next.healthUrl}, ${now})
    ON CONFLICT(app_id) DO UPDATE SET method = ${next.method}, exclude_patterns = ${excludes},
      include_volumes = ${includes}, health_url = ${next.healthUrl}, updated_at = ${now}`);
  return next;
}

// ── Restores ────────────────────────────────────────────────────────────────

export interface RestoreRow {
  id: string;
  backup_id: string;
  app_id: string;
  status: "running" | "completed" | "failed" | "rolled_back";
  stage: string | null;
  safety_backup_id: string | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
  detail: string | null;
}

export function insertRestore(id: string, backupId: string, appId: string): void {
  db.run(sql`INSERT INTO backup_restores (id, backup_id, app_id, status, stage, started_at)
    VALUES (${id}, ${backupId}, ${appId}, 'running', 'preparing', ${new Date().toISOString()})`);
}

/**
 * Record a restore's stage. A known safety backup id is recorded once and
 * never cleared: nested work (the rollback restoring the safety backup, which
 * has no safety backup of its own) reports `null` for it.
 */
export function updateRestoreStage(id: string, stage: string, safetyBackupId?: string | null): void {
  if (safetyBackupId) {
    db.run(sql`UPDATE backup_restores SET stage = ${stage}, safety_backup_id = ${safetyBackupId} WHERE id = ${id}`);
  } else {
    db.run(sql`UPDATE backup_restores SET stage = ${stage} WHERE id = ${id}`);
  }
}

export function finishRestore(id: string, status: RestoreRow["status"], error: string | null, detail: unknown): void {
  const safetyBackupId =
    detail && typeof detail === "object" && typeof (detail as { safetyBackupId?: unknown }).safetyBackupId === "string"
      ? (detail as { safetyBackupId: string }).safetyBackupId
      : null;
  db.run(sql`UPDATE backup_restores SET status = ${status}, stage = NULL, error = ${error},
    safety_backup_id = COALESCE(safety_backup_id, ${safetyBackupId}),
    detail = ${detail === undefined ? null : JSON.stringify(detail)}, completed_at = ${new Date().toISOString()} WHERE id = ${id}`);
}

export function getRestoreRow(id: string): RestoreRow | null {
  return (db.get(sql`SELECT * FROM backup_restores WHERE id = ${id}`) as RestoreRow | undefined) ?? null;
}

export function listRestores(appId?: string, limit = 20): RestoreRow[] {
  if (appId) {
    return db.all(sql`SELECT * FROM backup_restores WHERE app_id = ${appId} ORDER BY started_at DESC LIMIT ${limit}`) as RestoreRow[];
  }
  return db.all(sql`SELECT * FROM backup_restores ORDER BY started_at DESC LIMIT ${limit}`) as RestoreRow[];
}

export interface InterruptedSweepOptions {
  /**
   * True while an operation on the app is running (in this process or in
   * another live one, e.g. the MCP stdio server). Its rows are left alone.
   */
  isAppBusy?: (appId: string) => boolean;
  /** Also reset "running" verifications (only safe at startup) */
  verifies?: boolean;
}

/**
 * Mark rows left "running" by an operation that is no longer running (server
 * restarted, or the process that ran it died) as failed.
 */
export function recoverInterruptedOperations(
  active: { backups: Set<string>; restores: Set<string>; verifies: Set<string> },
  opts: InterruptedSweepOptions = {},
): number {
  const now = new Date().toISOString();
  const busy = (appId: string | null) => {
    if (!appId || !opts.isAppBusy) return false;
    try {
      return opts.isAppBusy(appId);
    } catch {
      return true;
    }
  };
  let recovered = 0;
  const running = db.all(sql`SELECT id, app_id FROM backups WHERE status IN ('running', 'pending')`) as Array<{ id: string; app_id: string | null }>;
  for (const r of running) {
    if (active.backups.has(r.id) || busy(r.app_id)) continue;
    db.run(sql`UPDATE backups SET status = 'failed', error = COALESCE(error, 'Interrupted (server restarted)'), completed_at = ${now} WHERE id = ${r.id}`);
    recovered++;
  }
  if (opts.verifies !== false) {
    const verifying = db.all(sql`SELECT id FROM backups WHERE verify_status = 'running'`) as Array<{ id: string }>;
    for (const r of verifying) {
      if (active.verifies.has(r.id)) continue;
      db.run(sql`UPDATE backups SET verify_status = NULL WHERE id = ${r.id}`);
    }
  }
  const restores = db.all(sql`SELECT id, app_id FROM backup_restores WHERE status = 'running'`) as Array<{ id: string; app_id: string }>;
  for (const r of restores) {
    if (active.restores.has(r.id) || busy(r.app_id)) continue;
    db.run(sql`UPDATE backup_restores SET status = 'failed', stage = NULL, error = COALESCE(error, 'Interrupted (server restarted)'), completed_at = ${now} WHERE id = ${r.id}`);
    recovered++;
  }
  return recovered;
}

// ── Crash recovery records ──────────────────────────────────────────────────

export interface RecoverySwap {
  hostPath: string;
  old: string;
  existed: boolean;
  carried: string[];
}

export interface RecoveryState {
  /** Containers stopped on purpose that must be started again */
  containers?: Array<{ id: string; name: string }>;
  /** Directory swaps made by a restore (undone on recovery) */
  swaps?: RecoverySwap[];
  /** Start the app through the lifecycle after recovery (it was running) */
  restartApp?: boolean;
  /** Data was changed in place — only the safety backup can undo it */
  inPlace?: boolean;
  safetyBackupId?: string | null;
  /**
   * The restore succeeded and only the previous data (the swaps' old copies,
   * the staging dir) remained to be deleted. Recovery finishes the cleanup
   * instead of undoing the restore.
   */
  committed?: boolean;
  stagingDir?: string;
  /** Process running the operation — recovery never touches a live owner's work */
  owner?: RecoveryOwner;
}

export interface RecoveryOwner {
  pid: number;
  host: string;
  /** Journal id (app_operations) of the operation the work runs in, if any */
  operationId: string | null;
}

export interface RecoveryRecord {
  id: string;
  appId: string;
  kind: "backup" | "restore";
  state: RecoveryState;
  updatedAt: string;
}

/** Persist pending work for an operation. Best effort — never throws. */
export function saveRecoveryRecord(id: string, appId: string, kind: RecoveryRecord["kind"], state: RecoveryState): void {
  try {
    const owner: RecoveryOwner = { pid: process.pid, host: OWNER_HOST, operationId: getHeldOperation(appId)?.id ?? null };
    const json = JSON.stringify({ ...state, owner });
    const now = new Date().toISOString();
    db.run(sql`INSERT INTO backup_recovery (id, app_id, kind, state, updated_at) VALUES (${id}, ${appId}, ${kind}, ${json}, ${now})
      ON CONFLICT(id) DO UPDATE SET state = ${json}, updated_at = ${now}`);
  } catch {
    // recovery bookkeeping must never break the operation itself
  }
}

export function clearRecoveryRecord(id: string): void {
  try {
    db.run(sql`DELETE FROM backup_recovery WHERE id = ${id}`);
  } catch {
    // ignore
  }
}

export function listRecoveryRecords(): RecoveryRecord[] {
  const rows = db.all(sql`SELECT * FROM backup_recovery ORDER BY updated_at ASC`) as Array<{
    id: string;
    app_id: string;
    kind: string;
    state: string;
    updated_at: string;
  }>;
  return rows.map((r) => {
    let state: RecoveryState = {};
    try {
      state = JSON.parse(r.state) as RecoveryState;
    } catch {
      // unreadable state — treated as empty
    }
    return { id: r.id, appId: r.app_id, kind: r.kind === "restore" ? "restore" : "backup", state, updatedAt: r.updated_at };
  });
}
