import { sql } from "drizzle-orm";
import { db } from "../index.js";

function hasColumn(table: string, column: string): boolean {
  const rows = db.all(sql.raw(`PRAGMA table_info(${table})`)) as { name: string }[];
  return rows.some((row) => row.name === column);
}

function addColumnIfMissing(table: string, column: string, definition: string): void {
  if (hasColumn(table, column)) return;
  db.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`));
}

/**
 * Store-compat schema changes (Umbrel 2.0 manifests + cheap catalog sync).
 * Idempotent and additive only — safe to run on every boot.
 */
export function runStoreCompatMigrations(): void {
  // Umbrel 2.0 manifest metadata (folderAccess, environment, storage, …)
  addColumnIfMissing("app_catalog", "umbrel_meta", "TEXT");

  // git HEAD + parser version of the last parse — lets sync skip re-parsing
  addColumnIfMissing("store_sources", "last_parsed_rev", "TEXT");

  db.run(sql`CREATE TABLE IF NOT EXISTS app_install_options (
    app_id TEXT PRIMARY KEY,
    store_source_id TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '{}',
    plan TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  )`);

  // Catalog rewrites and per-store listing filter on store_source_id
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_app_catalog_store_source ON app_catalog(store_source_id)`);
}
