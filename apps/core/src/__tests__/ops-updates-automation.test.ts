import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// Per-file SQLite database — must be set before db/index.ts is imported.
vi.hoisted(() => {
  const tmp = process.env.TMPDIR ?? "/tmp";
  process.env.DATABASE_PATH = `${tmp.replace(/\/$/, "")}/talome-ops-automation-${process.pid}-${Date.now()}.db`;
});

const m = vi.hoisted(() => ({
  probeExecute: vi.fn(),
  failExecute: vi.fn(),
}));

vi.mock("../ai/agent.js", () => ({ runAutomationPrompt: vi.fn(async () => "ok") }));
vi.mock("../ai/automation-safe-tools.js", () => ({
  getAutomationSafeToolNames: () => new Set(["probe_tool", "fail_tool"]),
}));
vi.mock("../ai/tool-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ai/tool-registry.js")>()),
  getAllRegisteredTools: () => ({
    probe_tool: { execute: m.probeExecute },
    fail_tool: { execute: m.failExecute },
  }),
}));
vi.mock("../approval/engine.js", () => ({ requiresApproval: () => false }));
vi.mock("../docker/client.js", () => ({ restartContainer: vi.fn(async () => {}) }));
vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

import { eq, asc } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import {
  fireTrigger,
  runSteps,
  createRunJournal,
  markInterruptedAutomationRuns,
  stepIdempotencyKey,
  type AutomationStep,
} from "../automation/engine.js";
import { currentActor } from "../ops/operations.js";
import { executedStepRuns } from "../automation/step-run-view.js";
import { automations as automationsRoute } from "../routes/automations.js";

function stepRows(runId: string) {
  return db
    .select()
    .from(schema.automationStepRuns)
    .where(eq(schema.automationStepRuns.runId, runId))
    .orderBy(asc(schema.automationStepRuns.stepIndex))
    .all();
}

function addAutomation(id: string, steps: AutomationStep[]) {
  db.insert(schema.automations).values({
    id,
    name: `Auto ${id}`,
    enabled: true,
    trigger: JSON.stringify({ type: "test_trigger" }),
    actions: "[]",
    workflowVersion: 2,
    steps: JSON.stringify(steps),
    createdAt: new Date().toISOString(),
  }).run();
}

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  vi.clearAllMocks();
  db.delete(schema.automationStepRuns).run();
  db.delete(schema.automationRuns).run();
  db.delete(schema.automations).run();
});

