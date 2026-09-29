/**
 * wire-backend review fixes:
 *  - Claude Code remediation runs as agent_loop:remediation; calls held for
 *    approval are escalations, not attempted fixes; the hold is persisted.
 *  - Approving an escalation runs the proposed call right away.
 *  - The hold survives an unanswered (expired) approval.
 *  - Automations written by an MCP token run under its grants.
 *  - Unattended approvals live 24h; cautious run_shell refuses non-allowlisted
 *    commands before issuing an approval.
 *  - ai_prompt steps resume after the owner approves the inner call.
 *  - Unattended agents (setup) go through executeTool; messaging bots act as
 *    the messaging user.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  const dir = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  process.env.DATABASE_PATH = `${dir}/talome-wire-backend-fixes-${process.pid}-${Date.now()}.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
});

const m = vi.hoisted(() => ({
  generateText: vi.fn(),
  createAnthropic: vi.fn(),
  runAutomationPrompt: vi.fn(async (_params: unknown) => "ok"),
  createChatStream: vi.fn(),
  isClaudeCodeAvailable: vi.fn(async () => false),
  spawnClaudeStreaming: vi.fn(),
  cleanupExecutions: [] as Array<Record<string, unknown>>,
  restartExecutions: [] as string[],
}));

vi.mock("../ai/agent.js", async () => {
  const registry = await import("../ai/tool-registry.js");
  return {
    getActiveDomainTools: () => registry.getActiveRegisteredTools(),
    runAutomationPrompt: m.runAutomationPrompt,
    createChatStream: m.createChatStream,
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
  isClaudeCodeAvailable: m.isClaudeCodeAvailable,
  spawnClaudeStreaming: m.spawnClaudeStreaming,
}));
vi.mock("../db/memories.js", () => ({ writeMemory: vi.fn() }));

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
import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { runWireBackendMigrations } from "../db/migrations/wire-backend.js";
import { registerDomain } from "../ai/tool-registry.js";
import { setSetting } from "../utils/settings.js";
import {
  executeTool,
  gateToolsForUnattendedActor,
  localStdioActor,
  agentLoopActor,
  type Actor,
} from "../ai/execution.js";
import { getExecutionContext } from "../ai/actor-context.js";
import {
  remediateEvent,
  escalationHold,
  resumeApprovedRemediation,
  extractToolCallInputsFromChunk,
  __resetEscalationsForTests,
} from "../agent-loop/remediation.js";
import {
  stdioActorFromEnv,
  MCP_ACTOR_ENV,
  REMEDIATION_ACTOR_HINT,
  REMEDIATION_DIAGNOSE_ACTOR_HINT,
} from "../agent-loop/remediation-actor.js";
import { decideApproval, getApproval, requestApproval, hashArgs, UNATTENDED_APPROVAL_TTL_MS } from "../approval/approvals.js";
import { approvals as approvalsRoute } from "../routes/approvals.js";
import { createAutomationTool } from "../ai/tools/automation-tools.js";
import { fireTrigger, type AutomationStep } from "../automation/engine.js";
import { routeMessage } from "../messaging/router.js";
import { allowSender } from "../messaging/allowlist.js";
import type { SystemEvent } from "../agent-loop/types.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

const restartApp = tool({
  description: "Restart an app (modify).",
  inputSchema: z.object({ appId: z.string() }),
  execute: async ({ appId }) => {
    m.restartExecutions.push(appId);
    return { success: true, appId };
  },
});
const setSettingFake = tool({
  description: "Write a setting.",
  inputSchema: z.object({ key: z.string(), value: z.string() }),
  execute: async ({ key }) => ({ success: true, key }),
});
const shellRuns: string[] = [];
const fakeShell = tool({
  description: "Run a shell command.",
  inputSchema: z.object({ command: z.string() }),
  execute: async ({ command }) => {
    shellRuns.push(command);
    return "ran";
  },
});

fakes.impl.cleanupDocker = async (args) => {
  m.cleanupExecutions.push(args);
  return { success: true, reclaimed: "1GB" };
};
fakes.impl.restartContainer = async (args) => {
  m.restartExecutions.push(String(args.containerId));
  return { success: true };
};

function makeEvent(overrides: Partial<SystemEvent> = {}): SystemEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type: "disk_trend",
    severity: "critical",
    source: "disk:/cc",
    message: "disk nearly full",
    data: { mountPath: "/" },
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

function addAutomation(id: string, name: string, steps: AutomationStep[], actorScopes: string | null = null) {
  db.insert(schema.automations).values({
    id,
    name,
    enabled: true,
    trigger: JSON.stringify({ type: `fix_${id}` }),
    actions: "[]",
    workflowVersion: 2,
    steps: JSON.stringify(steps),
    actorScopes,
    createdAt: new Date().toISOString(),
  }).run();
}

function runsFor(automationId: string) {
  return db
    .select()
    .from(schema.automationRuns)
    .where(eq(schema.automationRuns.automationId, automationId))
    .orderBy(desc(schema.automationRuns.triggeredAt))
    .all();
}

function notificationsFor(sourceId: string) {
  return db.select().from(schema.notifications).where(eq(schema.notifications.sourceId, sourceId)).all();
}

/** A fake Claude Code session: the stdio server it launches calls cleanup_docker once. */
function claudeCodeCalling(toolName: string, args: Record<string, unknown>, text = "Disk full. Confidence: medium") {
  return async (_task: string, _cwd: string, onData?: (chunk: string) => void, _abort?: AbortSignal, env?: Record<string, string>) => {
    const actor = stdioActorFromEnv(env ?? {}, localStdioActor());
    onData?.(`\n[mcp__talome__${toolName}] ${JSON.stringify(args)}\n`);
    await executeTool({ actor, source: "mcp", toolName, args });
    return { code: 0, stdout: text, stderr: "" };
  };
}

