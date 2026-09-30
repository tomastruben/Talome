/**
 * Automation run behaviours from PR #2's "durable runs", ported onto the
 * release run journal (automation/engine.ts): no second run while one is in
 * progress, and a schedule-triggered automation blocked on an approval
 * continues as soon as the owner approves — consuming the single-use approval
 * through executeTool, never re-running a crashed run.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? "/tmp").replace(/\/$/, "");
  process.env.DATABASE_PATH = `${tmp}/talome-durable-runs-${process.pid}-${Date.now()}.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
});

const m = vi.hoisted(() => ({
  probeExecute: vi.fn(async () => "probed"),
}));

vi.mock("../ai/agent.js", () => ({ runAutomationPrompt: vi.fn(async () => "ok") }));
vi.mock("../ai/automation-safe-tools.js", () => ({
  getAutomationSafeToolNames: () => new Set(["probe_tool"]),
}));
vi.mock("../ai/tool-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ai/tool-registry.js")>()),
  getAllRegisteredTools: () => ({ probe_tool: { execute: m.probeExecute } }),
}));
vi.mock("../approval/engine.js", () => ({ requiresApproval: () => false }));
vi.mock("../docker/client.js", () => ({ restartContainer: vi.fn(async () => {}) }));
vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { decideApproval } from "../approval/approvals.js";
import {
  continueAutomationAfterApproval,
  fireTrigger,
  hasActiveRun,
  type AutomationStep,
} from "../automation/engine.js";

function addAutomation(id: string, trigger: string, steps: AutomationStep[]) {
  db.insert(schema.automations).values({
    id,
    name: `Auto ${id}`,
    enabled: true,
    trigger: JSON.stringify({ type: trigger }),
    actions: "[]",
    workflowVersion: 2,
    steps: JSON.stringify(steps),
    createdAt: new Date().toISOString(),
  }).run();
}

function runsOf(automationId: string) {
  return db
    .select()
    .from(schema.automationRuns)
    .where(eq(schema.automationRuns.automationId, automationId))
    .orderBy(desc(schema.automationRuns.triggeredAt))
    .all();
}

const gatedStep: AutomationStep = {
  id: "s1",
  type: "tool_action",
  toolName: "probe_tool",
  args: { target: "a" },
  approvalPolicy: "require_approval",
};

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  vi.clearAllMocks();
  db.delete(schema.automationStepRuns).run();
  db.delete(schema.automationRuns).run();
  db.delete(schema.automations).run();
  db.delete(schema.approvals).run();
});

describe("overlap guard", () => {
  it("skips a trigger while a run of the same automation is in progress", async () => {
    addAutomation("o1", "test_trigger", [{ id: "s1", type: "tool_action", toolName: "probe_tool", approvalPolicy: "auto" }]);
    let release!: () => void;
    m.probeExecute.mockImplementationOnce(() => new Promise<string>((resolve) => { release = () => resolve("slow"); }));

    const first = fireTrigger("test_trigger");
    await vi.waitFor(() => expect(hasActiveRun("o1")).toBe(true));

    // A second (manual) trigger while the first run is still running is refused
    const [second] = await fireTrigger("test_trigger", { automationId: "o1", manual: true });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already running/);
    // A non-manual overlapping trigger is skipped silently
    expect(await fireTrigger("test_trigger")).toEqual([]);

    release();
    const [done] = await first;
    expect(done.success).toBe(true);
    expect(runsOf("o1")).toHaveLength(1);
    expect(m.probeExecute).toHaveBeenCalledTimes(1);
    expect(hasActiveRun("o1")).toBe(false);
  });

  it("does not treat a run blocked on an approval as active", async () => {
    addAutomation("o2", "test_trigger", [gatedStep]);
    const [blocked] = await fireTrigger("test_trigger");
    expect(blocked.approvalRequired).toBeTruthy();
    expect(runsOf("o2")[0].status).toBe("blocked_approval");
    expect(hasActiveRun("o2")).toBe(false);
  });
});

describe("continue after approval", () => {
  it("runs a schedule automation once its blocked call is approved, consuming the approval", async () => {
    addAutomation("c1", "schedule", [gatedStep]);
    const [blocked] = await fireTrigger("schedule", { automationId: "c1" });
    const approvalId = blocked.approvalRequired!.approvalId;
    expect(m.probeExecute).not.toHaveBeenCalled();

    expect(decideApproval(approvalId, "approved", "admin").ok).toBe(true);
    const result = await continueAutomationAfterApproval(approvalId);
    expect(result?.success).toBe(true);
    expect(m.probeExecute).toHaveBeenCalledTimes(1);
    expect(runsOf("c1").map((r) => r.status)).toEqual(["succeeded", "blocked_approval"]);
    expect(db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId)).get()?.status).toBe("consumed");

    // The approval is single-use and the last run is no longer blocked on it
    expect(await continueAutomationAfterApproval(approvalId)).toBeNull();
    expect(m.probeExecute).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a denied approval", async () => {
    addAutomation("c2", "schedule", [gatedStep]);
    const [blocked] = await fireTrigger("schedule", { automationId: "c2" });
    const approvalId = blocked.approvalRequired!.approvalId;
    decideApproval(approvalId, "denied", "admin");
    expect(await continueAutomationAfterApproval(approvalId)).toBeNull();
    expect(m.probeExecute).not.toHaveBeenCalled();
  });

  it("leaves event-triggered automations for their next event or Run now", async () => {
    addAutomation("c3", "container_stopped", [gatedStep]);
    const [blocked] = await fireTrigger("container_stopped", { automationId: "c3", manual: true });
    const approvalId = blocked.approvalRequired!.approvalId;
    decideApproval(approvalId, "approved", "admin");
    expect(await continueAutomationAfterApproval(approvalId)).toBeNull();
    expect(m.probeExecute).not.toHaveBeenCalled();
  });

  it("does not run a disabled automation", async () => {
    addAutomation("c4", "schedule", [gatedStep]);
    const [blocked] = await fireTrigger("schedule", { automationId: "c4" });
    const approvalId = blocked.approvalRequired!.approvalId;
    decideApproval(approvalId, "approved", "admin");
    db.update(schema.automations).set({ enabled: false }).where(eq(schema.automations.id, "c4")).run();
    expect(await continueAutomationAfterApproval(approvalId)).toBeNull();
    expect(m.probeExecute).not.toHaveBeenCalled();
  });
});
