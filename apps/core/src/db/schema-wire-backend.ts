import { sqliteTable, text, index, integer, primaryKey } from "drizzle-orm/sqlite-core";

/**
 * Remediation escalations: an agent-loop remediation that stopped at a call
 * needing the owner's approval. Persisted (not in memory) so the hold on the
 * source survives restarts, and so an owner approval can run the exact call
 * the agent proposed (`args`, verified against the approval's args hash)
 * without waiting for a new event. Migration: db/migrations/wire-backend.ts.
 */
export const remediationEscalations = sqliteTable(
  "remediation_escalations",
  {
    approvalId: text("approval_id").primaryKey(),
    source: text("source").notNull(),
    eventId: text("event_id").notNull(),
    tool: text("tool").notNull(),
    /** JSON of the exact call arguments, when known (null: the call can only be re-proposed by a later run). */
    args: text("args"),
    /** open | resumed | closed */
    status: text("status").notNull().default("open"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    resolvedAt: text("resolved_at"),
  },
  (table) => [index("idx_remediation_escalations_source").on(table.source, table.createdAt)],
);

/**
 * Messaging senders (Telegram / Discord user ids). The bots answer only
 * senders the owner allowed; every other sender is rejected and recorded
 * here as "rejected" so the owner can allow them from Settings ->
 * Integrations. Kept out of the settings table on purpose: set_setting (a
 * modify-tier tool) must not be able to add a sender. Migration:
 * db/migrations/wire-backend.ts (seeded once from existing bot conversations).
 */
export const messagingSenders = sqliteTable(
  "messaging_senders",
  {
    /** telegram | discord */
    platform: text("platform").notNull(),
    /** Telegram user id / Discord user id (digits). */
    userId: text("user_id").notNull(),
    /** allowed | rejected */
    status: text("status").notNull(),
    displayName: text("display_name"),
    /** owner | migration | rejected (how the row was created) */
    addedBy: text("added_by"),
    rejectedCount: integer("rejected_count").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [primaryKey({ columns: [table.platform, table.userId] })],
);