describe("automation run durability", () => {
  it("persists the run row and step rows BEFORE each step executes", async () => {
    const observed: { runStatus?: string | null; stepStatuses?: (string | null)[]; actor?: string } = {};
    m.probeExecute.mockImplementation(async () => {
      const run = db.select().from(schema.automationRuns).get();
      observed.runStatus = run?.status;
      observed.stepStatuses = run ? stepRows(run.id).map((r) => r.status) : [];
      observed.actor = currentActor();
      return "probed";
    });

    addAutomation("a1", [
      { id: "s1", type: "notify", level: "info", title: "hello" },
      { id: "s2", type: "tool_action", toolName: "probe_tool", approvalPolicy: "auto" },
      { id: "s3", type: "notify", level: "info", title: "bye" },
    ]);

    const [result] = await fireTrigger("test_trigger");
    expect(result.success).toBe(true);

    // While step 2 ran: run row "running", step 1 done, step 2 running, step 3 pending
    expect(observed.runStatus).toBe("running");
    expect(observed.stepStatuses).toEqual(["succeeded", "running", "pending"]);
    // App operations started from automations are attributed to them
    expect(observed.actor).toBe("automation:a1 (Automation: Auto a1)");

    const run = db.select().from(schema.automationRuns).get()!;
    expect(run.status).toBe("succeeded");
    expect(run.success).toBe(true);
    expect(run.finishedAt).toBeTruthy();
    expect(run.actionsRun).toBe(3);

    const rows = stepRows(run.id);
    expect(rows.map((r) => r.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(rows.map((r) => r.idempotencyKey)).toEqual([0, 1, 2].map((i) => stepIdempotencyKey(run.id, i)));
    expect(rows.every((r) => r.finishedAt)).toBe(true);
  });

  it("records failure and marks unexecuted steps skipped", async () => {
    m.failExecute.mockRejectedValue(new Error("tool exploded"));
    addAutomation("a2", [
      { id: "s1", type: "tool_action", toolName: "fail_tool", approvalPolicy: "auto" },
      { id: "s2", type: "notify", level: "info", title: "never" },
    ]);

    const [result] = await fireTrigger("test_trigger");
    expect(result.success).toBe(false);

    const run = db.select().from(schema.automationRuns).get()!;
    expect(run.status).toBe("failed");
    expect(run.error).toContain("tool exploded");
    expect(stepRows(run.id).map((r) => r.status)).toEqual(["failed", "skipped"]);
  });

  it("records blocked steps", async () => {
    addAutomation("a3", [
      { id: "s1", type: "tool_action", toolName: "probe_tool" }, // require_approval by default
    ]);
    await fireTrigger("test_trigger");
    const run = db.select().from(schema.automationRuns).get()!;
    // require_approval now requests a server-issued approval instead of dead-ending
    expect(stepRows(run.id).map((r) => r.status)).toEqual(["blocked_approval"]);
    expect(run.status).toBe("blocked_approval");
    expect(m.probeExecute).not.toHaveBeenCalled();
  });

  it("never executes a step twice under the same idempotency key", async () => {
    const runId = "run-idem";
    db.insert(schema.automations).values({
      id: "a4", name: "A4", trigger: "{}", actions: "[]", createdAt: new Date().toISOString(),
    }).run();
    db.insert(schema.automationRuns).values({
      id: runId, automationId: "a4", triggeredAt: new Date().toISOString(), status: "running",
    }).run();

    const steps: AutomationStep[] = [
      { id: "s1", type: "tool_action", toolName: "probe_tool", approvalPolicy: "auto" },
    ];
    m.probeExecute.mockResolvedValue("done");

    const journal1 = createRunJournal(runId, "a4", [{ stepId: "s1", stepType: "tool_action" }]);
    await runSteps(steps, { automationId: "a4", automationName: "A4", triggerType: "manual" }, journal1);
    expect(m.probeExecute).toHaveBeenCalledTimes(1);

    // Re-driving the same run must not repeat the side effect
    const journal2 = createRunJournal(runId, "a4", []);
    const again = await runSteps(steps, { automationId: "a4", automationName: "A4", triggerType: "manual" }, journal2);
    expect(m.probeExecute).toHaveBeenCalledTimes(1);
    expect(again.results[0].output).toContain("already executed");
  });

  it("marks runs left running at boot as interrupted (not re-run)", () => {
    db.insert(schema.automations).values({
      id: "a5", name: "A5", trigger: "{}", actions: "[]", createdAt: new Date().toISOString(),
    }).run();
    db.insert(schema.automationRuns).values({
      id: "r-running", automationId: "a5", triggeredAt: new Date().toISOString(), status: "running",
    }).run();
    db.insert(schema.automationRuns).values({
      id: "r-done", automationId: "a5", triggeredAt: new Date().toISOString(), status: "succeeded",
    }).run();
    const journal = createRunJournal("r-running", "a5", [
      { stepId: "s1", stepType: "notify" },
      { stepId: "s2", stepType: "notify" },
    ]);
    journal.beforeStep(0, "s1", "notify");

    expect(markInterruptedAutomationRuns()).toBe(1);

    const running = db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, "r-running")).get()!;
    expect(running.status).toBe("interrupted");
    expect(running.success).toBe(false);
    expect(running.error).toContain("Interrupted");
    const done = db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, "r-done")).get()!;
    expect(done.status).toBe("succeeded");
    expect(stepRows("r-running").map((r) => r.status)).toEqual(["interrupted", "skipped"]);
  });
});

describe("run history readers (legacy success-based view)", () => {
  it("lists executed steps only, in step order", () => {
    const rows = [
      { id: "c", status: "skipped", stepIndex: 2, startedAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", status: "failed", stepIndex: 1, startedAt: "2026-01-01T00:00:02.000Z" },
      { id: "a", status: "succeeded", stepIndex: 0, startedAt: "2026-01-01T00:00:01.000Z" },
      { id: "p", status: "pending", stepIndex: 3, startedAt: "2026-01-01T00:00:00.000Z" },
      { id: "legacy", status: null, stepIndex: null, startedAt: "2025-01-01T00:00:00.000Z" },
    ];
    expect(executedStepRuns(rows).map((r) => r.id)).toEqual(["a", "b", "legacy"]);
  });

  it("GET /:id/runs does not show never-executed steps as failures", async () => {
    m.failExecute.mockRejectedValue(new Error("tool exploded"));
    addAutomation("a6", [
      { id: "s1", type: "notify", level: "info", title: "first" },
      { id: "s2", type: "tool_action", toolName: "fail_tool", approvalPolicy: "auto" },
      { id: "s3", type: "notify", level: "info", title: "never" },
      { id: "s4", type: "notify", level: "info", title: "never either" },
    ]);
    await fireTrigger("test_trigger");

    const res = await automationsRoute.request("/a6/runs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: { stepRuns: { stepId: string; success: boolean }[] }[] };
    const steps = body.runs[0].stepRuns;
    expect(steps.map((s) => s.stepId)).toEqual(["s1", "s2"]);
    expect(steps.map((s) => s.success)).toEqual([true, false]);
  });
});
