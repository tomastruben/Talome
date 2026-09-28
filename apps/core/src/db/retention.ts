/**
 * Data retention — keeps append-only log/event tables from growing forever.
 *
 * Runs daily (first pass a few minutes after boot, so startup stays fast)
 * and deletes old rows in small batches, yielding to the event loop between
 * batches so API requests are never stuck behind one long DELETE.
 *
 * Every window is configurable through settings (value in days, or a row
 * count for evolution runs). Minimums protect features that read these
 * tables: the AI cost page and budget caps aggregate ai_usage_log over the
 * last 30 days, so it is never pruned below 31 days.
 */

import type Database from "better-sqlite3";
import { db } from "./index.js";
import { getSetting } from "../utils/settings.js";
import { yieldToEventLoop } from "../platform/concurrency.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("retention");

export const RETENTION_BATCH_SIZE = 1000;
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionConfig {
  auditLogDays: number;
  systemEventsDays: number;
  containerEventsDays: number;
  remediationLogDays: number;
  aiUsageLogDays: number;
  installErrorsDays: number;
  readNotificationsDays: number;
  /** 0 keeps unread notifications forever. */
  unreadNotificationsDays: number;
  /** Most recent evolution runs to keep (running ones are never deleted). */
  evolutionRunsKeep: number;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  auditLogDays: 90,
  systemEventsDays: 90,
  containerEventsDays: 90,
  remediationLogDays: 90,
  aiUsageLogDays: 90,
  installErrorsDays: 90,
  readNotificationsDays: 30,
  unreadNotificationsDays: 0,
  evolutionRunsKeep: 200,
};

/** Settings keys that override each default. */
export const RETENTION_SETTING_KEYS: Record<keyof RetentionConfig, string> = {
  auditLogDays: "retention_audit_log_days",
  systemEventsDays: "retention_system_events_days",
  containerEventsDays: "retention_container_events_days",
  remediationLogDays: "retention_remediation_log_days",
  aiUsageLogDays: "retention_ai_usage_log_days",
  installErrorsDays: "retention_install_errors_days",
  readNotificationsDays: "retention_notifications_read_days",
  unreadNotificationsDays: "retention_notifications_unread_days",
  evolutionRunsKeep: "retention_evolution_runs_keep",
};

/** Lower bounds so a typo can't wipe data a feature depends on. 0 = "disabled" where allowed. */
const MINIMUMS: Record<keyof RetentionConfig, number> = {
  auditLogDays: 1,
  systemEventsDays: 1,
  containerEventsDays: 1,
  remediationLogDays: 1,
  // Budget caps + the AI cost page aggregate up to 30 days back.
  aiUsageLogDays: 31,
  installErrorsDays: 1,
  readNotificationsDays: 1,
  unreadNotificationsDays: 0,
  evolutionRunsKeep: 10,
};

/** Resolve the effective config from settings, falling back to defaults. */
export function resolveRetentionConfig(read: (key: string) => string | undefined = getSetting): RetentionConfig {
  const config = { ...DEFAULT_RETENTION };
  for (const key of Object.keys(RETENTION_SETTING_KEYS) as Array<keyof RetentionConfig>) {
    const raw = read(RETENTION_SETTING_KEYS[key]);
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) continue;
    const floor = MINIMUMS[key];
    // 0 means "keep forever" only where the minimum allows it.
    config[key] = value === 0 && floor === 0 ? 0 : Math.max(floor, Math.floor(value));
  }
  return config;
}

/** Tables and timestamp columns pruned by age. Fixed allowlist — never user input. */
interface AgeRule {
  table: string;
  column: string;
  days: (c: RetentionConfig) => number;
  /** Extra SQL predicate (constant, no parameters). */
  where?: string;
  label: string;
}

const AGE_RULES: AgeRule[] = [
  { label: "audit_log", table: "audit_log", column: "timestamp", days: (c) => c.auditLogDays },
  { label: "system_events", table: "system_events", column: "created_at", days: (c) => c.systemEventsDays },
  { label: "container_events", table: "container_events", column: "created_at", days: (c) => c.containerEventsDays },
  { label: "remediation_log", table: "remediation_log", column: "created_at", days: (c) => c.remediationLogDays },
  { label: "ai_usage_log", table: "ai_usage_log", column: "created_at", days: (c) => c.aiUsageLogDays },
  { label: "install_errors", table: "install_errors", column: "created_at", days: (c) => c.installErrorsDays },
  { label: "notifications_read", table: "notifications", column: "created_at", where: "read = 1", days: (c) => c.readNotificationsDays },
  { label: "notifications_unread", table: "notifications", column: "created_at", where: "read = 0", days: (c) => c.unreadNotificationsDays },
];

