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
vi.mock("../ai/tool-registry.js", () => ({
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
    expect(observed.actor).toBe("automation:a1");

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
    expect(stepRows(run.id).map((r) => r.status)).toEqual(["blocked"]);
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
    expect(stepRows("r-running").map((r) => r.status)).toEqual(["interrupted", "interrupted"]);
  });
});
