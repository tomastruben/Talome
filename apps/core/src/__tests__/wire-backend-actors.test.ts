/**
 * wire-backend: one actor, one execution path.
 *
 * Actor attribution flows from chat, MCP tokens, automations and the agent
 * loop into app_operations.actor and audit rows; unattended approvals end as
 * blocked_approval with a linked notification; remediation never loops on
 * approval_required; notifications carry a first-class link.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  const dir = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  process.env.DATABASE_PATH = `${dir}/talome-wire-backend-${process.pid}-${Date.now()}.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
});

const m = vi.hoisted(() => ({
  generateText: vi.fn(),
  createAnthropic: vi.fn(),
  runAutomationPrompt: vi.fn(async (_params: unknown) => "ok"),
  restartExecutions: [] as string[],
  cleanupExecutions: 0,
}));

// Keep the heavy agent module out: MCP needs its tool view, the engine its prompt runner.
vi.mock("../ai/agent.js", async () => {
  const registry = await import("../ai/tool-registry.js");
  return {
    getActiveDomainTools: () => registry.getActiveRegisteredTools(),
    runAutomationPrompt: m.runAutomationPrompt,
  };
});

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: m.generateText,
}));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: m.createAnthropic }));
vi.mock("../agent-loop/budget.js", () => ({
  checkBudget: () => true,
  logAiUsage: vi.fn(),
  shouldRunService: () => ({ allowed: true }),
  getEffectiveRate: (n: number) => n,
}));
vi.mock("../ai/claude-process.js", () => ({
  isClaudeCodeAvailable: vi.fn(async () => false),
  spawnClaudeStreaming: vi.fn(),
}));

// Remediation tools are captured when remediation.ts is imported, so they are
// built here (hoisted) and delegate to implementations assigned below.
type Impl = (args: Record<string, unknown>) => Promise<unknown>;
const fakes = vi.hoisted(() => {
  const impl: { restartContainer: Impl; cleanupDocker: Impl } = {
    restartContainer: async () => ({}),
    cleanupDocker: async () => ({}),
  };
  return {
    impl,
    restartContainer: {
      description: "Restart a container (modify).",
      execute: (args: Record<string, unknown>) => impl.restartContainer(args),
    },
    cleanupDocker: {
      description: "Prune Docker resources (destructive).",
      execute: (args: Record<string, unknown>) => impl.cleanupDocker(args),
    },
  };
});

vi.mock("../ai/tools/docker-tools.js", () => ({
  listContainersTool: {},
  getContainerLogsTool: {},
  restartContainerTool: fakes.restartContainer,
  checkServiceHealthTool: {},
}));
vi.mock("../ai/tools/storage-tools.js", () => ({ cleanupDockerTool: fakes.cleanupDocker }));
vi.mock("../ai/tools/system-tools.js", () => ({ getSystemStatsTool: {}, getDiskUsageTool: {}, getSystemHealthTool: {} }));
vi.mock("../ai/tools/diagnose-tool.js", () => ({ diagnoseAppTool: {} }));
vi.mock("../ai/tools/arr-tools.js", () => ({ arrGetStatusTool: {}, arrGetQueueDetailsTool: {}, arrListDownloadClientsTool: {} }));
vi.mock("../ai/tools/qbittorrent-tools.js", () => ({ qbtListTorrentsTool: {} }));
vi.mock("../ai/tools/jellyfin-tools.js", () => ({ jellyfinGetStatusTool: {}, jellyfinScanLibraryTool: {} }));
vi.mock("../ai/tools/log-tools.js", () => ({ searchContainerLogsTool: {} }));
vi.mock("../ai/tools/app-tools.js", () => ({ rollbackUpdateTool: {}, checkDependenciesTool: {} }));

import { tool, type Tool } from "ai";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { registerDomain } from "../ai/tool-registry.js";
import { setSetting } from "../utils/settings.js";
import { withAppOperation, currentActor, runWithActor } from "../ops/operations.js";
import {
  executeTool,
  sessionChatActor,
  withExecutionContext,
  isApprovalRequiredResult,
  approvalLink,
  type Actor,
} from "../ai/execution.js";
import { gateToolExecution } from "../ai/tool-gateway.js";
import { createMcpSession } from "../routes/mcp.js";
import { fireTrigger, type AutomationStep } from "../automation/engine.js";
import { remediateEvent, __resetEscalationsForTests, REMEDIATION_ACTOR } from "../agent-loop/remediation.js";
import { decideApproval, getApproval } from "../approval/approvals.js";
import { writeNotification, sanitizeNotificationLink } from "../db/notifications.js";
import { notifications as notificationsRoute } from "../routes/notifications.js";
import type { SystemEvent } from "../agent-loop/types.js";

// ── Fake tools ───────────────────────────────────────────────────────────────

async function journaledRestart(appId: string): Promise<{ success: true; appId: string; actor: string }> {
  const actor = currentActor();
  await withAppOperation(appId, "restart", actor, async () => ({ success: true }));
  return { success: true, appId, actor };
}

const restartApp = tool({
  description: "Restart an app (modify).",
  inputSchema: z.object({ appId: z.string() }),
  execute: async ({ appId }) => {
    m.restartExecutions.push(appId);
    return journaledRestart(appId);
  },
});
fakes.impl.restartContainer = async (args) => {
  const containerId = String(args.containerId);
  m.restartExecutions.push(containerId);
  return journaledRestart(containerId);
};
fakes.impl.cleanupDocker = async () => {
  m.cleanupExecutions += 1;
  return { success: true, reclaimed: "1GB" };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function lastOperation(appId: string) {
  return db
    .select()
    .from(schema.appOperations)
    .where(eq(schema.appOperations.appId, appId))
    .orderBy(desc(schema.appOperations.startedAt))
    .get();
}

function auditFor(toolName: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.toolName, toolName))
    .orderBy(desc(schema.auditLog.id))
    .all();
}

function addAutomation(id: string, name: string, steps: AutomationStep[]) {
  db.insert(schema.automations).values({
    id,
    name,
    enabled: true,
    trigger: JSON.stringify({ type: `wire_${id}` }),
    actions: "[]",
    workflowVersion: 2,
    steps: JSON.stringify(steps),
    createdAt: new Date().toISOString(),
  }).run();
}

function stepRows(runId: string) {
  return db.select().from(schema.automationStepRuns).where(eq(schema.automationStepRuns.runId, runId)).all();
}

function runsFor(automationId: string) {
  return db
    .select()
    .from(schema.automationRuns)
    .where(eq(schema.automationRuns.automationId, automationId))
    .orderBy(desc(schema.automationRuns.triggeredAt))
    .all();
}

function makeEvent(overrides: Partial<SystemEvent> = {}): SystemEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type: "container_down",
    severity: "critical",
    source: "sonarr",
    message: "sonarr exited unexpectedly",
    data: { containerName: "sonarr" },
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

type ExecFn = (args: unknown, options: unknown) => Promise<unknown>;
type StopCondition = (opts: { steps: unknown[] }) => boolean | Promise<boolean>;

/** A fake model that keeps calling one tool until stopWhen says stop (max 8 steps). */
function modelCalling(toolName: string, args: Record<string, unknown>) {
  return async (opts: { tools: Record<string, { execute?: ExecFn }>; stopWhen?: StopCondition | StopCondition[] }) => {
    const conditions = Array.isArray(opts.stopWhen) ? opts.stopWhen : opts.stopWhen ? [opts.stopWhen] : [];
    let calls = 0;
    for (let step = 0; step < 8; step++) {
      await opts.tools[toolName]?.execute?.(args, { toolCallId: `call-${step}`, messages: [] });
      calls += 1;
      const results = await Promise.all(conditions.map((c) => c({ steps: [] })));
      if (results.some(Boolean)) break;
    }
    return { text: `Called ${toolName} ${calls} times. Confidence: medium`, steps: [], usage: {} };
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(() => {
  runMigrations();
  registerDomain({
    name: "core",
    settingsKeys: [],
    tools: {
      restart_app: restartApp,
      restart_container: fakes.restartContainer as unknown as Tool,
      cleanup_docker: fakes.cleanupDocker as unknown as Tool,
    },
    tiers: { restart_app: "modify", restart_container: "modify", cleanup_docker: "destructive" },
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  setSetting("security_mode", "cautious");
  setSetting("anthropic_key", "sk-ant-test");
  m.restartExecutions.length = 0;
  m.cleanupExecutions = 0;
  m.createAnthropic.mockImplementation(() => (model: string) => ({ model }));
  __resetEscalationsForTests();
});

// ── 1. Actor bridge ──────────────────────────────────────────────────────────

describe("actor bridge", () => {
  it("keeps runWithActor/currentActor working and lets the innermost context win", async () => {
    expect(currentActor()).toBe("system");
    const actor: Actor = { kind: "automation", id: "a-x", label: "Automation: X" };
    await withExecutionContext(actor, "automation", async () => {
      expect(currentActor()).toBe("automation:a-x (Automation: X)");
      await runWithActor("user:explicit", async () => {
        expect(currentActor()).toBe("user:explicit");
      });
    });
    await runWithActor("automation:legacy", async () => {
      // executeTool runs the tool as its own actor
      const r = await executeTool({ actor: sessionChatActor("u-9", "zoe", "admin"), source: "chat", toolName: "restart_app", args: { appId: "bridge-app" } });
      expect(r.outcome).toBe("success");
    });
    expect(lastOperation("bridge-app")?.actor).toBe("user:u-9 (zoe (chat))");
  });

  it("chat: a gated tool called outside the request context still journals the session user", async () => {
    const gated = withExecutionContext(sessionChatActor("u-alice", "alice", "admin"), "chat", () =>
      gateToolExecution(restartApp, "restart_app", "modify", "cautious"),
    );
    // The AI SDK calls execute later, from the stream consumer's async context.
    const out = (await (gated as { execute: ExecFn }).execute({ appId: "chat-app" }, { toolCallId: "t1", messages: [] })) as { actor: string };
    expect(out.actor).toBe("user:u-alice (alice (chat))");
    expect(lastOperation("chat-app")?.actor).toBe("user:u-alice (alice (chat))");
    const [audit] = auditFor("restart_app").filter((a) => a.actorId === "u-alice");
    expect(audit).toMatchObject({ actorKind: "user", actorId: "u-alice", source: "chat", outcome: "success" });
  });

  it("MCP token: the call and the app operation it starts are attributed to the token", async () => {
    const actor: Actor = {
      kind: "mcp_token",
      id: "tok-wire",
      label: 'MCP token "Cursor"',
      scopes: { maxTier: "destructive", domains: "all", apps: "all" },
    };
    const session = createMcpSession(actor);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "wire-test", version: "1.0.0" });
    await session.server.connect(serverTransport);
    await client.connect(clientTransport);

    const res = await client.callTool({ name: "restart_app", arguments: { appId: "mcp-app" } });
    expect(res.isError).toBeFalsy();
    expect(lastOperation("mcp-app")?.actor).toBe('mcp_token:tok-wire (MCP token "Cursor")');
    const [audit] = auditFor("restart_app").filter((a) => a.actorId === "tok-wire");
    expect(audit).toMatchObject({ actorKind: "mcp_token", source: "mcp", outcome: "success" });
    await client.close();
  });

  it("automation: tool steps run through executeTool as the automation", async () => {
    addAutomation("wa1", "Nightly restart", [
      { id: "s1", type: "tool_action", toolName: "restart_app", args: { appId: "auto-app" }, approvalPolicy: "auto" },
    ]);
    const [result] = await fireTrigger("wire_wa1");
    expect(result.success).toBe(true);
    expect(lastOperation("auto-app")?.actor).toBe("automation:wa1 (Automation: Nightly restart)");
    const [audit] = auditFor("restart_app").filter((a) => a.actorId === "wa1");
    expect(audit).toMatchObject({ actorKind: "automation", source: "automation", outcome: "success" });
  });

  it("automation: ai_prompt steps run as the automation id (not its name)", async () => {
    addAutomation("wa2", "AI check", [
      { id: "s1", type: "ai_prompt", promptTemplate: "Check things", allowedTools: [], approvalPolicy: "auto" },
    ]);
    const [result] = await fireTrigger("wire_wa2");
    expect(result.success).toBe(true);
    expect(m.runAutomationPrompt).toHaveBeenCalledWith(expect.objectContaining({ automationId: "wa2", automationName: "AI check" }));
  });

  it("agent loop: remediation tool calls are journaled and audited as agent_loop", async () => {
    m.generateText.mockImplementation(async (opts: { tools: Record<string, { execute?: ExecFn }> }) => {
      await opts.tools.restart_container?.execute?.({ containerId: "loop-app" }, { toolCallId: "c1", messages: [] });
      return { text: "Restarted. Confidence: high", steps: [], usage: {} };
    });
    const event = makeEvent({ source: "loop-app" });
    const result = await remediateEvent(event, { eventId: event.id, verdict: "act", reason: "down" }, 10, true);
    expect(result.outcome).toBe("pending_verification");
    expect(lastOperation("loop-app")?.actor).toBe(`agent_loop:remediation (${REMEDIATION_ACTOR.label})`);
    const [audit] = auditFor("restart_container").filter((a) => a.actorKind === "agent_loop");
    expect(audit).toMatchObject({ actorId: "remediation", source: "agent_loop", outcome: "success" });
  });
});

// ── 2. Automations and approvals ─────────────────────────────────────────────

describe("automation approvals", () => {
  it("require_approval ends as blocked_approval with a linked notification; a re-run consumes the approval", async () => {
    addAutomation("wa3", "Guarded restart", [
      { id: "s1", type: "tool_action", toolName: "restart_app", args: { appId: "guarded-app" }, approvalPolicy: "require_approval" },
    ]);

    const [first] = await fireTrigger("wire_wa3");
    expect(first.success).toBe(false);
    expect(first.approvalRequired?.approvalId).toMatch(/^apr_/);
    const approvalId = first.approvalRequired!.approvalId;
    expect(m.restartExecutions).not.toContain("guarded-app");

    const [run] = runsFor("wa3");
    expect(run.status).toBe("blocked_approval");
    expect(run.finishedAt).toBeTruthy(); // the run did not hang
    expect(stepRows(run.id).map((r) => r.status)).toEqual(["blocked_approval"]);
    expect(stepRows(run.id)[0].error).toContain(approvalLink(approvalId));

    const note = db.select().from(schema.notifications).where(eq(schema.notifications.sourceId, `approval:${approvalId}`)).get();
    expect(note?.link).toBe(`/dashboard/settings/approvals?id=${approvalId}`);
    // No generic "failed" notification on top of the approval request
    const failed = db.select().from(schema.notifications).where(eq(schema.notifications.title, 'Automation "Guarded restart" failed')).get();
    expect(failed).toBeUndefined();

    // A second unattended run while pending: same approval, no new notification, still blocked
    const [second] = await fireTrigger("wire_wa3");
    expect(second.approvalRequired?.approvalId).toBe(approvalId);
    expect(db.select().from(schema.notifications).where(eq(schema.notifications.sourceId, `approval:${approvalId}`)).all()).toHaveLength(1);

    // Owner approves; the manual re-run consumes it and the step executes once.
    expect(decideApproval(approvalId, "approved", "admin").ok).toBe(true);
    const [third] = await fireTrigger("wire_wa3", { automationId: "wa3", manual: true });
    expect(third.success).toBe(true);
    expect(m.restartExecutions.filter((a) => a === "guarded-app")).toHaveLength(1);
    expect(getApproval(approvalId)?.status).toBe("consumed");
    expect(lastOperation("guarded-app")?.actor).toBe("automation:wa3 (Automation: Guarded restart)");

    // Single use: the next run asks again.
    const [fourth] = await fireTrigger("wire_wa3");
    expect(fourth.success).toBe(false);
    expect(fourth.approvalRequired?.approvalId).not.toBe(approvalId);
  });

  it("locked mode blocks an automation tool step outright (blocked, not blocked_approval)", async () => {
    setSetting("security_mode", "locked");
    addAutomation("wa4", "Locked restart", [
      { id: "s1", type: "tool_action", toolName: "restart_app", args: { appId: "locked-app" }, approvalPolicy: "auto" },
    ]);
    const [result] = await fireTrigger("wire_wa4");
    expect(result.success).toBe(false);
    expect(result.approvalRequired).toBeUndefined();
    const [run] = runsFor("wa4");
    expect(run.status).toBe("failed");
    expect(stepRows(run.id).map((r) => r.status)).toEqual(["blocked"]);
    expect(m.restartExecutions).not.toContain("locked-app");
  });

  it("ai_prompt with require_approval is approval-gated and never runs the model unapproved", async () => {
    addAutomation("wa5", "Guarded AI", [
      { id: "s1", type: "ai_prompt", promptTemplate: "Summarize {{x}}", allowedTools: [], approvalPolicy: "require_approval" },
    ]);
    const [result] = await fireTrigger("wire_wa5");
    expect(result.success).toBe(false);
    expect(result.approvalRequired).toBeDefined();
    expect(m.runAutomationPrompt).not.toHaveBeenCalled();
    expect(getApproval(result.approvalRequired!.approvalId)?.tool).toBe("automation_ai_prompt");
  });

  it("an ai_prompt whose model hits approval_required ends blocked_approval", async () => {
    m.runAutomationPrompt.mockImplementationOnce(async (raw: unknown) => {
      const params = raw as { onApprovalRequired?: (a: unknown) => void };
      params.onApprovalRequired?.({
        status: "approval_required",
        approvalId: "apr_inner",
        approvalStatus: "pending",
        tool: "cleanup_docker",
        summary: "Automation wants to prune.",
        expiresAt: "2099-01-01T00:00:00.000Z",
        approveUrl: approvalLink("apr_inner"),
        instructions: "approve",
      });
      return "Pruning needs approval.";
    });
    addAutomation("wa6", "AI prune", [
      { id: "s1", type: "ai_prompt", promptTemplate: "Free space", allowedTools: [], approvalPolicy: "auto" },
    ]);
    const [result] = await fireTrigger("wire_wa6");
    expect(result.success).toBe(false);
    expect(result.approvalRequired?.approvalId).toBe("apr_inner");
    const [run] = runsFor("wa6");
    expect(stepRows(run.id).map((r) => r.status)).toEqual(["blocked_approval"]);
  });
});

// ── 3. Remediation never loops on approval_required ─────────────────────────

describe("remediation escalation", () => {
  it("escalates once, stops the model, and holds the source while the approval is pending", async () => {
    m.generateText.mockImplementation(modelCalling("cleanup_docker", { dryRun: false }));
    const event = makeEvent({ type: "disk_trend", source: "disk:/wire", data: { mountPath: "/" } });

    const result = await remediateEvent(event, { eventId: event.id, verdict: "act", reason: "disk full" }, 10, true);
    expect(m.cleanupExecutions).toBe(0);
    expect(result.action).toBe("Awaiting approval");
    expect(result.outcome).toBe("pending"); // nothing ran — nothing to verify as a fix
    // The fake model was stopped after the first call
    const text = (await m.generateText.mock.results[0].value) as { text: string };
    expect(text.text).toContain("Called cleanup_docker 1 times");

    const approvals = db.select().from(schema.approvals).where(eq(schema.approvals.actorKind, "agent_loop")).all();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ actorId: "remediation", tool: "cleanup_docker", status: "pending" });
    const escalation = db.select().from(schema.notifications).where(eq(schema.notifications.title, "Agent needs approval: disk:/wire")).get();
    expect(escalation?.link).toBe(approvalLink(approvals[0].id));

    // Next cycle: no model call, no new approval
    m.generateText.mockClear();
    const again = await remediateEvent(makeEvent({ type: "disk_trend", source: "disk:/wire" }), { eventId: "x", verdict: "act", reason: "disk full" }, 10, true);
    expect(again.action).toBe("awaiting_approval");
    expect(m.generateText).not.toHaveBeenCalled();
    expect(db.select().from(schema.approvals).where(eq(schema.approvals.actorKind, "agent_loop")).all()).toHaveLength(1);

    // After the owner approves, the next run consumes it and the tool runs once.
    expect(decideApproval(approvals[0].id, "approved", "admin").ok).toBe(true);
    m.generateText.mockImplementation(modelCalling("cleanup_docker", { dryRun: false }));
    const approved = await remediateEvent(makeEvent({ type: "disk_trend", source: "disk:/wire" }), { eventId: "y", verdict: "act", reason: "disk full" }, 10, true);
    expect(m.cleanupExecutions).toBeGreaterThanOrEqual(1);
    expect(getApproval(approvals[0].id)?.status).toBe("consumed");
    expect(approved.outcome).toBe("pending_verification");
  });
});

