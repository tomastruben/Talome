/**
 * User-created custom tools (`~/.talome/custom-tools/`, loaded as `custom_*`)
 * run arbitrary code and declare no tier. Without an explicit tier they are
 * writes ("modify"): locked mode blocks them, read-only grants exclude them,
 * and the chat gateway's "read" fallback cannot lower that. Uses the real
 * domain registrations from agent.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const customTools = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock("../db/index.js", () => {
  const chain = () => ({
    where: () => ({ get: () => null, all: () => [], orderBy: () => ({ get: () => null }) }),
    all: () => [],
    orderBy: () => ({ limit: () => ({ all: () => [] }) }),
  });
  return {
    db: { select: () => ({ from: chain }) },
    schema: { settings: { key: "key" }, installedApps: { appId: "app_id" }, mcpTokens: {}, memories: {}, approvals: {} },
  };
});
vi.mock("../db/audit.js", () => ({ writeAuditEntry: vi.fn() }));
vi.mock("../db/memories.js", () => ({ getTopMemories: vi.fn().mockResolvedValue([]) }));
vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));
vi.mock("../ai/custom-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai/custom-tools.js")>();
  return { ...actual, getCustomTools: () => customTools };
});

import { tool } from "ai";
import { z } from "zod";
import { writeAuditEntry } from "../db/audit.js";
import { CUSTOM_TOOL_DEFAULT_TIER, executeTool, getToolMeta, type Actor } from "../ai/execution.js";
import { gateToolExecution } from "../ai/tool-gateway.js";
import { checkToolGrant, READ_ONLY_SCOPES } from "../approval/grants.js";
import "../ai/agent.js";

const ran: string[] = [];
const customPing = tool({
  description: "custom tool (fake)",
  inputSchema: z.object({ target: z.string() }),
  execute: async ({ target }) => {
    ran.push(target);
    return { ok: true };
  },
});

const owner: Actor = { kind: "user", id: "u1", label: "Owner (chat)" };
const readOnlyToken: Actor = { kind: "mcp_token", id: "tok-ro", label: "Read-only token", scopes: READ_ONLY_SCOPES };

describe("custom tool tier", () => {
  beforeEach(() => {
    ran.length = 0;
    vi.mocked(writeAuditEntry).mockClear();
    for (const key of Object.keys(customTools)) delete customTools[key];
    customTools.custom_ping = customPing;
  });

  it("defaults to modify, and the chat gateway's read fallback can't lower it", () => {
    expect(CUSTOM_TOOL_DEFAULT_TIER).toBe("modify");
    expect(getToolMeta("custom_ping")).toMatchObject({ domain: "custom", tier: "modify" });
    expect(getToolMeta("custom_ping", "read").tier).toBe("modify");
    // An explicit higher tier still wins.
    expect(getToolMeta("custom_ping", "destructive").tier).toBe("destructive");
  });

  it("leaves built-in tools and internal pseudo-tools alone", () => {
    expect(getToolMeta("list_containers").tier).toBe("read");
    expect(getToolMeta("automation_ai_prompt", "read").tier).toBe("read");
  });

  it("is blocked in locked mode, through executeTool and the chat gateway", async () => {
    const direct = await executeTool({ actor: owner, source: "chat", toolName: "custom_ping", tool: customPing, args: { target: "a" }, mode: "locked", baseTier: "read" });
    expect(direct.outcome).toBe("blocked");
    expect(direct.error?.code).toBe("locked");

    // agent.ts gates chat tools with `TOOL_TIERS[name] ?? "read"`.
    const gated = gateToolExecution(customPing, "custom_ping", "read", "locked", owner, "chat") as unknown as {
      execute: (args: unknown, options: unknown) => Promise<unknown>;
    };
    const result = (await gated.execute({ target: "b" }, { toolCallId: "t1", messages: [] })) as { error?: string };
    expect(result.error).toMatch(/locked/);
    expect(ran).toEqual([]);
  });

  it("runs as a write in cautious mode: audited with the modify tier", async () => {
    const r = await executeTool({ actor: owner, source: "chat", toolName: "custom_ping", tool: customPing, args: { target: "c" }, mode: "cautious", baseTier: "read" });
    expect(r.outcome).toBe("success");
    expect(r.tier).toBe("modify");
    expect(ran).toEqual(["c"]);
    // Chat reads are not audited; a custom tool call is.
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.stringContaining("custom_ping"), "modify", expect.any(String), true, expect.any(Object));
  });

  it("is outside a read-only token's grants", async () => {
    const meta = getToolMeta("custom_ping");
    expect(checkToolGrant(READ_ONLY_SCOPES, { name: "custom_ping", tier: meta.tier, domain: meta.domain }).ok).toBe(false);
    const r = await executeTool({ actor: readOnlyToken, source: "mcp", toolName: "custom_ping", tool: customPing, args: { target: "d" } });
    expect(r.outcome).toBe("blocked");
    expect(r.error?.code).toBe("forbidden");
    expect(ran).toEqual([]);
  });
});
