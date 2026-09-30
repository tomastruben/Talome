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
import { addColumnIfMissing } from "./columns.js";

/** Full access — what pre-grant ("legacy") tokens could already do. */
export const LEGACY_FULL_ACCESS_SCOPES = JSON.stringify({
  maxTier: "destructive",
  domains: "all",
  apps: "all",
});

const LEGACY_BACKFILL_MARKER = "mcp_tokens_legacy_scopes";

export function runTrustMigrations(): void {
  // ── MCP token grants ────────────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS mcp_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  )`);

  addColumnIfMissing("mcp_tokens", "scopes", "TEXT");
  addColumnIfMissing("mcp_tokens", "expires_at", "TEXT");
  addColumnIfMissing("mcp_tokens", "revoked_at", "TEXT");
  addColumnIfMissing("mcp_tokens", "legacy", "INTEGER NOT NULL DEFAULT 0");
  // Creator (users.id), so a deleted or demoted admin's tokens can be revoked.
  addColumnIfMissing("mcp_tokens", "created_by", "TEXT");

  // Tokens created before per-token grants existed keep full access (flagged
  // legacy so the UI can nudge the owner to narrow them). Completion is
  // tracked by a marker written in the same transaction as the backfill, so a
  // crash between adding the column and backfilling cannot leave existing
  // tokens silently read-only; once the marker exists, later rows with NULL
  // scopes (e.g. written by older code) are treated as read-only at runtime.
  db.run(sql`CREATE TABLE IF NOT EXISTS trust_migration_markers (
    name TEXT PRIMARY KEY,
    done_at TEXT NOT NULL
  )`);
  const backfilled = db.get(
    sql`SELECT name FROM trust_migration_markers WHERE name = ${LEGACY_BACKFILL_MARKER}`,
  ) as { name: string } | undefined;
  if (!backfilled) {
    db.transaction((tx) => {
      tx.run(sql`UPDATE mcp_tokens SET scopes = ${LEGACY_FULL_ACCESS_SCOPES}, legacy = 1 WHERE scopes IS NULL`);
      tx.run(
        sql`INSERT OR IGNORE INTO trust_migration_markers (name, done_at) VALUES (${LEGACY_BACKFILL_MARKER}, ${new Date().toISOString()})`,
      );
    });
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
