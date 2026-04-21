// ── Supervisor Event Log — Direct SQLite Writer ─────────────────────────────
//
// Uses better-sqlite3 directly (same pattern as terminal-daemon.ts) to avoid
// importing the full Drizzle ORM + Hono server stack. The supervisor process
// is lightweight and must not depend on core's module graph.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ProcessName, SupervisorEventType } from "./types.js";

// ── DB connection ────────────────────────────────────────────────────────────

let sqlite: Database.Database;

export function initEventLog(dbPath?: string): void {
  const path = dbPath || process.env.DATABASE_PATH || join(process.cwd(), "data", "talome.db");
  mkdirSync(join(path, ".."), { recursive: true });
  sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");

  // Ensure table exists
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS supervisor_events (
      id TEXT PRIMARY KEY,
      process TEXT NOT NULL,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning',
      exit_code INTEGER,
      signal TEXT,
      crash_log TEXT,
      diagnosis TEXT,
      action_taken TEXT,
      revert_target TEXT,
      cost_usd REAL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_supervisor_events_process ON supervisor_events(process, created_at)`);
}

export function closeEventLog(): void {
  try { sqlite?.close(); } catch { /* ignore */ }
}

// ── Event writing ────────────────────────────────────────────────────────────

interface EventDetails {
  severity?: "info" | "warning" | "critical";
  exitCode?: number | null;
  signal?: string | null;
  crashLog?: string;
  diagnosis?: string;
  actionTaken?: string;
  revertTarget?: string;
  costUsd?: number;
}

const insertEvent = () => sqlite.prepare(`
  INSERT INTO supervisor_events (id, process, event_type, severity, exit_code, signal, crash_log, diagnosis, action_taken, revert_target, cost_usd, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function logSupervisorEvent(
  process: ProcessName,
  eventType: SupervisorEventType,
  details: EventDetails = {},
): string {
  const id = `sv_${randomUUID().slice(0, 12)}`;
  try {
    insertEvent().run(
      id,
      process,
      eventType,
      details.severity ?? "warning",
      details.exitCode ?? null,
      details.signal ?? null,
      details.crashLog ?? null,
      details.diagnosis ?? null,
      details.actionTaken ?? null,
      details.revertTarget ?? null,
      details.costUsd ?? 0,
      new Date().toISOString(),
    );
  } catch (err) {
    console.error("[supervisor] Failed to log event:", err);
  }
  return id;
}

// ── Notification writing (direct SQL, same schema as core notifications) ─────

export function writeNotificationDirect(
  type: "info" | "warning" | "critical",
  title: string,
  body = "",
  sourceId = "supervisor",
): void {
  try {
    // Dedup: skip if identical title in last 30 minutes
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const existing = sqlite.prepare(
      "SELECT id FROM notifications WHERE title = ? AND created_at >= ? LIMIT 1",
    ).get(title, cutoff);
    if (existing) return;

    sqlite.prepare(
      "INSERT INTO notifications (type, title, body, source_id, read, created_at) VALUES (?, ?, ?, ?, 0, ?)",
    ).run(type, title, body, sourceId, new Date().toISOString());
  } catch {
    // Non-fatal — notification table may not exist yet on first boot
  }
}

// ── Query helpers ────────────────────────────────────────────────────────────

export function getRecentEvents(processName?: ProcessName, limit = 50): unknown[] {
  try {
    if (processName) {
      return sqlite.prepare(
        "SELECT * FROM supervisor_events WHERE process = ? ORDER BY created_at DESC LIMIT ?",
      ).all(processName, limit);
    }
    return sqlite.prepare(
      "SELECT * FROM supervisor_events ORDER BY created_at DESC LIMIT ?",
    ).all(limit);
  } catch {
    return [];
  }
}

export function getDiagnosisCountToday(processName?: ProcessName): number {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const since = todayStart.toISOString();

  try {
    if (processName) {
      const row = sqlite.prepare(
        "SELECT COUNT(*) as cnt FROM supervisor_events WHERE event_type = 'diagnosis' AND process = ? AND created_at >= ?",
      ).get(processName, since) as { cnt: number };
      return row.cnt;
    }
    const row = sqlite.prepare(
      "SELECT COUNT(*) as cnt FROM supervisor_events WHERE event_type = 'diagnosis' AND created_at >= ?",
    ).get(since) as { cnt: number };
    return row.cnt;
  } catch {
    return 0;
  }
}

export function findRecentEvolutionRun(withinMs = 30 * 60 * 1000): { id: string; task: string; stashMessage?: string } | null {
  const since = new Date(Date.now() - withinMs).toISOString();
  try {
    const row = sqlite.prepare(
      `SELECT id, task FROM evolution_runs
       WHERE status = 'applied' AND completed_at >= ?
       ORDER BY completed_at DESC LIMIT 1`,
    ).get(since) as { id: string; task: string } | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

export function markEvolutionRunRolledBack(runId: string): void {
  try {
    sqlite.prepare(
      "UPDATE evolution_runs SET status = 'rolled_back', rolled_back = 1 WHERE id = ?",
    ).run(runId);
  } catch {
    // Non-fatal
  }
}

/** Prune old supervisor events (keep last 500) */
export function pruneOldEvents(): void {
  try {
    sqlite.prepare(`
      DELETE FROM supervisor_events
      WHERE id NOT IN (SELECT id FROM supervisor_events ORDER BY created_at DESC LIMIT 500)
    `).run();
  } catch {
    // Non-fatal
  }
}
