import { sql } from "drizzle-orm";
import { db, schema } from "../index.js";
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

/**
 * automations.actor_token_id — the MCP token that wrote the automation. Each
 * run re-checks that token: revoked or expired blocks (and disables) the
 * automation, and the token's current grants apply, so narrowing it takes
 * effect on the next run.
 */
function ensureAutomationActorTokenColumn(): void {
  if (tableColumns("automations").size === 0) return;
  addColumnIfMissing("automations", "actor_token_id", "TEXT");
}

/** Only numeric ids are real sender ids (Telegram group chats are negative: skipped). */
const SEEDABLE_SENDER_ID = /^[0-9]{1,32}$/;

/**
 * messaging_senders — the Telegram/Discord senders the bots answer. Created
 * once; on creation it is seeded from the senders of existing bot
 * conversations, so a working single-owner setup keeps working (every sender
 * that already talked to the bot had owner-level access before). The owner is
 * told which senders were allowed and can remove them in Settings.
 */
function ensureMessagingSendersTable(): void {
  const existed = (db.all(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messaging_senders'`) as unknown[]).length > 0;
  db.run(sql`
    CREATE TABLE IF NOT EXISTS messaging_senders (
      platform TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      display_name TEXT,
      added_by TEXT,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (platform, user_id)
    )
  `);
  if (existed) return;

  // conversations may not exist on a DB this process never migrated (MCP stdio against a fresh file).
  if (tableColumns("conversations").size === 0) return;
  const rows = db.all(sql`
    SELECT DISTINCT platform, external_id AS externalId FROM conversations
    WHERE platform IN ('telegram', 'discord') AND external_id IS NOT NULL
  `) as Array<{ platform: string; externalId: string }>;
  const seeded = rows.filter((r) => SEEDABLE_SENDER_ID.test(r.externalId));
  if (seeded.length === 0) return;

  const now = new Date().toISOString();
  for (const r of seeded) {
    db.run(sql`
      INSERT OR IGNORE INTO messaging_senders (platform, user_id, status, added_by, created_at, updated_at)
      VALUES (${r.platform}, ${r.externalId}, 'allowed', 'migration', ${now}, ${now})
    `);
  }
  const list = seeded.map((r) => `${r.platform === "telegram" ? "Telegram" : "Discord"} ${r.externalId}`).join(", ");
  try {
    db.insert(schema.notifications).values({
      type: "info",
      title: "Chat bots now answer only allowed senders",
      body:
        `Telegram and Discord bots now answer only the senders you allow. ` +
        `These senders already talked to your bot and were allowed: ${list}. ` +
        `Review them in Settings -> Chat Bots.`,
      sourceId: "messaging:allowlist",
      link: "/dashboard/settings/integrations",
    }).run();
  } catch {
    // best-effort
  }
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
  ensureMessagingSendersTable();
}
