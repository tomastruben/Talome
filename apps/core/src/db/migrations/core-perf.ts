/**
 * core-perf migrations — indexes for retention pruning and hot queries.
 *
 * Idempotent: every statement is IF NOT EXISTS, safe to run on every boot.
 * No tables or columns are dropped.
 */

import { db } from "../index.js";
import { sql } from "drizzle-orm";

export function runCorePerfMigrations(): void {
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
