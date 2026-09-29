/**
 * Scheduled backups, retention and background maintenance:
 *
 *  - runScheduledBackup: back up one app for a schedule, then apply the
 *    schedule's retention policy (keep-last + GFS, or retention_days)
 *  - runBackupMaintenance (self-throttled, called every monitor tick):
 *      · recover work left pending by a restart (stopped containers,
 *        half-swapped restores) and rows left "running"
 *      · weekly verification of the newest backup of every app
 *      · alert when an app with a schedule has no successful backup for
 *        longer than max(24h, schedule interval) + 1h grace
 *      · prune old pre-update / pre-restore safety backups
 */

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { writeNotification } from "../db/notifications.js";
import { getSetting, setSetting } from "../utils/settings.js";
import { createLogger } from "../utils/logger.js";
import { maxCronIntervalMs } from "./cron.js";
import { deleteBackup } from "./engine.js";
import { runBackupOperation } from "./operation.js";
import { recoverPendingOperations } from "./recovery.js";
import { applyRetentionPolicy, hasGfsRules } from "./retention.js";
import { activeIds } from "./state.js";
import { listCompletedBackups, recoverInterruptedOperations, type BackupRow } from "./store.js";
import type { CreateAppBackupResult, RetentionPolicy } from "./types.js";
import { verifyBackup } from "./verify.js";

const log = createLogger("backup-scheduler");