// ── 4. Notification links ────────────────────────────────────────────────────

describe("notification link", () => {
  it("stores only in-app links and returns link on the API objects", async () => {
    expect(sanitizeNotificationLink("/dashboard/settings/approvals?id=apr_1")).toBe("/dashboard/settings/approvals?id=apr_1");
    expect(sanitizeNotificationLink("https://evil.example")).toBeNull();
    expect(sanitizeNotificationLink("//evil.example/x")).toBeNull();
    expect(sanitizeNotificationLink(undefined)).toBeNull();

    writeNotification("info", "Wire link test", "body", "wire-src", { link: "/dashboard/apps" });
    writeNotification("info", "Wire no link test", "body");

    const res = await notificationsRoute.request("/?limit=100");
    const rows = (await res.json()) as Array<{ title: string; link: string | null }>;
    expect(rows.find((r) => r.title === "Wire link test")?.link).toBe("/dashboard/apps");
    const plain = rows.find((r) => r.title === "Wire no link test");
    expect(plain).toBeDefined();
    expect(plain?.link).toBeNull();
  });

  it("recognizes approval_required results", () => {
    expect(isApprovalRequiredResult({ status: "approval_required", approvalId: "apr_1" })).toBe(true);
    expect(isApprovalRequiredResult({ status: "ok" })).toBe(false);
    expect(isApprovalRequiredResult(null)).toBe(false);
  });
});
