import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A real SQLite file — must be set before db/index.js loads.
const tempDir = mkdtempSync(join(tmpdir(), "talome-mcp-gateway-"));
process.env.DATABASE_PATH = join(tempDir, "talome.db");
process.env.TALOME_SECRET = "b".repeat(64);

type Modules = {
  db: typeof import("../db/index.js")["db"];
  schema: typeof import("../db/index.js")["schema"];
  setSetting: typeof import("../utils/settings.js")["setSetting"];
  mcp: typeof import("../routes/mcp.js");
  redact: typeof import("../utils/redact.js");
  gateway: typeof import("../ai/tool-gateway.js");
  approvals: typeof import("../approval/tool-approvals.js");
  scope: typeof import("../ai/token-scope.js");
};

type McpActor = import("../routes/mcp.js").McpActor;

let m: Modules;

const FULL = { maxTier: "destructive", domains: "*", apps: "*" } as const;
const tokenActor: McpActor = { kind: "token", tokenId: "tok-1", tokenName: "ci-agent", scope: { ...FULL } };

function tokenWith(scope: Partial<import("../ai/token-scope.js").McpTokenScope>): McpActor {
  return { kind: "token", tokenId: "tok-2", tokenName: "scoped", scope: { ...FULL, ...scope } };
}

function auditRows() {
  return m.db.select().from(m.schema.auditLog).all();
}

function pendingApprovals() {
  return m.approvals.listApprovals({ status: "pending" });
}

beforeAll(async () => {
  const { db, schema } = await import("../db/index.js");
  const { runMigrations } = await import("../db/migrate.js");
  runMigrations();
  m = {
    db,
    schema,
    setSetting: (await import("../utils/settings.js")).setSetting,
    mcp: await import("../routes/mcp.js"),
    redact: await import("../utils/redact.js"),
    gateway: await import("../ai/tool-gateway.js"),
    approvals: await import("../approval/tool-approvals.js"),
    scope: await import("../ai/token-scope.js"),
  };
});

