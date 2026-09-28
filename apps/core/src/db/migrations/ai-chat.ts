import { sql } from "drizzle-orm";
import { db } from "../index.js";

/**
 * Idempotent migrations for the ai-chat workstream. Safe to run on every boot:
 * only creates what is missing and never drops or rewrites existing data.
 */
export function runAiChatMigrations(): void {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS conversation_tool_domains (
      conversation_key TEXT PRIMARY KEY,
      domains TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    )
  `);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_conversation_tool_domains_updated_at ON conversation_tool_domains(updated_at)`);
}