const adminApp = new Hono();
adminApp.use("*", async (c, next) => {
  c.set("sessionRole" as never, "admin" as never);
  await next();
});
adminApp.route("/", approvalsRoute);

beforeAll(() => {
  runMigrations();
  runWireBackendMigrations(); // idempotent: a second run is a no-op
  registerDomain({
    name: "core",
    settingsKeys: [],
    tools: {
      restart_app: restartApp,
      restart_container: fakes.restartContainer as unknown as Tool,
      cleanup_docker: fakes.cleanupDocker as unknown as Tool,
      set_setting: setSettingFake,
      run_shell: fakeShell,
    },
    tiers: {
      restart_app: "modify",
      restart_container: "modify",
      cleanup_docker: "destructive",
      set_setting: "modify",
      run_shell: "destructive",
    },
  });
  registerDomain({
    name: "automations",
    settingsKeys: [],
    tools: { create_automation: createAutomationTool as unknown as Tool },
    tiers: { create_automation: "modify" },
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  setSetting("security_mode", "cautious");
  setSetting("anthropic_key", "sk-ant-test");
  m.cleanupExecutions.length = 0;
  m.restartExecutions.length = 0;
  shellRuns.length = 0;
  m.isClaudeCodeAvailable.mockResolvedValue(false);
  m.createAnthropic.mockImplementation(() => (model: string) => ({ model }));
  __resetEscalationsForTests();
});

// ── Claude Code remediation path ─────────────────────────────────────────────

describe("Claude Code remediation", () => {
  it("honors only the exact actor hints", () => {
    const owner = localStdioActor();
    expect(stdioActorFromEnv({}, owner)).toBe(owner);
    expect(stdioActorFromEnv({ [MCP_ACTOR_ENV]: "agent_loop:other" }, owner)).toBe(owner);
    const acting = stdioActorFromEnv({ [MCP_ACTOR_ENV]: REMEDIATION_ACTOR_HINT }, owner);
    expect(acting).toMatchObject({ kind: "agent_loop", id: "remediation" });
    expect(acting.scopes?.maxTier).toBe("destructive");
    expect(acting.scopes?.tools).toContain("rollback_update");
    expect(acting.scopes?.tools).not.toContain("run_shell");
    expect(stdioActorFromEnv({ [MCP_ACTOR_ENV]: REMEDIATION_DIAGNOSE_ACTOR_HINT }, owner).scopes?.maxTier).toBe("read");
  });

  it("parses streamed tool inputs, tolerating truncated JSON", () => {
    expect(extractToolCallInputsFromChunk('\n[mcp__talome__restart_container] {"containerId":"sonarr"}\n')).toEqual([
      { name: "restart_container", input: { containerId: "sonarr" } },
    ]);
    expect(extractToolCallInputsFromChunk('\n[rollback_update] {"appId":"so\n')).toEqual([{ name: "rollback_update" }]);
  });

  it("a call held for approval is an escalation (not an attempted fix), held, and resumed on approval", async () => {
    m.isClaudeCodeAvailable.mockResolvedValue(true);
    m.spawnClaudeStreaming.mockImplementation(claudeCodeCalling("cleanup_docker", { dryRun: false }));
    const event = makeEvent();

    const result = await remediateEvent(event, { eventId: event.id, verdict: "act", reason: "disk full" }, 10, true);
    expect(m.spawnClaudeStreaming.mock.calls[0][4]).toEqual({ [MCP_ACTOR_ENV]: REMEDIATION_ACTOR_HINT });
    expect(m.cleanupExecutions).toHaveLength(0);
    expect(result.action).toBe("Awaiting approval");
    expect(result.outcome).toBe("pending");

    const approval = db.select().from(schema.approvals).where(eq(schema.approvals.actorKind, "agent_loop")).get();
    expect(approval).toMatchObject({ actorId: "remediation", tool: "cleanup_docker", status: "pending", source: "mcp" });
    // Exactly one notification for the decision, carrying the link.
    const notes = notificationsFor(`approval:${approval!.id}`);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("Agent needs approval: disk:/cc");
    expect(notes[0].link).toBe(`/dashboard/settings/approvals?id=${approval!.id}`);
    expect(db.select().from(schema.notifications).where(eq(schema.notifications.title, "Agent attempted fix: disk:/cc")).get()).toBeUndefined();

    // Not queued for verification, so it can never count as a failed attempt.
    const log = db.select().from(schema.remediationLog).where(eq(schema.remediationLog.eventId, event.id)).get();
    expect(log).toMatchObject({ outcome: "pending", action: "Awaiting approval" });
    expect(log?.verifiedAt).toBeTruthy();

    // Persisted hold: the next event does not re-invoke the model.
    const esc = db.select().from(schema.remediationEscalations).where(eq(schema.remediationEscalations.approvalId, approval!.id)).get();
    expect(esc).toMatchObject({ source: "disk:/cc", tool: "cleanup_docker", status: "open", args: JSON.stringify({ dryRun: false }) });
    m.spawnClaudeStreaming.mockClear();
    const again = await remediateEvent(makeEvent(), { eventId: "x", verdict: "act", reason: "disk full" }, 10, true);
    expect(again.action).toBe("awaiting_approval");
    expect(m.spawnClaudeStreaming).not.toHaveBeenCalled();

    // The owner approves in the dashboard: the proposed call runs right away.
    const res = await adminApp.request(`/${approval!.id}/approve`, { method: "POST" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(m.cleanupExecutions).toEqual([{ dryRun: false }]));
    await vi.waitFor(() => expect(getApproval(approval!.id)?.status).toBe("consumed"));
    await vi.waitFor(() =>
      expect(
        db.select().from(schema.remediationLog).where(and(eq(schema.remediationLog.eventId, event.id), eq(schema.remediationLog.outcome, "pending_verification"))).get(),
      ).toMatchObject({ model: "owner-approved" }),
    );
    expect(db.select().from(schema.notifications).where(eq(schema.notifications.title, "Agent applied approved fix: disk:/cc")).get()).toBeDefined();
    const audit = db.select().from(schema.auditLog).where(and(eq(schema.auditLog.toolName, "cleanup_docker"), eq(schema.auditLog.outcome, "success"))).all();
    expect(audit.at(-1)).toMatchObject({ actorKind: "agent_loop", actorId: "remediation", source: "agent_loop" });

    // Resuming twice runs nothing more; the hold is released.
    expect((await resumeApprovedRemediation(approval!.id)).ran).toBe(false);
    expect(m.cleanupExecutions).toHaveLength(1);
    expect(escalationHold("disk:/cc")).toBeNull();
  });

  it("a write that actually ran is an attempted fix", async () => {
    m.isClaudeCodeAvailable.mockResolvedValue(true);
    m.spawnClaudeStreaming.mockImplementation(claudeCodeCalling("restart_container", { containerId: "radarr" }, "Restarted. Confidence: high"));
    const event = makeEvent({ type: "container_down", source: "radarr", data: { containerName: "radarr" } });
    const result = await remediateEvent(event, { eventId: event.id, verdict: "act", reason: "down" }, 10, true);
    expect(m.restartExecutions).toEqual(["radarr"]);
    expect(result.outcome).toBe("pending_verification");
    expect(db.select().from(schema.notifications).where(eq(schema.notifications.title, "Agent attempted fix: radarr")).get()).toBeDefined();
  });

  it("diagnosis-only remediation launches the stdio server read-only", async () => {
    m.isClaudeCodeAvailable.mockResolvedValue(true);
    m.spawnClaudeStreaming.mockImplementation(claudeCodeCalling("restart_container", { containerId: "lidarr" }, "Diagnosed. Confidence: low"));
    const event = makeEvent({ type: "container_down", source: "lidarr", data: { containerName: "lidarr" } });
    const result = await remediateEvent(event, { eventId: event.id, verdict: "act", reason: "down" }, 10, false);
    expect(m.spawnClaudeStreaming.mock.calls[0][4]).toEqual({ [MCP_ACTOR_ENV]: REMEDIATION_DIAGNOSE_ACTOR_HINT });
    expect(m.restartExecutions).not.toContain("lidarr");
    expect(result.outcome).toBe("pending");
  });
});

// ── Escalation hold ──────────────────────────────────────────────────────────

describe("escalation hold", () => {
  it("API path: one notification per escalation; the hold outlasts an unanswered approval", async () => {
    m.generateText.mockImplementation(async (opts: { tools: Record<string, { execute?: (a: unknown, o: unknown) => Promise<unknown> }> }) => {
      await opts.tools.cleanup_docker?.execute?.({ dryRun: true }, { toolCallId: "c1", messages: [] });
      return { text: "Needs a prune. Confidence: medium", steps: [], usage: {} };
    });
    const event = makeEvent({ source: "disk:/api" });
    await remediateEvent(event, { eventId: event.id, verdict: "act", reason: "disk full" }, 10, true);
    const approval = db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.actorKind, "agent_loop"), eq(schema.approvals.source, "agent_loop")))
      .orderBy(desc(schema.approvals.createdAt))
      .get()!;
    expect(notificationsFor(`approval:${approval.id}`)).toHaveLength(1);
    // Unattended requests stay open for a day.
    expect(Date.parse(approval.expiresAt) - Date.now()).toBeGreaterThan(UNATTENDED_APPROVAL_TTL_MS - 60_000);

    // The owner never answers: the request expires, and the source stays held for a while.
    const expiredAt = Date.now() - 1000;
    db.update(schema.approvals).set({ expiresAt: new Date(expiredAt).toISOString() }).where(eq(schema.approvals.id, approval.id)).run();
    expect(escalationHold("disk:/api")).toBe("the approval request expired unanswered");
    expect(escalationHold("disk:/api", expiredAt + 5 * 60 * 60 * 1000)).toBeNull();
  });

  it("denied: held for the retry window", async () => {
    m.generateText.mockImplementation(async (opts: { tools: Record<string, { execute?: (a: unknown, o: unknown) => Promise<unknown> }> }) => {
      await opts.tools.cleanup_docker?.execute?.({ dryRun: false, all: true }, { toolCallId: "c1", messages: [] });
      return { text: "Confidence: low", steps: [], usage: {} };
    });
    const event = makeEvent({ source: "disk:/deny" });
    await remediateEvent(event, { eventId: event.id, verdict: "act", reason: "disk full" }, 10, true);
    const esc = db.select().from(schema.remediationEscalations).where(eq(schema.remediationEscalations.source, "disk:/deny")).get()!;
    expect(decideApproval(esc.approvalId, "denied", "admin").ok).toBe(true);
    expect(escalationHold("disk:/deny")).toBe("the owner denied the proposed action");
    expect((await resumeApprovedRemediation(esc.approvalId)).ran).toBe(false);
  });
});