export interface ScheduleRow {
  id: string;
  app_id: string | null;
  cron: string;
  cloud_target: string | null;
  retention_days: number;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
  destination_id?: string | null;
  keep_last?: number | null;
  keep_daily?: number | null;
  keep_weekly?: number | null;
  keep_monthly?: number | null;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const VERIFY_INTERVAL_MS = 7 * DAY;
const MAINTENANCE_INTERVAL_MS = HOUR;
const STALE_REMINDER_MS = DAY;
const SAFETY_KEEP_LAST = 3;
const MAX_VERIFICATIONS_PER_RUN = 2;

export function schedulePolicy(schedule: ScheduleRow): RetentionPolicy {
  const policy: RetentionPolicy = {
    keepLast: schedule.keep_last ?? null,
    keepDaily: schedule.keep_daily ?? null,
    keepWeekly: schedule.keep_weekly ?? null,
    keepMonthly: schedule.keep_monthly ?? null,
  };
  if (!hasGfsRules(policy)) policy.maxAgeDays = schedule.retention_days;
  return policy;
}

function toCandidates(rows: BackupRow[]) {
  return rows.map((r) => ({ id: r.id, createdAt: r.completed_at ?? r.started_at, verified: r.verify_status === "verified" }));
}

/** Apply a schedule's retention to the backups it created for one app. */
export async function applyScheduleRetention(schedule: ScheduleRow, appId: string, now = new Date()): Promise<string[]> {
  const rows = listCompletedBackups(appId).filter((r) => r.schedule_id === schedule.id);
  const decision = applyRetentionPolicy(toCandidates(rows), schedulePolicy(schedule), now);
  for (const id of decision.prune) {
    const r = await deleteBackup(id);
    if (!r.ok) log.warn(`retention: could not delete ${id}: ${r.error}`);
  }
  return decision.prune;
}

/** Back up one app for a schedule, notify, and apply retention on success. */
export async function runScheduledBackup(schedule: ScheduleRow, appId: string): Promise<CreateAppBackupResult> {
  // A journaled "backup" operation: never stops an app mid-update/install/restore.
  const result = await runBackupOperation(
    appId,
    {
      triggeredBy: "schedule",
      purpose: "schedule",
      scheduleId: schedule.id,
      destinationId: schedule.destination_id ?? null,
      cloudTarget: schedule.destination_id ? null : schedule.cloud_target,
    },
    { actor: `schedule:${schedule.id}` },
  );
  if (!result.success && result.conflict) {
    // Skipped, not failed: the stale-backup check alerts if it keeps happening.
    writeNotification("warning", "Backup skipped", `${appId}: ${result.error}`);
    log.warn(`Scheduled backup of ${appId} skipped: ${result.error}`);
    return result;
  }
  if (result.success) {
    const sizeMb = Math.round((result.sizeBytes / (1024 * 1024)) * 10) / 10;
    writeNotification("info", "Backup completed", `${appId} backed up successfully (${sizeMb} MB, ${result.method})`);
    try {
      await applyScheduleRetention(schedule, appId);
    } catch (err) {
      log.error(`retention failed for ${appId}`, err);
    }
  } else {
    writeNotification("warning", "Backup failed", `${appId}: ${result.error}`);
    log.error(`Scheduled backup failed for ${appId}`, result.error);
  }
  return result;
}

// ── Maintenance ─────────────────────────────────────────────────────────────

// First full maintenance pass ~10 minutes after startup (don't add IO to boot)
let lastMaintenance = Date.now() - MAINTENANCE_INTERVAL_MS + 10 * 60 * 1000;
let maintenanceRunning = false;
let recovered = false;

export function listEnabledSchedules(): ScheduleRow[] {
  return db.all(sql`SELECT * FROM backup_schedules WHERE enabled = 1`) as ScheduleRow[];
}

function installedAppIds(): string[] {
  return (db.all(sql`SELECT app_id FROM installed_apps`) as Array<{ app_id: string }>).map((r) => r.app_id);
}

export interface StaleBackupAlert {
  appId: string;
  lastSuccessAt: string | null;
  thresholdMs: number;
}

/** Apps with a schedule whose last successful backup is older than expected. */
export function findStaleBackups(now = new Date()): StaleBackupAlert[] {
  const schedules = listEnabledSchedules();
  const apps = installedAppIds();
  const thresholds = new Map<string, number>();
  const scheduleCreated = new Map<string, number>();
  for (const s of schedules) {
    const interval = maxCronIntervalMs(s.cron, now) ?? DAY;
    const threshold = Math.max(DAY, interval) + HOUR;
    const targets = s.app_id ? [s.app_id] : apps;
    for (const appId of targets) {
      if (!apps.includes(appId)) continue;
      // The most frequent schedule covering the app sets the expectation
      thresholds.set(appId, Math.min(thresholds.get(appId) ?? Infinity, threshold));
      scheduleCreated.set(appId, Math.min(scheduleCreated.get(appId) ?? Infinity, Date.parse(s.created_at) || now.getTime()));
    }
  }
  const out: StaleBackupAlert[] = [];
  for (const [appId, threshold] of thresholds) {
    const created = scheduleCreated.get(appId) ?? now.getTime();
    if (now.getTime() - created < threshold) continue; // schedule too new to judge
    const last = db.get(
      sql`SELECT completed_at FROM backups WHERE app_id = ${appId} AND status = 'completed' AND (purpose IS NULL OR purpose IN ('manual', 'schedule')) ORDER BY completed_at DESC LIMIT 1`,
    ) as { completed_at: string | null } | undefined;
    const lastAt = last?.completed_at ? Date.parse(last.completed_at) : null;
    if (lastAt === null || now.getTime() - lastAt > threshold) {
      out.push({ appId, lastSuccessAt: last?.completed_at ?? null, thresholdMs: threshold });
    }
  }
  return out;
}

/**
 * The newest manual/scheduled backup per app (the one the dashboard shows)
 * when none of the app's manual/scheduled backups was verified within a week.
 * Safety backups (pre-update, pre-restore) neither count nor reset the timer.
 */
export function findBackupsDueForVerification(now = new Date()): string[] {
  const rows = db.all(sql`
    SELECT b.id, b.app_id, b.completed_at, b.verify_status,
      (SELECT MAX(v.verified_at) FROM backups v WHERE v.app_id = b.app_id AND v.verify_status IN ('verified', 'failed')
        AND (v.purpose IS NULL OR v.purpose IN ('manual', 'schedule'))) AS last_verified
    FROM backups b
    WHERE b.status = 'completed' AND b.app_id IS NOT NULL AND b.manifest_path IS NOT NULL
      AND (b.purpose IS NULL OR b.purpose IN ('manual', 'schedule'))
      AND b.completed_at = (SELECT MAX(c.completed_at) FROM backups c WHERE c.app_id = b.app_id AND c.status = 'completed'
        AND c.manifest_path IS NOT NULL AND (c.purpose IS NULL OR c.purpose IN ('manual', 'schedule')))
  `) as Array<{ id: string; app_id: string; completed_at: string | null; verify_status: string | null; last_verified: string | null }>;
  return rows
    .filter((r) => {
      if (r.verify_status === "running") return false;
      // Give a fresh backup a few minutes (uploads, etc.) before verifying
      if (r.completed_at && now.getTime() - Date.parse(r.completed_at) < 10 * 60 * 1000) return false;
      if (!r.last_verified) return true;
      return now.getTime() - Date.parse(r.last_verified) > VERIFY_INTERVAL_MS;
    })
    .map((r) => r.id);
}

async function pruneSafetyBackups(): Promise<void> {
  const apps = db.all(sql`SELECT DISTINCT app_id FROM backups WHERE purpose IN ('pre-update', 'pre-restore') AND status = 'completed'`) as Array<{ app_id: string }>;
  for (const { app_id: appId } of apps) {
    for (const purpose of ["pre-update", "pre-restore"] as const) {
      const rows = listCompletedBackups(appId).filter((r) => r.purpose === purpose);
      const decision = applyRetentionPolicy(toCandidates(rows), { keepLast: SAFETY_KEEP_LAST });
      for (const id of decision.prune) await deleteBackup(id);
    }
  }
}

function notifyStale(alert: StaleBackupAlert): void {
  const key = `_backup_stale_notified_${alert.appId}`;
  const last = parseInt(getSetting(key) ?? "0", 10) || 0;
  if (Date.now() - last < STALE_REMINDER_MS) return;
  setSetting(key, String(Date.now()));
  const since = alert.lastSuccessAt ? `since ${alert.lastSuccessAt}` : "yet";
  writeNotification("warning", `No recent backup: ${alert.appId}`, `${alert.appId} has a backup schedule but no successful backup ${since}.`, alert.appId);
}

/** Self-throttled background maintenance. Safe to call every minute. */
export async function runBackupMaintenance(now = new Date(), force = false): Promise<void> {
  if (!recovered) {
    recovered = true;
    try {
      // Undo half-finished work first (restart stopped apps, put data back)
      await recoverPendingOperations(activeIds());
      const n = recoverInterruptedOperations(activeIds());
      if (n > 0) log.warn(`marked ${n} interrupted backup/restore operation(s) as failed`);
    } catch (err) {
      log.error("backup recovery error", err);
    }
  }
  if (maintenanceRunning) return;
  if (!force && now.getTime() - lastMaintenance < MAINTENANCE_INTERVAL_MS) return;
  maintenanceRunning = true;
  lastMaintenance = now.getTime();
  try {

    for (const alert of findStaleBackups(now)) notifyStale(alert);

    const due = findBackupsDueForVerification(now).slice(0, MAX_VERIFICATIONS_PER_RUN);
    for (const id of due) {
      const r = await verifyBackup(id);
      log.info(`weekly verification of ${id}: ${r.status}`);
    }

    await pruneSafetyBackups();
  } catch (err) {
    log.error("backup maintenance error", err);
  } finally {
    maintenanceRunning = false;
  }
}