function tableExists(sqlite: Database.Database, table: string): boolean {
  const row = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return row !== undefined;
}

/**
 * Delete rows matching `predicate` (with `params`) in batches of `batchSize`,
 * yielding to the event loop between batches. Returns rows deleted.
 */
export async function deleteInBatches(
  sqlite: Database.Database,
  table: string,
  predicate: string,
  params: unknown[],
  batchSize = RETENTION_BATCH_SIZE,
): Promise<number> {
  const stmt = sqlite.prepare(
    `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${predicate} LIMIT ?)`,
  );
  let total = 0;
  for (;;) {
    const { changes } = stmt.run(...params, batchSize);
    total += changes;
    if (changes < batchSize) break;
    await yieldToEventLoop();
  }
  return total;
}

async function pruneEvolutionRuns(sqlite: Database.Database, keep: number, batchSize: number): Promise<number> {
  // started_at of the Nth newest run; everything strictly older goes
  // (except runs still marked running — the worker owns those rows).
  const boundary = sqlite
    .prepare("SELECT started_at AS startedAt FROM evolution_runs ORDER BY started_at DESC LIMIT 1 OFFSET ?")
    .get(keep - 1) as { startedAt: string } | undefined;
  if (!boundary) return 0;
  return deleteInBatches(sqlite, "evolution_runs", "started_at < ? AND status != 'running'", [boundary.startedAt], batchSize);
}

export interface RetentionResult {
  deleted: Record<string, number>;
  errors: Record<string, string>;
}

export interface RunRetentionOptions {
  sqlite?: Database.Database;
  config?: RetentionConfig;
  now?: number;
  batchSize?: number;
}

/** Run one retention pass. Never throws; per-table failures are reported. */
export async function runRetention(opts: RunRetentionOptions = {}): Promise<RetentionResult> {
  const sqlite = opts.sqlite ?? (db.$client as Database.Database);
  const config = opts.config ?? resolveRetentionConfig();
  const now = opts.now ?? Date.now();
  const batchSize = opts.batchSize ?? RETENTION_BATCH_SIZE;
  const result: RetentionResult = { deleted: {}, errors: {} };

  for (const rule of AGE_RULES) {
    const days = rule.days(config);
    if (days <= 0) continue;
    try {
      if (!tableExists(sqlite, rule.table)) continue;
      const cutoff = new Date(now - days * DAY_MS).toISOString();
      const predicate = `${rule.column} < ?${rule.where ? ` AND ${rule.where}` : ""}`;
      const n = await deleteInBatches(sqlite, rule.table, predicate, [cutoff], batchSize);
      if (n > 0) result.deleted[rule.label] = n;
    } catch (err) {
      result.errors[rule.label] = err instanceof Error ? err.message : String(err);
    }
    await yieldToEventLoop();
  }

  try {
    if (config.evolutionRunsKeep > 0 && tableExists(sqlite, "evolution_runs")) {
      const n = await pruneEvolutionRuns(sqlite, config.evolutionRunsKeep, batchSize);
      if (n > 0) result.deleted.evolution_runs = n;
    }
  } catch (err) {
    result.errors.evolution_runs = err instanceof Error ? err.message : String(err);
  }

  return result;
}

let running = false;

async function runScheduledRetention(): Promise<void> {
  if (running) return;
  if (getSetting("retention_enabled") === "false") return;
  running = true;
  try {
    const { deleted, errors } = await runRetention();
    const total = Object.values(deleted).reduce((a, b) => a + b, 0);
    if (total > 0) {
      log.info(`Pruned ${total} old rows`, deleted);
    }
    if (Object.keys(errors).length > 0) {
      log.warn("Retention pass had errors", errors);
    }
  } catch (err) {
    log.warn("Retention pass failed", err);
  } finally {
    running = false;
  }
}

/**
 * Schedule the daily retention pass. First run is delayed so boot stays
 * fast; timers are unref'd so they never keep the process alive.
 */
export function startRetentionScheduler(
  firstDelayMs = FIRST_RUN_DELAY_MS,
  intervalMs = RUN_INTERVAL_MS,
): () => void {
  let interval: ReturnType<typeof setInterval> | null = null;
  const first = setTimeout(() => {
    void runScheduledRetention();
    interval = setInterval(() => void runScheduledRetention(), intervalMs);
    interval.unref?.();
  }, firstDelayMs);
  first.unref?.();

  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
