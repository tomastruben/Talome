import { sql } from "drizzle-orm";
import { db } from "../index.js";
import { addColumnIfMissing, tableColumns } from "./columns.js";

/**
 * notifications.link — a first-class, optional in-app link (e.g. the approval
 * a notification asks the owner to review). Idempotent: safe on every boot and
 * from processes that never run the full migration set (MCP stdio).
 */
export function ensureNotificationLinkColumn(): void {
  // Table not created yet (fresh DB mid-migration): the base migration creates it first.
  if (tableColumns("notifications").size === 0) return;
  addColumnIfMissing("notifications", "link", "TEXT");
}

/**
 * automations.actor_scopes — the grants an automation written by an MCP token
 * runs under (JSON TokenScopes). NULL = owner-level (dashboard, local stdio).
 */
function ensureAutomationActorScopesColumn(): void {
  if (tableColumns("automations").size === 0) return;
  addColumnIfMissing("automations", "actor_scopes", "TEXT");
}

/** remediation_escalations — persisted agent-loop escalations awaiting the owner. */
function ensureRemediationEscalationsTable(): void {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS remediation_escalations (
      approval_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      event_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      args TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_remediation_escalations_source ON remediation_escalations(source, created_at)`);
}

/** wire-backend migrations. Idempotent — never drops or rewrites existing data. */
export function runWireBackendMigrations(): void {
  ensureNotificationLinkColumn();
  ensureAutomationActorScopesColumn();
  ensureRemediationEscalationsTable();
}
