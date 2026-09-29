import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";

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
