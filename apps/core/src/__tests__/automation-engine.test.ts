import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory DB mock ─────────────────────────────────────────────────────────

interface AutomationRow {
  id: string;
  name: string;
  enabled: boolean;
  trigger: string;
  conditions: string;
  actions: string;
  lastRunAt: string | null;
  runCount: number;
  createdAt: string;
}

function createMemoryDB() {
  const automations: AutomationRow[] = [];

  function add(row: AutomationRow) { automations.push(row); }
  function all() { return [...automations]; }
  function enabled() { return automations.filter((a) => a.enabled); }
  function update(id: string, patch: Partial<AutomationRow>) {
    const row = automations.find((r) => r.id === id);
    if (row) Object.assign(row, patch);
  }
  function get(id: string) { return automations.find((r) => r.id === id); }

  return { add, all, enabled, update, get };
}

// ── Engine re-implementation (test-local, mirrors engine.ts) ─────────────────

type ActionResult = { type: string; [key: string]: unknown };
const actionLog: ActionResult[] = [];

async function runActions(actions: ActionResult[]): Promise<void> {
  for (const action of actions) {
    actionLog.push(action);
  }
}

type TriggerData = Record<string, unknown>;

function matchesTrigger(
  trigger: { type: string; containerId?: string; threshold?: number; appId?: string },
  data: TriggerData,
): boolean {
  if (trigger.containerId) {
    const containerIds = [data.containerId, data.containerName].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    if (!containerIds.includes(trigger.containerId)) return false;
  }
  if (trigger.appId && data.appId !== trigger.appId) return false;
  if (trigger.threshold !== undefined && typeof data.pct === "number" && data.pct < trigger.threshold) return false;
  return true;
}

