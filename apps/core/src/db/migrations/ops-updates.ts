import { sql } from "drizzle-orm";
import { db } from "../index.js";

// ── ops-updates migrations ───────────────────────────────────────────────────
// Idempotent: safe to run on every boot. Never drops tables or columns.

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function hasColumn(table: string, column: string): boolean {
  if (!IDENTIFIER.test(table)) throw new Error(`Invalid table name: ${table}`);
  const rows = db.all(sql.raw(`PRAGMA table_info(${table})`)) as { name: string }[];
  return rows.some((r) => r.name === column);
}

function addColumnIfMissing(table: string, column: string, ddl: string): void {
  if (!IDENTIFIER.test(column)) throw new Error(`Invalid column name: ${column}`);
  if (hasColumn(table, column)) return;
  db.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`));
}

export function runOpsUpdatesMigrations(): void {
  // ── Durable app operations journal ─────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS app_operations (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'system',
    status TEXT NOT NULL DEFAULT 'queued',
    step TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    detail TEXT,
    error TEXT,
    idempotency_key TEXT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    heartbeat_at TEXT,
    finished_at TEXT
  )`);
  addColumnIfMissing("app_operations", "owner_pid", "INTEGER");
  addColumnIfMissing("app_operations", "owner_host", "TEXT");
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_app_operations_app_started ON app_operations(app_id, started_at)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_app_operations_status ON app_operations(status)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_app_operations_idempotency ON app_operations(idempotency_key)`);

  db.run(sql`CREATE TABLE IF NOT EXISTS app_operation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL,
    app_id TEXT NOT NULL,
    status TEXT NOT NULL,
    step TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    message TEXT,
    created_at TEXT NOT NULL
  )`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_app_operation_events_operation ON app_operation_events(operation_id, id)`);

  // ── Update snapshots: full rollback state ──────────────────────────────
  addColumnIfMissing("update_snapshots", "previous_env", "TEXT");
  addColumnIfMissing("update_snapshots", "previous_images", "TEXT");
  addColumnIfMissing("update_snapshots", "operation_id", "TEXT");
  addColumnIfMissing("update_snapshots", "backup_path", "TEXT");
  addColumnIfMissing("update_snapshots", "rollback_reason", "TEXT");

  // ── Automation run durability ──────────────────────────────────────────
  addColumnIfMissing("automation_runs", "status", "TEXT");
  addColumnIfMissing("automation_runs", "finished_at", "TEXT");
  db.run(sql`UPDATE automation_runs SET status = CASE WHEN success = 1 THEN 'succeeded' ELSE 'failed' END WHERE status IS NULL`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs(status)`);

  addColumnIfMissing("automation_step_runs", "status", "TEXT");
  addColumnIfMissing("automation_step_runs", "step_index", "INTEGER");
  addColumnIfMissing("automation_step_runs", "idempotency_key", "TEXT");
  addColumnIfMissing("automation_step_runs", "finished_at", "TEXT");
  db.run(sql`UPDATE automation_step_runs SET status = CASE WHEN blocked = 1 THEN 'blocked' WHEN success = 1 THEN 'succeeded' ELSE 'failed' END WHERE status IS NULL`);
  db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_step_runs_idempotency ON automation_step_runs(idempotency_key) WHERE idempotency_key IS NOT NULL`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_automation_step_runs_run ON automation_step_runs(run_id)`);
}
