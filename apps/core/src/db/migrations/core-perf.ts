/**
 * core-perf migrations — indexes for retention pruning and hot queries.
 *
 * Idempotent: every statement is IF NOT EXISTS, safe to run on every boot.
 * No tables or columns are dropped.
 */

import { db } from "../index.js";
import { sql } from "drizzle-orm";
import { addColumnIfMissing, tableColumns } from "./columns.js";

/**
 * Early Talome builds created container_events with a `timestamp` column;
 * later code writes `created_at` (schema.ts) without ever migrating, so on
 * those databases every insert failed silently and the table stopped
 * recording. Rename the column in place (data kept). Safe to re-run and
 * tolerant of a concurrent process having renamed it first.
 */
export function repairContainerEventsTimestamp(): void {
  const cols = tableColumns("container_events");
  if (cols.size === 0 || cols.has("created_at") || !cols.has("timestamp")) return;
  try {
    db.run(sql`ALTER TABLE container_events RENAME COLUMN timestamp TO created_at`);
  } catch (err) {
    if (!tableColumns("container_events").has("created_at")) throw err;
  }
}

/**
 * install_errors gained exit_code and variables_involved after early
 * databases were created; CREATE TABLE IF NOT EXISTS never added them there,
 * so inserts that set them failed on those installs.
 */
export function repairInstallErrorsColumns(): void {
  if (tableColumns("install_errors").size === 0) return;
  addColumnIfMissing("install_errors", "exit_code", "INTEGER");
  addColumnIfMissing("install_errors", "variables_involved", "TEXT NOT NULL DEFAULT '[]'");
}

export function runCorePerfMigrations(): void {
  repairContainerEventsTimestamp();
  repairInstallErrorsColumns();

  // Retention prunes by these timestamps; without an index each daily
  // DELETE batch would full-scan the table.
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_container_events_created_at ON container_events(created_at)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_install_errors_created_at ON install_errors(created_at)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_evolution_runs_started_at ON evolution_runs(started_at)`);

  // Hot queries: evolution history is read newest-first; the worker, reaper
  // and auto-executor all look up runs by status = 'running'.
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_evolution_log_timestamp ON evolution_log(timestamp)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_evolution_runs_status ON evolution_runs(status)`);
}