// ── Automations ──────────────────────────────────────────────────────────────

describe("automation grants", () => {
  it("an automation an MCP token creates runs under the token's grants", async () => {
    const token: Actor = {
      kind: "mcp_token",
      id: "tok-narrow",
      label: 'MCP token "Narrow"',
      scopes: { maxTier: "modify", domains: ["automations"], apps: "all" },
    };
    // The token exists (each run re-checks the token that wrote the automation).
    db.insert(schema.mcpTokens).values({ id: token.id, name: "Narrow", tokenHash: "hash-tok-narrow", scopes: JSON.stringify(token.scopes) }).run();
    const created = await executeTool({
      actor: token,
      source: "mcp",
      toolName: "create_automation",
      args: {
        name: "Sneaky restart",
        enabled: true,
        trigger: { type: "schedule", cron: "0 * * * *" },
        steps: [{ id: "s1", type: "tool_action", toolName: "restart_app", args: { appId: "victim" }, approvalPolicy: "auto" }],
      },
    });
    expect(created.outcome).toBe("success");
    const id = (created.result as { id: string }).id;
    const row = db.select().from(schema.automations).where(eq(schema.automations.id, id)).get();
    expect(JSON.parse(row!.actorScopes!)).toEqual(token.scopes);

    const [result] = await fireTrigger("schedule", { automationId: id, manual: true });
    expect(result.success).toBe(false);
    expect(result.results[0].error).toContain("'core' tool domain");
    expect(m.restartExecutions).not.toContain("victim");

    // The same step written by the owner runs.
    addAutomation("owner-a", "Owner restart", [
      { id: "s1", type: "tool_action", toolName: "restart_app", args: { appId: "ok-app" }, approvalPolicy: "auto" },
    ]);
    const [owner] = await fireTrigger("fix_owner-a");
    expect(owner.success).toBe(true);
    expect(m.restartExecutions).toContain("ok-app");
  });

  it("an ai_prompt model's tools run as the scoped automation actor", async () => {
    const scopes = { maxTier: "read" as const, domains: "all" as const, apps: "all" as const };
    addAutomation("scoped-ai", "Scoped AI", [
      { id: "s1", type: "ai_prompt", promptTemplate: "Look", allowedTools: [], approvalPolicy: "auto" },
    ], JSON.stringify(scopes));
    await fireTrigger("fix_scoped-ai");
    const params = m.runAutomationPrompt.mock.calls[0][0] as { actor?: Actor };
    expect(params.actor).toMatchObject({ kind: "automation", id: "scoped-ai", scopes });
  });

  it("ai_prompt resumes after the owner approves the inner call, without a new prompt approval", async () => {
    addAutomation("ai-resume", "AI resume", [
      { id: "s1", type: "ai_prompt", promptTemplate: "Free space", allowedTools: [], approvalPolicy: "require_approval" },
    ]);
    const [first] = await fireTrigger("fix_ai-resume");
    const outerId = first.approvalRequired!.approvalId;
    expect(getApproval(outerId)?.tool).toBe("automation_ai_prompt");
    expect(decideApproval(outerId, "approved", "admin").ok).toBe(true);

    // The model stops at a destructive call that needs its own approval.
    const actor = { kind: "automation", id: "ai-resume", label: "Automation: AI resume" };
    const inner = requestApproval({
      actor,
      source: "automation",
      tool: "cleanup_docker",
      argsHash: hashArgs({ all: true }),
      argsPreview: "{}",
      summary: "prune",
    }).approval;
    m.runAutomationPrompt.mockImplementationOnce(async (raw: unknown) => {
      (raw as { onApprovalRequired?: (a: unknown) => void }).onApprovalRequired?.({
        status: "approval_required",
        approvalId: inner.id,
        approvalStatus: "pending",
        tool: "cleanup_docker",
        summary: "prune",
        expiresAt: inner.expiresAt,
        approveUrl: `/dashboard/settings/approvals?id=${inner.id}`,
        instructions: "approve",
      });
      return "Needs approval.";
    });
    const [second] = await fireTrigger("fix_ai-resume");
    expect(second.approvalRequired?.approvalId).toBe(inner.id);
    expect(getApproval(outerId)?.status).toBe("consumed");

    // Owner approves the inner call only; the re-run goes straight to the model.
    expect(decideApproval(inner.id, "approved", "admin").ok).toBe(true);
    m.runAutomationPrompt.mockClear();
    const [third] = await fireTrigger("fix_ai-resume");
    expect(third.success).toBe(true);
    expect(m.runAutomationPrompt).toHaveBeenCalledTimes(1);
    const outerRequests = db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.actorId, "ai-resume"), eq(schema.approvals.tool, "automation_ai_prompt")))
      .all();
    expect(outerRequests).toHaveLength(1);
    expect(runsFor("ai-resume")[0].status).toBe("succeeded");
  });
});

