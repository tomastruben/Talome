import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { join, dirname } from "node:path";
import { mkdirSync, existsSync, renameSync } from "node:fs";
import * as schema from "./schema.js";

const dbPath = process.env.DATABASE_PATH || join(process.cwd(), "data", "talome.db");
mkdirSync(dirname(dbPath), { recursive: true });

// ── Legacy migration: talon.db → talome.db ──────────────────────────────────
// If the old DB file exists and the new one doesn't, rename it (+ WAL/SHM).
const legacyDbPath = dbPath.replace(/talome\.db$/, "talon.db");
if (legacyDbPath !== dbPath && existsSync(legacyDbPath) && !existsSync(dbPath)) {
  try {
    renameSync(legacyDbPath, dbPath);
    // Also move WAL and SHM journal files if present
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(legacyDbPath + ext)) {
        renameSync(legacyDbPath + ext, dbPath + ext);
      }
    }
    console.log(`[migration] Renamed ${legacyDbPath} → ${dbPath}`);
  } catch (err) {
    console.error(`[migration] Failed to rename legacy DB:`, err);
  }
}

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 30000");
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("cache_size = -64000"); // 64MB
sqlite.pragma("temp_store = MEMORY");

export const db = drizzle(sqlite, { schema });
export { schema };