beforeEach(() => {
  m.db.delete(m.schema.auditLog).run();
  m.db.delete(m.schema.toolApprovals).run();
  m.db.delete(m.schema.notifications).run();
  m.setSetting("security_mode", "cautious");
  m.setSetting("disabled_tools", "[]");
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("redactSecrets", () => {
  it("redacts credential-looking fields at any depth", () => {
    const out = m.redact.redactSecrets({
      url: "http://sonarr:8989",
      apiKey: "abc",
      nested: { password: "hunter2", list: [{ token: "t" }] },
    });
    expect(out).toEqual({
      url: "http://sonarr:8989",
      apiKey: "[redacted]",
      nested: { password: "[redacted]", list: [{ token: "[redacted]" }] },
    });
  });

  it("redacts the value of a { key, value } pair that names a secret setting", () => {
    expect(m.redact.redactSecrets({ key: "radarr_api_key", value: "s3cret" })).toEqual({
      key: "radarr_api_key",
      value: "[redacted]",
    });
    expect(m.redact.redactSecrets({ key: "radarr_url", value: "http://radarr" })).toEqual({
      key: "radarr_url",
      value: "http://radarr",
    });
  });
});

describe("checkToolPolicy", () => {
  it("allows reads in every mode", () => {
    for (const mode of ["permissive", "cautious", "locked"] as const) {
      expect(m.gateway.checkToolPolicy("read", mode)).toBe("allow");
    }
  });

  it("blocks writes when locked and requires approval for destructive calls when cautious", () => {
    expect(m.gateway.checkToolPolicy("modify", "locked")).toBe("block");
    expect(m.gateway.checkToolPolicy("modify", "cautious")).toBe("allow");
    expect(m.gateway.checkToolPolicy("destructive", "cautious")).toBe("needs-approval");
    expect(m.gateway.checkToolPolicy("destructive", "permissive")).toBe("allow");
  });
});

describe("executeMcpToolCall — security mode", () => {
  it("blocks modify tools in locked mode without executing them", async () => {
    m.setSetting("security_mode", "locked");
    let ran = false;
    const result = await m.mcp.executeMcpToolCall("restart_container", () => { ran = true; return {}; }, { id: "x" }, tokenActor);

    expect(ran).toBe(false);
    expect(result.isError).toBe(true);
    const [row] = auditRows();
    expect(row.action).toBe("MCP BLOCKED (locked mode): restart_container");
    expect(row.tier).toBe("modify");
    expect(row.approved).toBe(false);
    expect(row.details).toContain('MCP token "ci-agent" (tok-1)');
  });

  it("blocks tools the user disabled after the server started", async () => {
    m.setSetting("disabled_tools", JSON.stringify(["restart_container"]));
    let ran = false;
    const result = await m.mcp.executeMcpToolCall("restart_container", () => { ran = true; return {}; }, {}, { kind: "stdio" });

    expect(ran).toBe(false);
    expect(result.isError).toBe(true);
    expect(auditRows()[0].action).toBe("MCP BLOCKED (disabled): restart_container");
  });

  it("marks tool-reported failures as MCP errors and audits them as failed", async () => {
    for (const failure of [{ error: "container not found" }, { success: false, message: "nope" }, { ok: false }]) {
      const result = await m.mcp.executeMcpToolCall("list_containers", () => failure, {}, tokenActor);
      expect(result.isError).toBe(true);
    }
    expect(auditRows().every((row) => row.details.includes("· failed ·"))).toBe(true);

    const ok = await m.mcp.executeMcpToolCall("list_containers", () => ({ success: true, containers: [] }), {}, tokenActor);
    expect(ok.isError).toBeUndefined();
  });

  it("records the real tier and never writes secrets to the audit log", async () => {
    await m.mcp.executeMcpToolCall(
      "set_setting",
      () => ({ success: true }),
      { key: "sonarr_api_key", value: "canary-secret-value" },
      tokenActor,
    );
    const [row] = auditRows();
    expect(row.tier).toBe("modify");
    expect(row.details).toContain("sonarr_api_key");
    expect(row.details).not.toContain("canary-secret-value");
  });
});

describe("server-issued approvals", () => {
  it("does not treat a model-supplied confirmed: true as approval", async () => {
    let ran = false;
    const result = await m.mcp.executeMcpToolCall("uninstall_app", () => { ran = true; return { success: true }; }, { appId: "jellyfin", confirmed: true }, tokenActor);

    expect(ran).toBe(false);
    expect(result.isError).toBe(true);
    const [request] = pendingApprovals();
    expect(request.toolName).toBe("uninstall_app");
    expect(result.content[0].text).toContain(request.code);
    // Admins are told about it
    const notes = m.db.select().from(m.schema.notifications).all();
    expect(notes.some((n) => n.title === "Approval needed: uninstall_app")).toBe(true);
  });

  it("reuses one pending request when the same call is repeated", async () => {
    const execute = () => ({ success: true });
    await m.mcp.executeMcpToolCall("uninstall_app", execute, { appId: "jellyfin" }, tokenActor);
    await m.mcp.executeMcpToolCall("uninstall_app", execute, { appId: "jellyfin" }, tokenActor);
    expect(pendingApprovals()).toHaveLength(1);
  });

  it("runs an approved call exactly once, for the same actor and arguments", async () => {
    let calls = 0;
    const execute = () => { calls++; return { success: true }; };
    const args = { appId: "jellyfin", removeData: false };

    await m.mcp.executeMcpToolCall("uninstall_app", execute, args, tokenActor);
    const [request] = pendingApprovals();
    expect(m.approvals.decideApproval(request.id, true, "admin").ok).toBe(true);

    // Different arguments and a different caller cannot use it
    const otherArgs = await m.mcp.executeMcpToolCall("uninstall_app", execute, { appId: "sonarr", removeData: false }, tokenActor);
    expect(otherArgs.isError).toBe(true);
    const otherActor = await m.mcp.executeMcpToolCall("uninstall_app", execute, args, { kind: "stdio" });
    expect(otherActor.isError).toBe(true);
    expect(calls).toBe(0);

    // Same caller, same arguments (key order does not matter) → runs once
    const approved = await m.mcp.executeMcpToolCall("uninstall_app", execute, { removeData: false, appId: "jellyfin" }, tokenActor);
    expect(approved.isError).toBeUndefined();
    expect(calls).toBe(1);
    expect(auditRows().some((r) => r.action === "MCP: uninstall_app" && r.details.includes(`approved (request ${request.id})`))).toBe(true);

    // Single use: the next identical call needs a fresh approval
    const again = await m.mcp.executeMcpToolCall("uninstall_app", execute, args, tokenActor);
    expect(again.isError).toBe(true);
    expect(calls).toBe(1);
  });

  it("does not run denied or expired requests", async () => {
    const execute = () => ({ success: true });
    await m.mcp.executeMcpToolCall("uninstall_app", execute, { appId: "a" }, tokenActor);
    const [denied] = pendingApprovals();
    m.approvals.decideApproval(denied.id, false, "admin");
    expect(m.approvals.decideApproval(denied.id, true, "admin").ok).toBe(false);
    expect((await m.mcp.executeMcpToolCall("uninstall_app", execute, { appId: "a" }, tokenActor)).isError).toBe(true);

    m.db.delete(m.schema.toolApprovals).run();
    await m.mcp.executeMcpToolCall("uninstall_app", execute, { appId: "b" }, tokenActor);
    const [request] = pendingApprovals();
    m.approvals.decideApproval(request.id, true, "admin");
    // Force the approval window to have passed
    const { eq } = await import("drizzle-orm");
    m.db.update(m.schema.toolApprovals)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(m.schema.toolApprovals.id, request.id))
      .run();
    expect((await m.mcp.executeMcpToolCall("uninstall_app", execute, { appId: "b" }, tokenActor)).isError).toBe(true);
    expect(m.approvals.listApprovals().find((a) => a.id === request.id)?.status).toBe("expired");
  });

  it("lets a messaging chat approve only its own requests by code", () => {
    const chatA = { kind: "messaging", platform: "telegram", externalId: "111" } as const;
    const chatB = { kind: "messaging", platform: "telegram", externalId: "222" } as const;
    const decision = m.gateway.authorizeToolCall("uninstall_app", "destructive", { appId: "x" }, chatA);
    expect(decision.allowed).toBe(false);
    const [request] = pendingApprovals();
    expect(decision.allowed === false && decision.reason).toContain(`approve ${request.code}`);

    expect(m.approvals.decideApprovalByCode(chatB, request.code, true, "telegram:someone").ok).toBe(false);
    expect(m.approvals.decideApprovalByCode(chatA, request.code.toLowerCase(), true, "telegram:owner").ok).toBe(true);
    expect(m.gateway.authorizeToolCall("uninstall_app", "destructive", { appId: "x" }, chatA).allowed).toBe(true);
  });

  it("handles a typed deny reply in the messaging router without calling the model", async () => {
    const chat = { kind: "messaging", platform: "discord", externalId: "999" } as const;
    m.gateway.authorizeToolCall("delete_file", "destructive", { path: "/tmp/x" }, chat);
    const [request] = pendingApprovals();
    const { routeMessage } = await import("../messaging/router.js");

    const reply = await routeMessage({ platform: "discord", externalId: "999", text: `deny ${request.code}` });
    expect(reply).toContain("Denied");
    expect(m.approvals.listApprovals().find((a) => a.id === request.id)?.status).toBe("denied");

    const unknown = await routeMessage({ platform: "discord", externalId: "999", text: "approve ZZZZZZ" });
    expect(unknown).toContain("Couldn't approve ZZZZZZ");
  });
});

describe("gateToolExecution per caller", () => {
  const fakeTool = (onRun: () => void) =>
    ({ description: "t", inputSchema: {}, execute: async () => { onRun(); return { success: true }; } }) as never;

  it("asks for approval in the dashboard chat UI instead of trusting the model", () => {
    const gated = m.gateway.gateToolExecution(fakeTool(() => {}), "uninstall_app", "destructive", { kind: "dashboard" }, "cautious") as { needsApproval?: boolean };
    expect(gated.needsApproval).toBe(true);
    const modify = m.gateway.gateToolExecution(fakeTool(() => {}), "restart_app", "modify", { kind: "dashboard" }, "cautious") as { needsApproval?: boolean };
    expect(modify.needsApproval).toBeUndefined();
  });

  it("blocks automations in locked mode and audits allowed calls with the caller", async () => {
    let ran = 0;
    const tool = m.gateway.gateToolExecution(fakeTool(() => ran++), "restart_app", "modify", { kind: "automation", name: "nightly" }) as unknown as {
      execute: (a: Record<string, unknown>) => Promise<unknown>;
    };
    await tool.execute({ appId: "jellyfin" });
    expect(ran).toBe(1);
    expect(auditRows().at(-1)?.details).toContain('automation "nightly"');

    m.setSetting("security_mode", "locked");
    expect(await tool.execute({ appId: "jellyfin" })).toMatchObject({ error: expect.stringContaining("locked") });
    expect(ran).toBe(1);
  });
});

describe("per-token scopes", () => {
  it("keeps a read-only token away from tools that change things", async () => {
    let ran = false;
    const result = await m.mcp.executeMcpToolCall("restart_app", () => { ran = true; return {}; }, { appId: "jellyfin" }, tokenWith({ maxTier: "read" }));
    expect(ran).toBe(false);
    expect(result.isError).toBe(true);
    expect(auditRows()[0].action).toBe("MCP BLOCKED (token scope): restart_app");
  });

  it("restricts a token to its granted apps", async () => {
    const token = tokenWith({ maxTier: "modify", apps: ["jellyfin"] });
    const execute = () => ({ success: true });
    expect((await m.mcp.executeMcpToolCall("restart_app", execute, { appId: "jellyfin" }, token)).isError).toBeUndefined();
    expect((await m.mcp.executeMcpToolCall("restart_app", execute, { appId: "sonarr" }, token)).isError).toBe(true);
    // Server-wide changes are refused for an app-restricted token
    expect((await m.mcp.executeMcpToolCall("restart_container", execute, { id: "abc" }, token)).isError).toBe(true);
    // Reads without an app target still work
    expect((await m.mcp.executeMcpToolCall("list_containers", execute, {}, token)).isError).toBeUndefined();
  });

  it("restricts a token to its granted domains", () => {
    const scope = { ...FULL, domains: ["core"] };
    expect(m.scope.checkTokenScope(scope, "jellyfin_get_status", "read", "jellyfin", {}).allowed).toBe(false);
    expect(m.scope.checkTokenScope(scope, "list_containers", "read", "core", {}).allowed).toBe(true);
  });

  it("treats a missing or malformed stored scope as read-only", () => {
    expect(m.scope.parseTokenScope(null)).toEqual(m.scope.DEFAULT_TOKEN_SCOPE);
    expect(m.scope.parseTokenScope("{not json")).toEqual(m.scope.DEFAULT_TOKEN_SCOPE);
    expect(m.scope.parseTokenScope(JSON.stringify({ maxTier: "root" }))).toEqual(m.scope.DEFAULT_TOKEN_SCOPE);
  });

  it("rejects expired and revoked tokens and returns each token's own scope", async () => {
    const { verifyBearerToken, hashToken } = await import("../middleware/auth.js");
    const { eq } = await import("drizzle-orm");
    m.db.delete(m.schema.mcpTokens).run();
    m.db.insert(m.schema.mcpTokens).values([
      { id: "a", name: "reader", tokenHash: hashToken("talome_a"), scope: JSON.stringify(m.scope.DEFAULT_TOKEN_SCOPE) },
      { id: "b", name: "full", tokenHash: hashToken("talome_b"), scope: JSON.stringify(FULL) },
      { id: "c", name: "old", tokenHash: hashToken("talome_c"), scope: JSON.stringify(FULL), expiresAt: new Date(Date.now() - 1000).toISOString() },
    ]).run();

    const a = verifyBearerToken("Bearer talome_a");
    const b = verifyBearerToken("Bearer talome_b");
    expect(a.ok && a.scope.maxTier).toBe("read");
    expect(b.ok && b.scope.maxTier).toBe("destructive");
    expect(verifyBearerToken("Bearer talome_c").ok).toBe(false);

    m.db.delete(m.schema.mcpTokens).where(eq(m.schema.mcpTokens.id, "a")).run();
    expect(verifyBearerToken("Bearer talome_a").ok).toBe(false);
    expect(verifyBearerToken("Bearer talome_b").ok).toBe(true);
  });
});

describe("createMcpServer over a real MCP client", () => {
  async function listTools(actor: McpActor = tokenActor) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = m.mcp.createMcpServer(actor);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    return tools;
  }

  it("annotates tools with read-only and destructive hints from their tier", async () => {
    const tools = await listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("list_containers")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get("uninstall_app")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("lists only the tools a token's scope grants", async () => {
    const readOnly = await listTools(tokenWith({ maxTier: "read" }));
    expect(readOnly.some((t) => t.name === "list_containers")).toBe(true);
    expect(readOnly.some((t) => t.name === "restart_container")).toBe(false);
    expect(readOnly.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("exposes a newly configured domain without restarting the process", async () => {
    const { invalidateSettingsCache } = await import("../ai/tool-registry.js");
    expect((await listTools()).some((t) => t.name === "jellyfin_get_status")).toBe(false);
    m.setSetting("jellyfin_url", "http://jellyfin:8096");
    invalidateSettingsCache(); // stands in for the registry's 10s settings-cache TTL
    expect((await listTools()).some((t) => t.name === "jellyfin_get_status")).toBe(true);
  });

  it("hides tools the user disabled", async () => {
    m.setSetting("disabled_tools", JSON.stringify(["list_containers"]));
    expect((await listTools()).some((t) => t.name === "list_containers")).toBe(false);
  });
});

describe("approval and token routes", () => {
  it("are admin-only, and an admin can approve a pending request", async () => {
    const { Hono } = await import("hono");
    const { requireRole } = await import("../middleware/role-guard.js");
    const { approvals } = await import("../routes/approvals.js");
    const { integrations } = await import("../routes/integrations.js");

    const buildApp = (role: string) => {
      const app = new Hono();
      app.use("/api/*", async (c, next) => {
        c.set("sessionRole" as never, role as never);
        c.set("sessionUsername" as never, `${role}-user` as never);
        await next();
      });
      app.use("/api/integrations/*", requireRole("admin"));
      app.use("/api/approvals/*", requireRole("admin"));
      app.route("/api/integrations", integrations);
      app.route("/api/approvals", approvals);
      return app;
    };

    m.gateway.authorizeToolCall("uninstall_app", "destructive", { appId: "z" }, tokenActor);
    const [request] = pendingApprovals();

    const member = buildApp("member");
    expect((await member.request("/api/approvals")).status).toBe(403);
    expect((await member.request(`/api/approvals/${request.id}/approve`, { method: "POST" })).status).toBe(403);
    expect((await member.request("/api/integrations/mcp/tokens", { method: "POST", body: JSON.stringify({ name: "x" }) })).status).toBe(403);

    const admin = buildApp("admin");
    const list = await (await admin.request("/api/approvals?status=pending")).json();
    expect(list.map((a: { id: string }) => a.id)).toEqual([request.id]);
    const res = await admin.request(`/api/approvals/${request.id}/approve`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval).toMatchObject({ status: "approved", decidedBy: "admin-user" });

    // New tokens default to read-only; scopes can be edited
    const created = await (await admin.request("/api/integrations/mcp/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Claude Desktop", expiresInDays: 30 }),
    })).json();
    expect(created.scope).toEqual(m.scope.DEFAULT_TOKEN_SCOPE);
    expect(Date.parse(created.expiresAt)).toBeGreaterThan(Date.now());
    const patched = await admin.request(`/api/integrations/mcp/tokens/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: { maxTier: "modify", domains: ["core"], apps: ["jellyfin"] } }),
    });
    expect(patched.status).toBe(200);
    const tokens = await (await admin.request("/api/integrations/mcp/tokens")).json();
    expect(tokens.find((t: { id: string }) => t.id === created.id).scope).toEqual({ maxTier: "modify", domains: ["core"], apps: ["jellyfin"] });
  });
});
