import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import type { UIMessage } from "ai";

// A throwaway database for this file (db/index.js creates the directory).
// Must be set before db/index.js loads, hence vi.hoisted.
const { tempDir } = vi.hoisted(() => {
  const dir = `${process.cwd()}/data/test-ai-chat-${process.pid}-${Date.now()}`;
  process.env.DATABASE_PATH = `${dir}/talome.db`;
  return { tempDir: dir };
});

import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { runAiChatMigrations } from "../db/migrations/ai-chat.js";

let routing: typeof import("../ai/tool-discovery.js");

function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

beforeAll(async () => {
  runMigrations();
  await import("../ai/agent.js"); // registers the tool domains
  routing = await import("../ai/tool-discovery.js");
});

afterAll(() => {
  delete process.env.DATABASE_PATH;
  try {
    db.$client.close();
  } catch {
    // already closed
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("conversation_tool_domains", () => {
  it("migration is idempotent and records its version", () => {
    expect(() => runAiChatMigrations()).not.toThrow();
    expect(() => runMigrations()).not.toThrow();
    const version = db.$client.prepare("SELECT version FROM schema_versions WHERE version = 106").get();
    expect(version).toEqual({ version: 106 });
  });

  it("keeps discover_tools activations across a restart for plain-text histories", async () => {
    const key = "c:telegram-thread-1";
    const history = [userMessage("m1", "can you help me with something?")];
    const session = routing.createToolRoutingSession({ conversationKey: key, messages: history });
    expect(session.toolNames()).not.toContain("create_automation");

    const discover = routing.createDiscoverToolsTool(session);
    const execute = discover.execute as (args: unknown, opts: unknown) => Promise<Record<string, unknown>>;
    const result = await execute({ domain: "automations" }, { toolCallId: "t1", messages: [] });
    expect(result.activatedDomains).toEqual(["automations"]);

    const row = db.select().from(schema.conversationToolDomains).all().find((r) => r.conversationKey === key);
    expect(row && JSON.parse(row.domains)).toContain("automations");

    // Simulated restart: in-memory state is gone, the history is plain text.
    routing.resetToolRoutingState();
    const resumed = routing.createToolRoutingSession({
      conversationKey: key,
      messages: [...history, { id: "m2", role: "assistant", parts: [{ type: "text", text: "Sure." }] }, userMessage("m3", "ok, do it")],
    });
    expect(resumed.toolNames()).toContain("create_automation");

    // Other conversations are unaffected.
    const other = routing.createToolRoutingSession({ conversationKey: "c:other", messages: [userMessage("x", "hi")] });
    expect(other.toolNames()).not.toContain("create_automation");
  });
});
