import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";

/**
 * Server-issued approvals for destructive tool calls (cautious security mode).
 *
 * An agent never approves its own request: a pending row is created by the
 * execution service (ai/execution.ts) and can only be moved to "approved" or
 * "denied" by an authenticated admin session via /api/approvals. The agent
 * then retries with `approval_id`, which is consumed atomically (single use).
 *
 * Migration: db/migrations/trust.ts
 */
export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    actorLabel: text("actor_label").notNull().default(""),
    source: text("source").notNull().default(""),
    tool: text("tool").notNull(),
    /** sha256 of the canonicalized (sorted-key) args, excluding reserved keys */
    argsHash: text("args_hash").notNull(),
    /** Redacted, truncated args preview for the reviewer */
    argsPreview: text("args_preview").notNull().default(""),
    summary: text("summary").notNull(),
    status: text("status", {
      enum: ["pending", "approved", "denied", "consumed", "expired"],
    })
      .notNull()
      .default("pending"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: text("decided_at"),
    consumedAt: text("consumed_at"),
  },
  (t) => [
    index("idx_approvals_status").on(t.status),
    index("idx_approvals_actor").on(t.actorKind, t.actorId),
  ],
);
