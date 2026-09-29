import { sql } from "drizzle-orm";
import { db } from "../index.js";

function columnsOf(table: string): Set<string> {
  return new Set((db.all(sql.raw(`PRAGMA table_info(${table})`)) as Array<{ name: string }>).map((c) => c.name));
}

/**
 * notifications.link — a first-class, optional in-app link (e.g. the approval
 * a notification asks the owner to review). Idempotent: safe on every boot and
 * from processes that never run the full migration set (MCP stdio).
 */
export function ensureNotificationLinkColumn(): void {
  const columns = columnsOf("notifications");
  // Table not created yet (fresh DB mid-migration): the base migration creates it first.
  if (columns.size === 0) return;
  if (!columns.has("link")) db.run(sql`ALTER TABLE notifications ADD COLUMN link TEXT`);
}

/**
 * automations.actor_scopes — the grants an automation written by an MCP token
 * runs under (JSON TokenScopes). NULL = owner-level (dashboard, local stdio).
 */
function ensureAutomationActorScopesColumn(): void {
  const columns = columnsOf("automations");
  if (columns.size === 0) return;
  if (!columns.has("actor_scopes")) db.run(sql`ALTER TABLE automations ADD COLUMN actor_scopes TEXT`);
}

/**
 * automations.actor_token_id — the MCP token that wrote the automation. Each
 * run re-checks that token: revoked or expired blocks (and disables) the
 * automation, and the token's current grants apply, so narrowing it takes
 * effect on the next run.
 */
function ensureAutomationActorTokenColumn(): void {
  const columns = columnsOf("automations");
  if (columns.size === 0) return;
  if (!columns.has("actor_token_id")) db.run(sql`ALTER TABLE automations ADD COLUMN actor_token_id TEXT`);
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
  ensureAutomationActorTokenColumn();
  ensureRemediationEscalationsTable();
}
