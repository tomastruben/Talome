/**
 * E2E bug 12 + observation: calls to known tools outside a token's view were
 * rejected by the MCP SDK ("Tool X not found") before executeTool() ran, so
 * they left no audit row; and app-limited tokens listed ~20 modify tools
 * (set_setting, create_directory, ...) that every call then refused.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  const dir = process.env.TMPDIR || "/tmp";
  process.env.DATABASE_PATH = `${dir}/talome-mcp-out-of-view-${process.pid}-${Date.now()}/talome.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
});

vi.mock("../ai/agent.js", async () => {
  const registry = await import("../ai/tool-registry.js");
  return { getActiveDomainTools: () => registry.getActiveRegisteredTools() };
});

vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { hashToken, verifyBearerToken } from "../middleware/auth.js";
import { mcp, getMcpToolView } from "../routes/mcp.js";
import { setSetting } from "../utils/settings.js";
import { invalidateSettingsCache } from "../ai/tool-registry.js";
import type { TokenScopes } from "../approval/grants.js";
import type { Actor } from "../ai/execution.js";
import { registerFakeDomains, toolCalls } from "./helpers/trust-fixtures.js";

beforeAll(() => {
  runMigrations();
  registerFakeDomains();
});

beforeEach(() => {
  setSetting("security_mode", "cautious");
  toolCalls.length = 0;
});

let counter = 0;
function insertToken(scopes: TokenScopes): { id: string; plaintext: string } {
  counter += 1;
  const id = `oov-${counter}`;
  const plaintext = `talome_oov${String(counter).padStart(26, "0")}`;
  db.insert(schema.mcpTokens)
    .values({ id, name: `oov token ${counter}`, tokenHash: hashToken(plaintext), scopes: JSON.stringify(scopes) })
    .run();
  return { id, plaintext };
}

function actorFor(plaintext: string): Actor {
  const v = verifyBearerToken(`Bearer ${plaintext}`);
  if (!v.ok) throw new Error("token did not verify");
  return { kind: "mcp_token", id: v.token.id, label: v.token.name, scopes: v.token.scopes };
}

async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const res = await mcp.request("/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return { status: res.status, text: await res.text() };
}

function blockedRows(tokenId: string, toolName: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.actorId, tokenId), eq(schema.auditLog.toolName, toolName)))
    .all();
}

describe("calls to tools outside a token's view are audited (bug 12)", () => {
  it("a read-only token calling a destructive tool leaves a blocked audit row", async () => {
    const { id, plaintext } = insertToken({ maxTier: "read", domains: "all", apps: "all" });
    const res = await callTool(plaintext, "uninstall_app", { appId: "sonarr" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("not found");
    expect(toolCalls).toHaveLength(0);

    const rows = blockedRows(id, "uninstall_app");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "BLOCKED (not_in_view): uninstall_app",
      tier: "destructive",
      approved: false,
      actorKind: "mcp_token",
      source: "mcp",
      outcome: "blocked",
    });
    expect(rows[0]!.details).toContain("lacks the 'destructive' tier");
  });

  it("does not audit names that are not Talome tools", async () => {
    const { id, plaintext } = insertToken({ maxTier: "read", domains: "all", apps: "all" });
    await callTool(plaintext, "no_such_tool_anywhere", {});
    expect(blockedRows(id, "no_such_tool_anywhere")).toHaveLength(0);
  });

  it("does not add a not_in_view row for tools inside the view", async () => {
    const { id, plaintext } = insertToken({ maxTier: "read", domains: "all", apps: "all" });
    await callTool(plaintext, "list_things", {});
    const rows = blockedRows(id, "list_things");
    expect(rows.every((r) => !r.action.startsWith("BLOCKED (not_in_view)"))).toBe(true);
  });
});

describe("app-limited tokens only list tools they can call", () => {
  it("hides modify tools without an app argument and app domains the token does not cover", () => {
    setSetting("jellyfin_url", "http://jellyfin:8096");
    invalidateSettingsCache();

    const sonarrOnly = actorFor(insertToken({ maxTier: "modify", domains: "all", apps: ["sonarr"] }).plaintext);
    const names = getMcpToolView(sonarrOnly).map((v) => v.name);
    expect(names).toContain("restart_app"); // takes appId
    expect(names).toContain("list_things"); // read, no target
    expect(names).toContain("get_app_config");
    expect(names).not.toContain("create_automation"); // modify, no target argument
    expect(names).not.toContain("set_setting");
    expect(names).not.toContain("jellyfin_scan_library"); // bound to jellyfin

    const jellyfin = actorFor(insertToken({ maxTier: "modify", domains: "all", apps: ["jellyfin"] }).plaintext);
    expect(getMcpToolView(jellyfin).map((v) => v.name)).toContain("jellyfin_scan_library");

    const all = actorFor(insertToken({ maxTier: "modify", domains: "all", apps: "all" }).plaintext);
    expect(getMcpToolView(all).map((v) => v.name)).toContain("create_automation");
  });

  it("a hidden tool called anyway is refused and audited with the reason", async () => {
    const { id, plaintext } = insertToken({ maxTier: "modify", domains: "all", apps: ["sonarr"] });
    await callTool(plaintext, "create_automation", { name: "x" });
    expect(toolCalls.find((c) => c.tool === "create_automation")).toBeUndefined();
    const rows = blockedRows(id, "create_automation");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toContain("can never target");
  });
});
