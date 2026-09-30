import { db } from "../index.js";
import { sql } from "drizzle-orm";
import { addColumnIfMissing } from "./columns.js";

/**
 * Idempotent migrations for verified, application-consistent backups.
 * Only adds tables/columns/indexes — never drops or rewrites user data.
 */

export function runBackupsMigrations(): void {
  // ── backups: method, manifest, verification ────────────────────────────
  addColumnIfMissing("backups", "method", "TEXT");
  addColumnIfMissing("backups", "manifest_path", "TEXT");
  addColumnIfMissing("backups", "archive_sha256", "TEXT");
  addColumnIfMissing("backups", "purpose", "TEXT");
  addColumnIfMissing("backups", "schedule_id", "TEXT");
  addColumnIfMissing("backups", "destination_id", "TEXT");
  addColumnIfMissing("backups", "app_version", "TEXT");
  addColumnIfMissing("backups", "warnings", "TEXT");
  addColumnIfMissing("backups", "verify_status", "TEXT");
  addColumnIfMissing("backups", "verified_at", "TEXT");
  addColumnIfMissing("backups", "verify_detail", "TEXT");

  // ── backup_schedules: destination + GFS retention ──────────────────────
  addColumnIfMissing("backup_schedules", "destination_id", "TEXT");
  addColumnIfMissing("backup_schedules", "keep_last", "INTEGER");
  addColumnIfMissing("backup_schedules", "keep_daily", "INTEGER");
  addColumnIfMissing("backup_schedules", "keep_weekly", "INTEGER");
  addColumnIfMissing("backup_schedules", "keep_monthly", "INTEGER");

  // ── New tables ─────────────────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS app_backup_configs (
    app_id TEXT PRIMARY KEY,
    method TEXT NOT NULL DEFAULT 'auto',
    exclude_patterns TEXT NOT NULL DEFAULT '[]',
    include_volumes TEXT,
    health_url TEXT,
    updated_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS backup_destinations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    target TEXT NOT NULL,
    remote_type TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS backup_restores (
    id TEXT PRIMARY KEY,
    backup_id TEXT NOT NULL,
    app_id TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT,
    safety_backup_id TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error TEXT,
    detail TEXT
  )`);

  // Pending work that must be undone if the server stops mid-operation
  // (containers stopped by a backup, directory swaps made by a restore).
  db.run(sql`CREATE TABLE IF NOT EXISTS backup_recovery (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  // ── Indexes ────────────────────────────────────────────────────────────
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_backups_app_status ON backups(app_id, status, completed_at)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_backups_schedule_id ON backups(schedule_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_backup_restores_app ON backup_restores(app_id, started_at)`);
}