// ── Execution service ────────────────────────────────────────────────────────

describe("execution service", () => {
  it("cautious run_shell refuses non-allowlisted commands before issuing an approval", async () => {
    const owner = localStdioActor();
    const before = db.select().from(schema.approvals).where(eq(schema.approvals.tool, "run_shell")).all().length;
    const r = await executeTool({ actor: owner, source: "mcp", toolName: "run_shell", args: { command: "docker ps" } });
    expect(r.outcome).toBe("blocked");
    expect(r.error?.message).toContain("not in the allowed command list");
    expect(db.select().from(schema.approvals).where(eq(schema.approvals.tool, "run_shell")).all()).toHaveLength(before);
    expect(shellRuns).toHaveLength(0);

    const allowed = await executeTool({ actor: owner, source: "mcp", toolName: "run_shell", args: { command: "tar czf /tmp/x.tgz /tmp/y" } });
    expect(allowed.outcome).toBe("approval_required");
  });

  it("unattended agents (setup) run through executeTool and stop on approval_required", async () => {
    const setup = agentLoopActor("setup", "Setup agent");
    const held: string[] = [];
    const tools = gateToolsForUnattendedActor({ set_setting: setSettingFake }, setup, "agent_loop", {
      onApprovalRequired: (a) => held.push(a.approvalId),
    });
    const exec = (tools.set_setting as { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute;
    const out = await exec({ key: "security_mode", value: "permissive" }, { toolCallId: "t", messages: [] });
    expect(out.status).toBe("approval_required");
    expect(held).toHaveLength(1);
    const approval = getApproval(held[0]);
    expect(approval).toMatchObject({ actorKind: "agent_loop", actorId: "setup", tool: "set_setting" });
    // The agent loop escalates itself: no execution-service notification.
    expect(notificationsFor(`approval:${held[0]}`)).toHaveLength(0);

    const plain = await exec({ key: "sonarr_url_note", value: "x" }, { toolCallId: "t2", messages: [] });
    expect(plain).toMatchObject({ success: true });
    const audit = db.select().from(schema.auditLog).where(eq(schema.auditLog.toolName, "set_setting")).orderBy(desc(schema.auditLog.id)).get();
    expect(audit).toMatchObject({ actorKind: "agent_loop", actorId: "setup", source: "agent_loop" });
  });

  it("messaging bots act as the messaging user", async () => {
    let seen: ReturnType<typeof getExecutionContext>;
    m.createChatStream.mockImplementation(async () => {
      seen = getExecutionContext();
      return {
        textStream: (async function* () {
          yield "hi";
        })(),
      };
    });
    // The bots answer only senders the owner allowed (messaging/allowlist.ts).
    allowSender("telegram", "4242", "Tom");
    const reply = await routeMessage({ platform: "telegram", externalId: "4242", text: "status?", senderName: "Tom" });
    expect(reply).toBe("hi");
    expect(seen?.actor).toMatchObject({ kind: "user", id: "telegram:4242", label: "Tom (telegram)" });
    expect(seen?.source).toBe("chat");
  });
});
