/**
 * E2E bug 8: audit rows for settings changes and tool-internal writes had no
 * actor (NULL actor_kind/actor_id/actor_label/source/outcome), and MCP-driven
 * tool-internal rows were labelled "AI: ..." with nothing saying an MCP token
 * made the call. The actor/source columns now say who acted; the action text
 * is left as written (the dashboard humanizes "AI: <tool>" rows).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

vi.hoisted(() => {
  const dir = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  process.env.DATABASE_PATH = `${dir}/talome-audit-attribution-${process.pid}-${Date.now()}.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
});

vi.mock("../ai/agent.js", () => ({ DEFAULT_SYSTEM_PROMPT: "test prompt", getActiveDomainTools: () => ({}) }));
vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

import { Hono } from "hono";
import { tool } from "ai";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { writeAuditEntry } from "../db/audit.js";
import { runInActorContext, type Actor } from "../ai/actor-context.js";
import { executeTool } from "../ai/execution.js";
import { requireSession, createSessionToken, SESSION_COOKIE } from "../middleware/session.js";
import { settings } from "../routes/settings.js";
import { setSetting } from "../utils/settings.js";

const TOKEN_ACTOR: Actor = {
  kind: "mcp_token",
  id: "tok-audit",
  label: 'MCP token "Cursor"',
  scopes: { maxTier: "destructive", domains: "all", apps: "all" },
};

function lastRow(action: string) {
  return db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action)).orderBy(desc(schema.auditLog.id)).get();
}

beforeAll(() => {
  runMigrations();
  setSetting("security_mode", "permissive");
});

describe("writeAuditEntry attribution defaults", () => {
  it("takes the actor from the execution context when the caller passes none", () => {
    runInActorContext(TOKEN_ACTOR, "mcp", () => writeAuditEntry("Restarted", "modify", "container-1"));
    expect(lastRow("Restarted")).toMatchObject({
      actorKind: "mcp_token",
      actorId: "tok-audit",
      actorLabel: 'MCP token "Cursor"',
      source: "mcp",
    });
  });

  it("keeps the action text (the dashboard parses it) and names the real source in the source column", () => {
    runInActorContext(TOKEN_ACTOR, "mcp", () => writeAuditEntry("AI: set_app_env (sonarr)", "modify", "X=1"));
    expect(lastRow("AI: set_app_env (sonarr)")).toMatchObject({ actorKind: "mcp_token", actorId: "tok-audit", source: "mcp" });
    expect(lastRow("MCP: set_app_env (sonarr)")).toBeUndefined();

    const chatUser: Actor = { kind: "user", id: "u1", label: "alice (chat)" };
    runInActorContext(chatUser, "chat", () => writeAuditEntry("AI: rename_file", "modify", "a -> b"));
    expect(lastRow("AI: rename_file")).toMatchObject({ actorId: "u1", source: "chat" });

    const automation: Actor = { kind: "automation", id: "a1", label: "Automation: Nightly" };
    runInActorContext(automation, "automation", () => writeAuditEntry("AI: create_directory", "modify", "/d"));
    expect(lastRow("AI: create_directory")).toMatchObject({ actorKind: "automation", actorId: "a1", source: "automation" });
    expect(lastRow("Automation: create_directory")).toBeUndefined();
  });

  it("lets explicit extras win and fills only the fields they leave out", () => {
    runInActorContext(TOKEN_ACTOR, "mcp", () =>
      writeAuditEntry("explicit-extras", "modify", "", true, { actorLabel: "custom", toolName: "set_setting", outcome: "success" }),
    );
    expect(lastRow("explicit-extras")).toMatchObject({
      actorKind: "mcp_token",
      actorId: "tok-audit",
      actorLabel: "custom",
      source: "mcp",
      toolName: "set_setting",
      outcome: "success",
    });
  });

  it("outside any context: no invented actor, and an unapproved entry is 'blocked'", () => {
    writeAuditEntry("no-context", "modify", "");
    expect(lastRow("no-context")).toMatchObject({ actorKind: null, actorId: null, source: null, outcome: null });
    writeAuditEntry("no-context-blocked", "modify", "", false);
    expect(lastRow("no-context-blocked")?.outcome).toBe("blocked");
  });

  it("a tool's own audit row is attributed to the MCP token that called it", async () => {
    const deleteFile = tool({
      description: "fake delete_file that audits like filesystem-tools",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        writeAuditEntry("AI: delete_file", "destructive", path);
        return { success: true };
      },
    });
    const r = await executeTool({
      actor: TOKEN_ACTOR,
      source: "mcp",
      toolName: "fake_delete_file",
      args: { path: "/srv/old.txt" },
      tool: deleteFile,
    });
    expect(r.outcome).toBe("success");
    const row = db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.details, "/srv/old.txt"))
      .all()
      .find((x) => x.action === "AI: delete_file");
    expect(row).toMatchObject({ actorKind: "mcp_token", actorId: "tok-audit", source: "mcp" });
  });
});

describe("REST settings changes are attributed to the session user", () => {
  it("POST /api/settings writes settings_changed with the admin as actor", async () => {
    db.insert(schema.users)
      .values({ id: "admin-1", username: "alice", passwordHash: "x", role: "admin", createdAt: new Date().toISOString() })
      .run();
    const app = new Hono();
    app.use("/api/*", requireSession);
    app.route("/api/settings", settings);
    const cookie = `${SESSION_COOKIE}=${await createSessionToken("admin-1", "admin", "alice")}`;

    const res = await app.request("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ media_root: "/data/media" }),
    });
    expect(res.status).toBe(200);
    expect(lastRow("settings_changed")).toMatchObject({
      details: "media_root",
      actorKind: "user",
      actorId: "admin-1",
      actorLabel: "alice",
      source: "dashboard",
      outcome: "success",
    });
  });
});
