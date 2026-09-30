import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A real SQLite file — must be set before db/index.js loads.
const tempDir = mkdtempSync(join(tmpdir(), "talome-durable-runs-"));
process.env.DATABASE_PATH = join(tempDir, "talome.db");
process.env.TALOME_SECRET = "d".repeat(64);

// Fake side effects for two real, automation-safe tools: restart_app (modify) and list_containers (read)
const calls = vi.hoisted(() => ({ restart: 0, list: 0, hangRestart: false, hangList: false }));
const never = () => new Promise<never>(() => {});
vi.mock("../ai/tool-registry.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../ai/tool-registry.js")>();
  return {
    ...real,
    getAllRegisteredTools: () => ({
      ...real.getAllRegisteredTools(),
      restart_app: { execute: async () => { calls.restart++; if (calls.hangRestart) await never(); return { success: true }; } },
      list_containers: { execute: async () => { calls.list++; if (calls.hangList) await never(); return { success: true, containers: [] }; } },
    }),
  };
});
vi.mock("../docker/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../docker/client.js")>()),
  restartContainer: vi.fn(async () => { calls.restart++; }),
}));

type Engine = typeof import("../automation/engine.js");
type Store = typeof import("../automation/run-store.js");
let engine: Engine;
let store: Store;
let db: typeof import("../db/index.js")["db"];
let schema: typeof import("../db/index.js")["schema"];
let setSetting: typeof import("../utils/settings.js")["setSetting"];
let eq: typeof import("drizzle-orm")["eq"];

const STEPS = [
  { id: "s0", type: "notify", level: "info", title: "Starting" },
  { id: "s1", type: "tool_action", toolName: "restart_app", args: { appId: "jellyfin" }, approvalPolicy: "auto" },
  { id: "s2", type: "tool_action", toolName: "list_containers", args: {}, approvalPolicy: "auto" },
];

function addAutomation(id: string, steps: unknown[] = STEPS) {
  db.insert(schema.automations)
    .values({
      id,
      name: `Automation ${id}`,
      enabled: true,
      trigger: JSON.stringify({ type: "manual" }),
      conditions: "[]",
      actions: "[]",
      workflowVersion: 2,
      steps: JSON.stringify(steps),
    } as typeof schema.automations.$inferInsert)
    .run();
}

function runsOf(automationId: string) {
  return db.select().from(schema.automationRuns).where(eq(schema.automationRuns.automationId, automationId)).all();
}