async function fireTrigger(
  type: string,
  data: TriggerData,
  db: ReturnType<typeof createMemoryDB>,
) {
  const all = db.enabled();
  for (const auto of all) {
    if (typeof data.automationId === "string" && auto.id !== data.automationId) continue;
    let trigger: { type: string; containerId?: string; threshold?: number; appId?: string };
    let actions: ActionResult[];
    try {
      trigger = JSON.parse(auto.trigger);
      actions = JSON.parse(auto.actions);
    } catch {
      continue;
    }
    if (trigger.type !== type) continue;
    if (!matchesTrigger(trigger, data)) continue;
    await runActions(actions);
    db.update(auto.id, {
      lastRunAt: new Date().toISOString(),
      runCount: auto.runCount + 1,
    });
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => { actionLog.length = 0; });

describe("fireTrigger", () => {
  it("fires matching automation by trigger type", async () => {
    const db = createMemoryDB();
    db.add({
      id: "1", name: "Auto1", enabled: true,
      trigger: JSON.stringify({ type: "container_stopped" }),
      conditions: "[]",
      actions: JSON.stringify([{ type: "send_notification", level: "critical", title: "Down" }]),
      lastRunAt: null, runCount: 0, createdAt: new Date().toISOString(),
    });

    await fireTrigger("container_stopped", {}, db);
    expect(actionLog).toHaveLength(1);
    expect(actionLog[0].type).toBe("send_notification");
  });

  it("skips automations with non-matching trigger type", async () => {
    const db = createMemoryDB();
    db.add({
      id: "1", name: "Auto1", enabled: true,
      trigger: JSON.stringify({ type: "app_installed" }),
      conditions: "[]",
      actions: JSON.stringify([{ type: "run_shell", command: "echo hi" }]),
      lastRunAt: null, runCount: 0, createdAt: new Date().toISOString(),
    });

    await fireTrigger("container_stopped", {}, db);
    expect(actionLog).toHaveLength(0);
  });

  it("skips disabled automations", async () => {
    const db = createMemoryDB();
    db.add({
      id: "1", name: "Auto1", enabled: false,
      trigger: JSON.stringify({ type: "container_stopped" }),
      conditions: "[]",
      actions: JSON.stringify([{ type: "restart_container", containerId: "myapp" }]),
      lastRunAt: null, runCount: 0, createdAt: new Date().toISOString(),
    });

    await fireTrigger("container_stopped", {}, db);
    expect(actionLog).toHaveLength(0);
  });

  it("increments runCount on each fire", async () => {
    const db = createMemoryDB();
    db.add({
      id: "1", name: "Auto1", enabled: true,
      trigger: JSON.stringify({ type: "schedule" }),
      conditions: "[]",
      actions: JSON.stringify([{ type: "send_notification", level: "info", title: "Tick" }]),
      lastRunAt: null, runCount: 0, createdAt: new Date().toISOString(),
    });

    await fireTrigger("schedule", {}, db);
    await fireTrigger("schedule", {}, db);

    expect(db.get("1")?.runCount).toBe(2);
  });

  it("filters by containerId when specified", async () => {
    const db = createMemoryDB();
    db.add({
      id: "1", name: "MyApp restart", enabled: true,
      trigger: JSON.stringify({ type: "container_stopped", containerId: "myapp" }),
      conditions: "[]",
      actions: JSON.stringify([{ type: "restart_container", containerId: "myapp" }]),
      lastRunAt: null, runCount: 0, createdAt: new Date().toISOString(),
    });

    // Different container — should not fire
    await fireTrigger("container_stopped", { containerId: "otherapp" }, db);
    expect(actionLog).toHaveLength(0);

    // Matching container — should fire
    await fireTrigger("container_stopped", { containerId: "myapp" }, db);
    expect(actionLog).toHaveLength(1);
  });

  it("fires all matching automations", async () => {
    const db = createMemoryDB();
    for (let i = 1; i <= 3; i++) {
      db.add({
        id: String(i), name: `Auto${i}`, enabled: true,
        trigger: JSON.stringify({ type: "app_installed" }),
        conditions: "[]",
        actions: JSON.stringify([{ type: "send_notification", level: "info", title: `Notify ${i}` }]),
        lastRunAt: null, runCount: 0, createdAt: new Date().toISOString(),
      });
    }

    await fireTrigger("app_installed", {}, db);
    expect(actionLog).toHaveLength(3);
  });

  it("scopes execution when automationId is provided", async () => {
    const db = createMemoryDB();
    db.add({
      id: "1", name: "Auto1", enabled: true,
      trigger: JSON.stringify({ type: "schedule" }),
      conditions: "[]",
      actions: JSON.stringify([{ type: "send_notification", level: "info", title: "Notify 1" }]),
      lastRunAt: null, runCount: 0, createdAt: new Date().toISOString(),
    });
    db.add({
      id: "2", name: "Auto2", enabled: true,
      trigger: JSON.stringify({ type: "schedule" }),
      conditions: "[]",
      actions: JSON.stringify([{ type: "send_notification", level: "info", title: "Notify 2" }]),
      lastRunAt: null, runCount: 0, createdAt: new Date().toISOString(),
    });

    await fireTrigger("schedule", { automationId: "2" }, db);
    expect(actionLog).toHaveLength(1);
    expect(actionLog[0]).toMatchObject({ title: "Notify 2" });
  });

  it("matches container trigger against containerName for compatibility", async () => {
    const db = createMemoryDB();
    db.add({
      id: "1", name: "ByName", enabled: true,
      trigger: JSON.stringify({ type: "container_stopped", containerId: "sonarr" }),
      conditions: "[]",
      actions: JSON.stringify([{ type: "send_notification", level: "warning", title: "Container down" }]),
      lastRunAt: null, runCount: 0, createdAt: new Date().toISOString(),
    });

    await fireTrigger("container_stopped", { containerId: "abcd1234", containerName: "sonarr" }, db);
    expect(actionLog).toHaveLength(1);
  });

  it("handles malformed JSON trigger gracefully", async () => {
    const db = createMemoryDB();
    db.add({
      id: "bad", name: "Bad JSON", enabled: true,
      trigger: "{INVALID",
      conditions: "[]",
      actions: "[]",
      lastRunAt: null, runCount: 0, createdAt: new Date().toISOString(),
    });

    // Should not throw
    await expect(fireTrigger("container_stopped", {}, db)).resolves.toBeUndefined();
  });
});
