import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// ── Durable app operations journal ───────────────────────────────────────────
// One row per lifecycle operation (install/update/start/…) on an app. The row
// is written BEFORE any work starts and updated at every step transition, so
// a crash or restart never leaves an operation silently "lost".

export const appOperations = sqliteTable("app_operations", {
  id: text("id").primaryKey(),
  appId: text("app_id").notNull(),
  /** install | update | uninstall | start | stop | restart | rollback | backup | restore | configure */
  kind: text("kind").notNull(),
  /** Who asked for it: "user:<id>", "assistant", "automation:<id>", "agent-loop", "system" */
  actor: text("actor").notNull().default("system"),
  /** queued | running | succeeded | failed | rolled_back | interrupted */
  status: text("status").notNull().default("queued"),
  step: text("step"),
  progress: integer("progress").notNull().default(0),
  /** JSON object with structured detail (snapshot id, backup, verification, reconcile findings…) */
  detail: text("detail"),
  error: text("error"),
  idempotencyKey: text("idempotency_key"),
  startedAt: text("started_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  heartbeatAt: text("heartbeat_at"),
  finishedAt: text("finished_at"),
  /** PID of the Talome process running it (server or MCP stdio) — for cross-process locking/recovery */
  ownerPid: integer("owner_pid"),
});

/** Ordered step/progress history for an operation (one row per transition). */
export const appOperationEvents = sqliteTable("app_operation_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  operationId: text("operation_id").notNull(),
  appId: text("app_id").notNull(),
  status: text("status").notNull(),
  step: text("step"),
  progress: integer("progress").notNull().default(0),
  message: text("message"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});
