import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  const dir = process.env.TMPDIR || "/tmp";
  process.env.DATABASE_PATH = `${dir}/talome-trust-mcp-${process.pid}-${Date.now()}/talome.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
});

vi.mock("../ai/agent.js", async () => {
  const registry = await import("../ai/tool-registry.js");
  return { getActiveDomainTools: () => registry.getActiveRegisteredTools() };
});

vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

import { Hono } from "hono";
import { sql, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { hashToken, verifyBearerToken } from "../middleware/auth.js";
import { mcp, createMcpSession, getMcpToolView } from "../routes/mcp.js";
import { mcpTokens } from "../routes/mcp-tokens.js";
import { setSetting } from "../utils/settings.js";
import { invalidateSettingsCache } from "../ai/tool-registry.js";
import { FULL_ACCESS_SCOPES, type TokenScopes } from "../approval/grants.js";
import type { Actor } from "../ai/execution.js";
import { registerFakeDomains, toolCalls } from "./helpers/trust-fixtures.js";

// ── Setup ────────────────────────────────────────────────────────────────────

const LEGACY_PLAINTEXT = "talome_legacy0000000000000000000000";

beforeAll(() => {
  // Simulate a pre-grants install: old mcp_tokens shape with an existing token.
  db.run(sql`CREATE TABLE IF NOT EXISTS mcp_tokens (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL, last_used_at TEXT)`);
  db.run(sql`INSERT INTO mcp_tokens (id, name, token_hash, created_at) VALUES ('legacy-1', 'Old Cursor', ${hashToken(LEGACY_PLAINTEXT)}, ${new Date().toISOString()})`);
  runMigrations();
  registerFakeDomains();
});

beforeEach(() => {
  setSetting("security_mode", "cautious");
  toolCalls.length = 0;
});

let counter = 0;
function insertToken(scopes: TokenScopes, extra: Partial<typeof schema.mcpTokens.$inferInsert> = {}): { id: string; plaintext: string } {
  counter += 1;
  const id = `tok-${counter}`;
  const plaintext = `talome_test${String(counter).padStart(24, "0")}`;
  db.insert(schema.mcpTokens)
    .values({ id, name: `token ${counter}`, tokenHash: hashToken(plaintext), scopes: JSON.stringify(scopes), ...extra })
    .run();
  return { id, plaintext };
}

function actorFor(plaintext: string): Actor {
  const v = verifyBearerToken(`Bearer ${plaintext}`);
  if (!v.ok) throw new Error("token did not verify");
  return { kind: "mcp_token", id: v.token.id, label: v.token.name, scopes: v.token.scopes };
}

async function connect(actor: Actor) {
  const session = createMcpSession(actor);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await session.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, session };
}

async function rpc(token: string | null, method: string, params: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await mcp.request("/", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  const body = dataLine ? JSON.parse(dataLine.slice(6)) : text ? JSON.parse(text) : null;
  return { status: res.status, body };
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

// ── Migration ────────────────────────────────────────────────────────────────

describe("token migration", () => {
  it("migrates pre-grant tokens to full access, flagged legacy", () => {
    const row = db.select().from(schema.mcpTokens).where(eq(schema.mcpTokens.id, "legacy-1")).get();
    expect(row?.legacy).toBe(true);
    expect(JSON.parse(row?.scopes ?? "{}")).toEqual(FULL_ACCESS_SCOPES);
    const v = verifyBearerToken(`Bearer ${LEGACY_PLAINTEXT}`);
    expect(v.ok && v.token.scopes.maxTier).toBe("destructive");
  });

  it("is idempotent", () => {
    expect(() => runMigrations()).not.toThrow();
  });

  it("treats a token with NULL scopes (written by older code) as read-only", () => {
    db.insert(schema.mcpTokens).values({ id: "null-scopes", name: "n", tokenHash: hashToken("talome_nullscopes") }).run();
    const v = verifyBearerToken("Bearer talome_nullscopes");
    expect(v.ok && v.token.scopes.maxTier).toBe("read");
  });
});

// ── HTTP auth ────────────────────────────────────────────────────────────────

describe("MCP HTTP authentication", () => {
  it("rejects missing and unknown tokens with 401", async () => {
    expect((await rpc(null, "tools/list")).status).toBe(401);
    expect((await rpc("talome_doesnotexist", "tools/list")).status).toBe(401);
  });

  it("rejects revoked tokens with 401", async () => {
    const { plaintext } = insertToken(FULL_ACCESS_SCOPES, { revokedAt: new Date().toISOString() });
    const res = await rpc(plaintext, "tools/list");
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toContain("revoked");
  });

  it("rejects expired tokens with 401", async () => {
    const { plaintext } = insertToken(FULL_ACCESS_SCOPES, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const res = await rpc(plaintext, "tools/list");
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toContain("expired");
  });

  it("accepts a live token and lists only tools within its grants", async () => {
    const { plaintext } = insertToken({ maxTier: "read", domains: "all", apps: "all" });
    const res = await rpc(plaintext, "tools/list");
    expect(res.status).toBe(200);
    const names = (res.body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("list_things");
    expect(names).not.toContain("restart_app");
    expect(names).not.toContain("uninstall_app");
  });

  it("propagates the token as actor: calls are audited with the token id", async () => {
    const { id, plaintext } = insertToken({ maxTier: "read", domains: "all", apps: "all" });
    const res = await rpc(plaintext, "tools/call", { name: "list_things", arguments: {} });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeFalsy();
    const entry = db.select().from(schema.auditLog).where(eq(schema.auditLog.actorId, id)).get();
    expect(entry?.actorKind).toBe("mcp_token");
    expect(entry?.source).toBe("mcp");
    expect(entry?.toolName).toBe("list_things");
    expect(entry?.outcome).toBe("success");
  });

  it("throttles last_used_at writes", () => {
    const { id, plaintext } = insertToken(FULL_ACCESS_SCOPES);
    verifyBearerToken(`Bearer ${plaintext}`);
    const first = db.select().from(schema.mcpTokens).where(eq(schema.mcpTokens.id, id)).get()?.lastUsedAt;
    expect(first).toBeTruthy();
    verifyBearerToken(`Bearer ${plaintext}`);
    const second = db.select().from(schema.mcpTokens).where(eq(schema.mcpTokens.id, id)).get()?.lastUsedAt;
    expect(second).toBe(first);
  });
});

// ── Grants ───────────────────────────────────────────────────────────────────

describe("per-token grants", () => {
  it("a restricted token cannot list or call out-of-grant tools", async () => {
    const { plaintext } = insertToken({ maxTier: "read", domains: "all", apps: "all", deniedTools: ["get_app_config"] });
    const { client } = await connect(actorFor(plaintext));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("restart_app");
    expect(names).not.toContain("get_app_config");

    // Unlisted tool: the SDK refuses it
    const r1 = await client.callTool({ name: "restart_app", arguments: { appId: "sonarr" } });
    expect(r1.isError).toBe(true);
    expect(toolCalls.find((c) => c.tool === "restart_app")).toBeUndefined();
  });

  it("re-checks every call: executeTool refuses out-of-grant tools even if a caller bypasses the list", async () => {
    const { plaintext } = insertToken({ maxTier: "read", domains: "all", apps: "all" });
    const { executeTool } = await import("../ai/execution.js");
    const r = await executeTool({ actor: actorFor(plaintext), source: "mcp", toolName: "restart_app", args: { appId: "sonarr" } });
    expect(r.outcome).toBe("blocked");
    expect(r.error?.code).toBe("forbidden");
    expect(toolCalls.find((c) => c.tool === "restart_app")).toBeUndefined();
  });

  it("grant changes apply to the next HTTP request (no stale per-process snapshot)", async () => {
    const { id, plaintext } = insertToken({ maxTier: "modify", domains: "all", apps: "all" });
    const before = await rpc(plaintext, "tools/list");
    expect((before.body.result.tools as Array<{ name: string }>).map((t) => t.name)).toContain("restart_app");
    db.update(schema.mcpTokens)
      .set({ scopes: JSON.stringify({ maxTier: "read", domains: "all", apps: "all" }) })
      .where(eq(schema.mcpTokens.id, id))
      .run();
    const after = await rpc(plaintext, "tools/list");
    expect((after.body.result.tools as Array<{ name: string }>).map((t) => t.name)).not.toContain("restart_app");
    const call = await rpc(plaintext, "tools/call", { name: "restart_app", arguments: { appId: "sonarr" } });
    expect(call.body.result?.isError ?? true).toBe(true);
    expect(toolCalls.find((c) => c.tool === "restart_app")).toBeUndefined();
  });

  it("explains a missing tier with a [forbidden] code and remediation hint", async () => {
    const { plaintext } = insertToken({ maxTier: "modify", domains: "all", apps: "all" });
    const actor = actorFor(plaintext);
    const { executeTool } = await import("../ai/execution.js");
    const r = await executeTool({ actor, source: "mcp", toolName: "uninstall_app", args: { appId: "x" } });
    const { toMcpCallResult } = await import("../routes/mcp.js");
    const mcpResult = toMcpCallResult(r);
    expect(mcpResult.isError).toBe(true);
    expect(textOf(mcpResult)).toMatch(/^\[forbidden\] This token lacks the 'destructive' tier/);
    expect(textOf(mcpResult)).toContain("Settings -> AI agents");
  });

  it("rejects cross-app resource calls", async () => {
    const { plaintext } = insertToken({ maxTier: "modify", domains: "all", apps: ["jellyfin"] });
    const { client } = await connect(actorFor(plaintext));

    const own = await client.callTool({ name: "restart_app", arguments: { appId: "jellyfin" } });
    expect(own.isError).toBeFalsy();

    const other = await client.callTool({ name: "restart_app", arguments: { appId: "sonarr" } });
    expect(other.isError).toBe(true);
    expect(textOf(other)).toContain("[forbidden]");
    expect(textOf(other)).toContain("'sonarr'");

    // Undeterminable target on a modify tool → denied for app-restricted tokens
    const undetermined = await client.callTool({ name: "create_automation", arguments: { name: "x" } });
    expect(undetermined.isError).toBe(true);

    expect(toolCalls.filter((c) => c.tool === "restart_app").map((c) => c.args.appId)).toEqual(["jellyfin"]);
    expect(toolCalls.find((c) => c.tool === "create_automation")).toBeUndefined();
  });

  it("escalates protected settings: a modify token cannot change security_mode", async () => {
    const { plaintext } = insertToken({ maxTier: "modify", domains: "all", apps: "all" });
    const { client } = await connect(actorFor(plaintext));
    const r = await client.callTool({ name: "set_setting", arguments: { key: "security_mode", value: "permissive" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("[forbidden]");
    const ok = await client.callTool({ name: "set_setting", arguments: { key: "media_root", value: "/data" } });
    expect(ok.isError).toBeFalsy();
  });
});

// ── Security mode over MCP ───────────────────────────────────────────────────

describe("security mode applies to MCP", () => {
  it("locked mode blocks MCP modify calls", async () => {
    setSetting("security_mode", "locked");
    const { plaintext } = insertToken(FULL_ACCESS_SCOPES);
    const { client } = await connect(actorFor(plaintext));
    const r = await client.callTool({ name: "restart_app", arguments: { appId: "sonarr" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("[locked]");
    expect(toolCalls.find((c) => c.tool === "restart_app")).toBeUndefined();

    const read = await client.callTool({ name: "list_things", arguments: {} });
    expect(read.isError).toBeFalsy();
  });

  it("cautious mode returns approval_required for destructive calls, even with confirmed:true", async () => {
    const { plaintext } = insertToken(FULL_ACCESS_SCOPES);
    const { client } = await connect(actorFor(plaintext));
    const r = await client.callTool({ name: "uninstall_app", arguments: { appId: "sonarr", confirmed: true } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("[approval_required]");
    expect(textOf(r)).toContain("/dashboard/settings/approvals?id=apr_");
    expect(toolCalls.find((c) => c.tool === "uninstall_app")).toBeUndefined();
  });
});

// ── Results and annotations ──────────────────────────────────────────────────

describe("MCP results and annotations", () => {
  it("maps {error} and {success:false} results to isError, thrown errors too", async () => {
    const { plaintext } = insertToken(FULL_ACCESS_SCOPES);
    const { client } = await connect(actorFor(plaintext));

    const e = await client.callTool({ name: "failing_tool", arguments: {} });
    expect(e.isError).toBe(true);
    expect(textOf(e)).toMatch(/^\[tool_error\] boom: upstream refused/);

    const soft = await client.callTool({ name: "soft_failing_tool", arguments: {} });
    expect(soft.isError).toBe(true);
    expect(textOf(soft)).toContain("nothing to do");

    const thrown = await client.callTool({ name: "throwing_tool", arguments: {} });
    expect(thrown.isError).toBe(true);
    expect(textOf(thrown)).toContain("exploded");

    const entry = db.select().from(schema.auditLog).where(eq(schema.auditLog.toolName, "failing_tool")).get();
    expect(entry?.outcome).toBe("error");
  });

  it("annotates tools from their tiers", async () => {
    const { plaintext } = insertToken(FULL_ACCESS_SCOPES);
    const { client } = await connect(actorFor(plaintext));
    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));

    expect(byName.get("list_things")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get("restart_app")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get("uninstall_app")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(byName.get("uninstall_app")?.title).toBe("Uninstall app");
    // destructive tools accept the reserved approval_id argument
    expect(Object.keys((byName.get("uninstall_app")?.inputSchema.properties ?? {}) as object)).toContain("approval_id");
    expect(Object.keys((byName.get("restart_app")?.inputSchema.properties ?? {}) as object)).not.toContain("approval_id");
  });
});

// ── Dynamic tool view ────────────────────────────────────────────────────────

describe("dynamic tool view", () => {
  it("newly configured domains appear per request and via stdio sync (list_changed)", async () => {
    const owner: Actor = { kind: "mcp_stdio", id: "local", label: "Local MCP (stdio)" };
    const { client, session } = await connect(owner);
    const listChanged = vi.fn();
    const { ToolListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
    client.setNotificationHandler(ToolListChangedNotificationSchema, listChanged);

    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("jellyfin_scan_library");
    expect(getMcpToolView(owner).map((v) => v.name)).not.toContain("jellyfin_scan_library");

    setSetting("jellyfin_url", "http://jellyfin:8096");
    invalidateSettingsCache();

    expect(getMcpToolView(owner).map((v) => v.name)).toContain("jellyfin_scan_library");
    const { added } = session.sync();
    expect(added).toContain("jellyfin_scan_library");
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("jellyfin_scan_library");
    await vi.waitFor(() => expect(listChanged).toHaveBeenCalled());

    // Disabled tools disappear
    setSetting("disabled_tools", JSON.stringify(["jellyfin_scan_library"]));
    const { removed } = session.sync();
    expect(removed).toContain("jellyfin_scan_library");
    setSetting("disabled_tools", "[]");
  });
});

// ── Token management routes ──────────────────────────────────────────────────

describe("MCP token routes", () => {
  function app(role: "admin" | "member") {
    const a = new Hono();
    a.use("*", async (c, next) => {
      c.set("sessionRole" as never, role as never);
      c.set("sessionUser" as never, "u1" as never);
      await next();
    });
    a.route("/tokens", mcpTokens);
    return a;
  }

  it("new tokens default to read-only and the plaintext verifies", async () => {
    const res = await app("admin").request("/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "claude desktop" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; scopes: TokenScopes };
    expect(body.scopes.maxTier).toBe("read");
    const v = verifyBearerToken(`Bearer ${body.token}`);
    expect(v.ok && v.token.scopes.maxTier).toBe("read");
    const row = db.select().from(schema.mcpTokens).where(eq(schema.mcpTokens.name, "claude desktop")).get();
    expect(row?.tokenHash).not.toBe(body.token);
  });

  it("members cannot manage tokens", async () => {
    const res = await app("member").request("/tokens");
    expect(res.status).toBe(403);
  });

  it("DELETE revokes (soft) and the token stops working", async () => {
    const { id, plaintext } = insertToken(FULL_ACCESS_SCOPES);
    const res = await app("admin").request(`/tokens/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(verifyBearerToken(`Bearer ${plaintext}`).ok).toBe(false);
    const list = (await (await app("admin").request("/tokens")).json()) as Array<{ id: string }>;
    expect(list.find((t) => t.id === id)).toBeUndefined();
    const all = (await (await app("admin").request("/tokens?includeRevoked=1")).json()) as Array<{ id: string; revokedAt: string | null }>;
    expect(all.find((t) => t.id === id)?.revokedAt).toBeTruthy();
  });

  it("PATCH updates grants and clears the legacy flag", async () => {
    const res = await app("admin").request("/tokens/legacy-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes: { maxTier: "modify", domains: ["core"], apps: "all" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: { legacy: boolean; scopes: TokenScopes } };
    expect(body.token.legacy).toBe(false);
    expect(body.token.scopes).toEqual({ maxTier: "modify", domains: ["core"], apps: "all" });
  });

  it("rejects invalid scopes", async () => {
    const res = await app("admin").request("/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", scopes: { maxTier: "root", domains: "all", apps: "all" } }),
    });
    expect(res.status).toBe(400);
  });
});
