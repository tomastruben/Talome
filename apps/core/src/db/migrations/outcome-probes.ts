import { sql } from "drizzle-orm";
import { db } from "../index.js";

/**
 * Outcome verification tables. Idempotent — safe to run on every boot and
 * never drops or rewrites existing data.
 */
export function runOutcomeProbesMigrations(): void {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS verification_results (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      result_json TEXT NOT NULL,
      include_active INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      verified_at TEXT NOT NULL
    )
  `);

  // Guarded column additions for tables created by earlier builds of this feature.
  const columns = new Set(
    (db.all(sql`PRAGMA table_info(verification_results)`) as Array<{ name: string }>).map((c) => c.name),
  );
  if (!columns.has("summary")) db.run(sql`ALTER TABLE verification_results ADD COLUMN summary TEXT NOT NULL DEFAULT ''`);
  if (!columns.has("include_active")) db.run(sql`ALTER TABLE verification_results ADD COLUMN include_active INTEGER NOT NULL DEFAULT 0`);
  if (!columns.has("duration_ms")) db.run(sql`ALTER TABLE verification_results ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0`);

  db.run(sql`CREATE INDEX IF NOT EXISTS idx_verification_results_target ON verification_results(target_type, target_id, verified_at)`);
}
