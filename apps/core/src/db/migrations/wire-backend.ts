import { sql } from "drizzle-orm";
import { db } from "../index.js";

/**
 * notifications.link — a first-class, optional in-app link (e.g. the approval
 * a notification asks the owner to review). Idempotent: safe on every boot and
 * from processes that never run the full migration set (MCP stdio).
 */
export function ensureNotificationLinkColumn(): void {
  const columns = new Set(
    (db.all(sql`PRAGMA table_info(notifications)`) as Array<{ name: string }>).map((c) => c.name),
  );
  // Table not created yet (fresh DB mid-migration): the base migration creates it first.
  if (columns.size === 0) return;
  if (!columns.has("link")) db.run(sql`ALTER TABLE notifications ADD COLUMN link TEXT`);
}

/** wire-backend migrations. Idempotent — never drops or rewrites existing data. */
export function runWireBackendMigrations(): void {
  ensureNotificationLinkColumn();
}
