/**
 * Automations written by a scoped MCP token follow that token:
 *  - revoking, expiring or deleting the token stops (and disables) them;
 *  - narrowing the token narrows them on the next run;
 *  - any change a scoped token makes to an automation (enable, trigger,
 *    rename — not only steps) binds it to the token's grants, so a token
 *    cannot enable or re-time an owner-written automation to run owner-level
 *    steps outside its grants.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  const dir = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  process.env.DATABASE_PATH = `${dir}/talome-security-automation-writer-${process.pid}-${Date.now()}.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
});

const m = vi.hoisted(() => ({
  runAutomationPrompt: vi.fn(async (_params: unknown) => "ok"),
  restarts: [] as string[],
}));

vi.mock("../ai/agent.js", async () => {
  const registry = await import("../ai/tool-registry.js");
  return {
    getActiveDomainTools: () => registry.getActiveRegisteredTools(),
    runAutomationPrompt: m.runAutomationPrompt,
  };
});

import { tool, type Tool } from "ai";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { registerDomain } from "../ai/tool-registry.js";
import { setSetting } from "../utils/settings.js";
import { executeTool, withExecutionContext, type Actor } from "../ai/execution.js";
import { createAutomationTool, updateAutomationTool } from "../ai/tools/automation-tools.js";
import { fireTrigger, resolveAutomationGrant } from "../automation/engine.js";
import type { TokenScopes } from "../approval/grants.js";

const restartApp = tool({
  description: "Restart an app (modify).",
  inputSchema: z.object({ appId: z.string() }),
  execute: async ({ appId }) => {
    m.restarts.push(appId);
    return { success: true, appId };
  },
});

const BROAD: TokenScopes = { maxTier: "modify", domains: "all", apps: "all" };
const AUTOMATIONS_ONLY: TokenScopes = { maxTier: "modify", domains: ["automations"], apps: "all" };

function addToken(id: string, scopes: TokenScopes, extra: Partial<typeof schema.mcpTokens.$inferInsert> = {}): Actor {
  db.insert(schema.mcpTokens).values({
    id,
    name: `Token ${id}`,
    tokenHash: `hash-${id}`,
    scopes: JSON.stringify(scopes),
    ...extra,
  }).run();
  return { kind: "mcp_token", id, label: `MCP token "Token ${id}"`, scopes };
}

async function asToken(actor: Actor, toolName: string, args: Record<string, unknown>) {
  return withExecutionContext(actor, "mcp", () => executeTool({ actor, source: "mcp", toolName, args }));
}

async function createAs(actor: Actor, name: string, appId: string): Promise<string> {
  const r = await asToken(actor, "create_automation", {
    name,
    enabled: true,
    trigger: { type: "schedule", cron: "0 * * * *" },
    steps: [{ id: "s1", type: "tool_action", toolName: "restart_app", args: { appId }, approvalPolicy: "auto" }],
  });
  expect(r.outcome).toBe("success");
  return (r.result as { id: string }).id;
}

function automation(id: string) {
  return db.select().from(schema.automations).where(eq(schema.automations.id, id)).get()!;
}

function latestRun(id: string) {
  return db
    .select()
    .from(schema.automationRuns)
    .where(eq(schema.automationRuns.automationId, id))
    .orderBy(desc(schema.automationRuns.triggeredAt))
    .get();
}

beforeAll(() => {
  runMigrations();
  registerDomain({
    name: "core",
    settingsKeys: [],
    tools: { restart_app: restartApp },
    tiers: { restart_app: "modify" },
  });
  registerDomain({
    name: "automations",
    settingsKeys: [],
    tools: {
      create_automation: createAutomationTool as unknown as Tool,
      update_automation: updateAutomationTool as unknown as Tool,
    },
    tiers: { create_automation: "modify", update_automation: "modify" },
  });
});

beforeEach(() => {
  setSetting("security_mode", "cautious");
  m.restarts.length = 0;
});

describe("automations follow the token that wrote them", () => {
  it("records the writer token and runs under its grants", async () => {
    const token = addToken("tok-live", BROAD);
    const id = await createAs(token, "Live token restart", "live-app");
    expect(automation(id)).toMatchObject({ actorTokenId: "tok-live" });

    const [run] = await fireTrigger("schedule", { automationId: id, manual: true });
    expect(run.success).toBe(true);
    expect(m.restarts).toEqual(["live-app"]);
  });

  it("revoking the token stops the automation and disables it", async () => {
    const token = addToken("tok-revoked", BROAD);
    const id = await createAs(token, "Leaked token restart", "victim");

    db.update(schema.mcpTokens).set({ revokedAt: new Date().toISOString() }).where(eq(schema.mcpTokens.id, "tok-revoked")).run();

    const [run] = await fireTrigger("schedule", { automationId: id, manual: true });
    expect(run.success).toBe(false);
    expect(run.error).toContain("revoked");
    expect(m.restarts).not.toContain("victim");
    expect(automation(id).enabled).toBe(false);
    expect(latestRun(id)).toMatchObject({ status: "failed", success: false });
    const note = db.select().from(schema.notifications).where(eq(schema.notifications.sourceId, id)).get();
    expect(note?.title).toBe('Automation "Leaked token restart" disabled');

    // Disabled: the next scheduled tick does not run it at all.
    expect(await fireTrigger("schedule", { automationId: id })).toHaveLength(0);
  });

  it("an expired or deleted token also blocks the automation", async () => {
    const expired = addToken("tok-expired", BROAD, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const a = await createAs({ ...expired }, "Expired token restart", "victim-2");
    expect((await fireTrigger("schedule", { automationId: a, manual: true }))[0].error).toContain("expired");

    const gone = addToken("tok-deleted", BROAD);
    const b = await createAs(gone, "Deleted token restart", "victim-3");
    db.delete(schema.mcpTokens).where(eq(schema.mcpTokens.id, "tok-deleted")).run();
    expect((await fireTrigger("schedule", { automationId: b, manual: true }))[0].error).toContain("no longer exists");
    expect(m.restarts).toEqual([]);
  });

  it("narrowing the token narrows the automation on its next run", async () => {
    const token = addToken("tok-narrowed", BROAD);
    const id = await createAs(token, "Narrowed token restart", "narrow-app");

    db.update(schema.mcpTokens)
      .set({ scopes: JSON.stringify({ maxTier: "read", domains: "all", apps: "all" }) })
      .where(eq(schema.mcpTokens.id, "tok-narrowed"))
      .run();
    expect(resolveAutomationGrant(automation(id))).toMatchObject({ ok: true, scopes: { maxTier: "read" } });

    const [run] = await fireTrigger("schedule", { automationId: id, manual: true });
    expect(run.success).toBe(false);
    expect(run.results[0].error).toContain("'modify' tier");
    expect(m.restarts).not.toContain("narrow-app");
  });
});

describe("a scoped token cannot enable or re-time an owner automation outside its grants", () => {
  function addOwnerAutomation(id: string, enabled: boolean) {
    db.insert(schema.automations).values({
      id,
      name: `Owner ${id}`,
      enabled,
      trigger: JSON.stringify({ type: "schedule", cron: "0 3 * * *" }),
      actions: "[]",
      workflowVersion: 2,
      steps: JSON.stringify([{ id: "s1", type: "tool_action", toolName: "restart_app", args: { appId: `owner-${id}` }, approvalPolicy: "auto" }]),
    }).run();
  }

  it("enabling + re-timing without steps binds the automation to the token's grants", async () => {
    addOwnerAutomation("owner-disabled", false);
    const token = addToken("tok-automations-only", AUTOMATIONS_ONLY);

    const r = await asToken(token, "update_automation", {
      id: "owner-disabled",
      enabled: true,
      trigger: { type: "schedule", cron: "* * * * *" },
    });
    expect(r.outcome).toBe("success");
    expect(automation("owner-disabled")).toMatchObject({ enabled: true, actorTokenId: "tok-automations-only" });
    expect(JSON.parse(automation("owner-disabled").actorScopes!)).toEqual(AUTOMATIONS_ONLY);

    const [run] = await fireTrigger("schedule", { automationId: "owner-disabled", manual: true });
    expect(run.success).toBe(false);
    expect(run.results[0].error).toContain("'core' tool domain");
    expect(m.restarts).not.toContain("owner-owner-disabled");
  });

  it("a rename alone also binds it", async () => {
    addOwnerAutomation("owner-renamed", true);
    const token = addToken("tok-renamer", AUTOMATIONS_ONLY);
    expect((await asToken(token, "update_automation", { id: "owner-renamed", name: "Renamed" })).outcome).toBe("success");
    expect(automation("owner-renamed")).toMatchObject({ name: "Renamed", actorTokenId: "tok-renamer" });
  });

  it("owner edits keep an owner automation owner-level", async () => {
    addOwnerAutomation("owner-kept", false);
    const owner: Actor = { kind: "user", id: "u1", label: "Owner (chat)" };
    const r = await withExecutionContext(owner, "chat", () =>
      executeTool({ actor: owner, source: "chat", toolName: "update_automation", args: { id: "owner-kept", enabled: true } }),
    );
    expect(r.outcome).toBe("success");
    expect(automation("owner-kept")).toMatchObject({ enabled: true, actorScopes: null, actorTokenId: null });
    const [run] = await fireTrigger("schedule", { automationId: "owner-kept", manual: true });
    expect(run.success).toBe(true);
    expect(m.restarts).toContain("owner-owner-kept");
  });

  it("an automation actor writing automations stays bound to its token", async () => {
    const token = addToken("tok-parent", AUTOMATIONS_ONLY);
    const parentId = await createAs(token, "Parent", "parent-app");
    const child: Actor = { kind: "automation", id: parentId, label: "Automation: Parent", scopes: AUTOMATIONS_ONLY };
    const r = await withExecutionContext(child, "automation", () =>
      executeTool({
        actor: child,
        source: "automation",
        toolName: "create_automation",
        args: {
          name: "Child",
          enabled: true,
          trigger: { type: "schedule", cron: "0 * * * *" },
          steps: [{ id: "s1", type: "notify", level: "info", title: "hi" }],
        },
      }),
    );
    expect(r.outcome).toBe("success");
    expect(automation((r.result as { id: string }).id)).toMatchObject({ actorTokenId: "tok-parent" });
  });
});