/** Simulate the executing process dying: its lease lapses and nobody renews it. */
function expireLease(runId: string) {
  db.update(schema.automationRuns)
    .set({ leaseExpiresAt: new Date(Date.now() - 1000).toISOString(), leaseOwner: "dead-process" })
    .where(eq(schema.automationRuns.id, runId))
    .run();
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeAll(async () => {
  ({ db, schema } = await import("../db/index.js"));
  const { runMigrations } = await import("../db/migrate.js");
  runMigrations();
  ({ eq } = await import("drizzle-orm"));
  ({ setSetting } = await import("../utils/settings.js"));
  engine = await import("../automation/engine.js");
  store = await import("../automation/run-store.js");
});

beforeEach(() => {
  calls.restart = 0;
  calls.list = 0;
  calls.hangRestart = false;
  calls.hangList = false;
  db.delete(schema.automationStepRuns).run();
  db.delete(schema.automationRuns).run();
  db.delete(schema.automations).run();
  db.delete(schema.toolApprovals).run();
  setSetting("security_mode", "cautious");
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("durable automation runs", () => {
  it("records the run and every step transition", async () => {
    addAutomation("a1");
    const [result] = await engine.fireTrigger("manual", { automationId: "a1", manual: true });

    expect(result.success).toBe(true);
    const [run] = runsOf("a1");
    expect(run).toMatchObject({ status: "succeeded", success: true, actionsRun: 3, leaseOwner: null });
    const steps = store.getStepRuns(run.id);
    expect(steps.map((s) => [s.stepIndex, s.status])).toEqual([[0, "succeeded"], [1, "succeeded"], [2, "succeeded"]]);
    expect(calls.restart).toBe(1);
  });

  it("records a step as running before its side effect happens", async () => {
    addAutomation("a2");
    calls.hangRestart = true;
    void engine.fireTrigger("manual", { automationId: "a2", manual: true });
    await waitFor(() => calls.restart === 1);

    const [run] = runsOf("a2");
    expect(run.status).toBe("running");
    const steps = store.getStepRuns(run.id);
    expect(steps.at(-1)).toMatchObject({ stepIndex: 1, status: "running" });
  });

  it("never repeats a step with side effects that was interrupted mid-flight", async () => {
    addAutomation("a3");
    calls.hangRestart = true;
    void engine.fireTrigger("manual", { automationId: "a3", manual: true });
    await waitFor(() => calls.restart === 1);
    const [running] = runsOf("a3");

    expireLease(running.id); // the worker died during restart_app
    calls.hangRestart = false;
    const report = await engine.reconcileAutomationRuns();

    expect(report.interrupted).toEqual([running.id]);
    expect(calls.restart).toBe(1); // not repeated
    expect(calls.list).toBe(0); // later steps not run
    const [run] = runsOf("a3");
    expect(run.status).toBe("interrupted");
    expect(run.error).toContain("was not repeated");
    expect(store.getStepRuns(run.id).find((s) => s.stepIndex === 1)?.status).toBe("unknown");
    const notes = db.select().from(schema.notifications).all();
    expect(notes.some((n) => n.title === 'Automation "Automation a3" was interrupted')).toBe(true);
  });

  it("repeats an interrupted read-only step and finishes the run", async () => {
    addAutomation("a4");
    calls.hangList = true;
    void engine.fireTrigger("manual", { automationId: "a4", manual: true });
    await waitFor(() => calls.list === 1);
    const [running] = runsOf("a4");

    expireLease(running.id);
    calls.hangList = false;
    const report = await engine.reconcileAutomationRuns();

    expect(report.resumed).toEqual([running.id]);
    expect(calls.restart).toBe(1); // the completed modify step was not repeated
    expect(calls.list).toBe(2); // the read step ran again
    const [run] = runsOf("a4");
    expect(run.status).toBe("succeeded");
    expect(store.getStepRuns(run.id).map((s) => s.status)).toEqual(["succeeded", "succeeded", "retried", "succeeded"]);
  });

  it.each([0, 1, 2, 3])("resumes after a crash at step boundary %i without repeating completed steps", async (boundary) => {
    addAutomation(`b${boundary}`);
    // State a worker leaves when it dies right after finishing `boundary` steps
    const runId = store.createRun({ automationId: `b${boundary}`, workflowVersion: 2, triggerType: "manual", triggerData: {}, steps: STEPS });
    for (let i = 0; i < boundary; i++) {
      const stepRunId = store.beginStep(runId, `b${boundary}`, i, STEPS[i].id, STEPS[i].type);
      store.finishStep(stepRunId, { success: true, durationMs: 1 });
    }
    store.saveContext(runId, {}, boundary);
    expireLease(runId);

    await engine.reconcileAutomationRuns();

    expect(calls.restart).toBe(boundary <= 1 ? 1 : 0);
    expect(calls.list).toBe(boundary <= 2 ? 1 : 0);
    const run = store.getRun(runId)!;
    expect(run.status).toBe("succeeded");
    expect(run.actionsRun).toBe(3);
    expect(store.getStepRuns(runId).map((s) => s.stepIndex)).toEqual([0, 1, 2]);
  });

  it("does not take over a run whose lease is still live", async () => {
    addAutomation("a5");
    calls.hangRestart = true;
    void engine.fireTrigger("manual", { automationId: "a5", manual: true });
    await waitFor(() => calls.restart === 1);

    const report = await engine.reconcileAutomationRuns();
    expect(report.resumed).toEqual([]);
    expect(report.interrupted).toEqual([]);
    expect(runsOf("a5")[0].status).toBe("running");
  });

  it("skips an overlapping trigger while a run is in progress", async () => {
    addAutomation("a6");
    calls.hangRestart = true;
    void engine.fireTrigger("manual", { automationId: "a6", manual: true });
    await waitFor(() => calls.restart === 1);

    const second = await engine.fireTrigger("manual", { automationId: "a6", manual: true });
    expect(second).toEqual([]);
    expect(runsOf("a6")).toHaveLength(1);
  });

  it("gives up on a run that keeps getting interrupted", async () => {
    addAutomation("a7");
    const runId = store.createRun({ automationId: "a7", workflowVersion: 2, triggerType: "manual", triggerData: {}, steps: STEPS });
    db.update(schema.automationRuns).set({ resumeCount: store.MAX_RESUMES }).where(eq(schema.automationRuns.id, runId)).run();
    expireLease(runId);

    await engine.reconcileAutomationRuns();
    expect(store.getRun(runId)?.status).toBe("interrupted");
    expect(calls.restart).toBe(0);
  });
});

describe("approval-gated steps", () => {
  const gated = [
    { id: "g0", type: "notify", level: "info", title: "Before" },
    { id: "g1", type: "tool_action", toolName: "restart_app", args: { appId: "sonarr" }, approvalPolicy: "require_approval" },
    { id: "g2", type: "tool_action", toolName: "list_containers", args: {}, approvalPolicy: "auto" },
  ];

  it("waits for approval, then resumes from the gated step exactly once", async () => {
    addAutomation("g", gated);
    const [first] = await engine.fireTrigger("manual", { automationId: "g", manual: true });
    expect(first.success).toBe(false);
    const [run] = runsOf("g");
    expect(run.status).toBe("waiting_approval");
    expect(calls.restart).toBe(0);

    const { listApprovals, decideApproval } = await import("../approval/tool-approvals.js");
    const [request] = listApprovals({ status: "pending" });
    expect(request).toMatchObject({ toolName: "restart_app", actorKey: "automation:g" });

    // Still pending → nothing happens
    await engine.reconcileAutomationRuns();
    expect(calls.restart).toBe(0);

    decideApproval(request.id, true, "admin");
    const report = await engine.reconcileAutomationRuns();
    expect(report.resumed).toEqual([run.id]);
    expect(calls.restart).toBe(1);
    expect(calls.list).toBe(1);
    expect(store.getRun(run.id)?.status).toBe("succeeded");

    // A later pass does not run it again
    await engine.reconcileAutomationRuns();
    expect(calls.restart).toBe(1);
  });

  it("fails the run when the approval is denied", async () => {
    addAutomation("gd", gated);
    await engine.fireTrigger("manual", { automationId: "gd", manual: true });
    const { listApprovals, decideApproval } = await import("../approval/tool-approvals.js");
    const [request] = listApprovals({ status: "pending" });
    decideApproval(request.id, false, "admin");

    const report = await engine.reconcileAutomationRuns();
    const [run] = runsOf("gd");
    expect(report.cancelled).toEqual([run.id]);
    expect(run.status).toBe("failed");
    expect(calls.restart).toBe(0);
  });
});

describe("legacy actions", () => {
  it("are blocked in locked mode even when marked approved", async () => {
    setSetting("security_mode", "locked");
    const result = await engine.runActions([{ type: "restart_container", containerId: "x", approved: true }], {
      automationId: "legacy",
      automationName: "Legacy",
      triggerType: "manual",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("locked");
    expect(calls.restart).toBe(0);
  });
});
