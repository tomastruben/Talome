/**
 * Trust migrations — per-token MCP grants, server-issued approvals, and
 * actor-aware audit columns.
 *
 * Every statement is idempotent (CREATE ... IF NOT EXISTS, ALTER TABLE guarded
 * by PRAGMA table_info) so this can run on every boot, and also from the MCP
 * stdio process, which may start before the main server has migrated.
 * Nothing is dropped: existing tokens and audit rows are preserved.
 */

import { sql } from "drizzle-orm";
import { db } from "../index.js";

/** Full access — what pre-grant ("legacy") tokens could already do. */
export const LEGACY_FULL_ACCESS_SCOPES = JSON.stringify({
  maxTier: "destructive",
  domains: "all",
  apps: "all",
});

function columnNames(table: string): Set<string> {
  const rows = db.all(sql.raw(`PRAGMA table_info(${table})`)) as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function addColumnIfMissing(table: string, column: string, ddl: string): boolean {
  if (columnNames(table).has(column)) return false;
  try {
    db.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`));
    return true;
  } catch (err) {
    // Another process (main server vs. MCP stdio) may have won the race.
    if (err instanceof Error && /duplicate column/i.test(err.message)) return false;
    throw err;
  }
}

export function runTrustMigrations(): void {
  // ── MCP token grants ────────────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS mcp_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  )`);

  const addedScopes = addColumnIfMissing("mcp_tokens", "scopes", "TEXT");
  addColumnIfMissing("mcp_tokens", "expires_at", "TEXT");
  addColumnIfMissing("mcp_tokens", "revoked_at", "TEXT");
  addColumnIfMissing("mcp_tokens", "legacy", "INTEGER NOT NULL DEFAULT 0");

  // Tokens created before per-token grants existed keep full access (flagged
  // legacy so the UI can nudge the owner to narrow them). This backfill only
  // runs in the same boot that adds the column — later rows with NULL scopes
  // (e.g. written by older code) are treated as read-only at runtime.
  if (addedScopes) {
    db.run(sql`UPDATE mcp_tokens SET scopes = ${LEGACY_FULL_ACCESS_SCOPES}, legacy = 1 WHERE scopes IS NULL`);
  }

  db.run(sql`CREATE INDEX IF NOT EXISTS idx_mcp_tokens_hash ON mcp_tokens(token_hash)`);

  // ── Approvals ───────────────────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_label TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    tool TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    args_preview TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_by TEXT,
    decided_at TEXT,
    consumed_at TEXT
  )`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_approvals_actor ON approvals(actor_kind, actor_id)`);

  // ── Audit log: actor, source, outcome, duration ─────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    action TEXT NOT NULL,
    tier TEXT NOT NULL,
    approved INTEGER NOT NULL DEFAULT 1,
    details TEXT NOT NULL DEFAULT ''
  )`);
  addColumnIfMissing("audit_log", "actor_kind", "TEXT");
  addColumnIfMissing("audit_log", "actor_id", "TEXT");
  addColumnIfMissing("audit_log", "actor_label", "TEXT");
  addColumnIfMissing("audit_log", "source", "TEXT");
  addColumnIfMissing("audit_log", "tool_name", "TEXT");
  addColumnIfMissing("audit_log", "outcome", "TEXT");
  addColumnIfMissing("audit_log", "duration_ms", "INTEGER");
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_kind, actor_id)`);
}
