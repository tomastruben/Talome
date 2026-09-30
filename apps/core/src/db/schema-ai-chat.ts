import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";

/**
 * Chat tool routing: the non-base tool domains a conversation has loaded
 * (keywords, prior tool use, discover_tools). Keyed by the routing key from
 * ai/tool-discovery.ts (`c:<conversation id>` or `m:<first message id>`).
 * `domains` is a JSON array of domain names; the set only grows.
 */
export const conversationToolDomains = sqliteTable(
  "conversation_tool_domains",
  {
    conversationKey: text("conversation_key").primaryKey(),
    domains: text("domains").notNull().default("[]"),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index("idx_conversation_tool_domains_updated_at").on(table.updatedAt)],
);
