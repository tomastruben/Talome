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
};

let m: Modules;
const tokenActor = { kind: "token", tokenId: "tok-1", tokenName: "ci-agent" } as const;

function auditRows() {
  return m.db.select().from(m.schema.auditLog).all();
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
  };
});

beforeEach(() => {
  m.db.delete(m.schema.auditLog).run();
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
      expect(m.gateway.checkToolPolicy("list_containers", "read", mode, {}).allowed).toBe(true);
    }
  });

  it("blocks writes in locked mode and unconfirmed destructive calls in cautious mode", () => {
    expect(m.gateway.checkToolPolicy("restart_container", "modify", "locked", {}).allowed).toBe(false);
    expect(m.gateway.checkToolPolicy("restart_container", "modify", "cautious", {}).allowed).toBe(true);
    expect(m.gateway.checkToolPolicy("uninstall_app", "destructive", "cautious", {}).allowed).toBe(false);
    expect(m.gateway.checkToolPolicy("uninstall_app", "destructive", "cautious", { confirmed: true }).allowed).toBe(true);
    expect(m.gateway.checkToolPolicy("uninstall_app", "destructive", "permissive", {}).allowed).toBe(true);
  });
});

describe("executeMcpToolCall", () => {
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
    expect(row.details).toContain('token "ci-agent" (tok-1)');
  });

  it("requires confirmation for destructive tools in cautious mode", async () => {
    let calls = 0;
    const execute = () => { calls++; return { success: true }; };

    const blocked = await m.mcp.executeMcpToolCall("uninstall_app", execute, { appId: "jellyfin" }, tokenActor);
    expect(blocked.isError).toBe(true);
    expect(calls).toBe(0);

    const allowed = await m.mcp.executeMcpToolCall("uninstall_app", execute, { appId: "jellyfin", confirmed: true }, tokenActor);
    expect(allowed.isError).toBeUndefined();
    expect(calls).toBe(1);
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

describe("createMcpServer over a real MCP client", () => {
  async function listTools() {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = m.mcp.createMcpServer(tokenActor);
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
