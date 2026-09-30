import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// Agent loop ↔ app operations: remediation guard, maintenance windows and the
// semantic outcome probe. No Docker, no AI.

vi.hoisted(() => {
  const tmp = process.env.TMPDIR ?? "/tmp";
  process.env.DATABASE_PATH = `${tmp.replace(/\/$/, "")}/talome-wire-ops-agent-loop-${process.pid}-${Date.now()}.db`;
  if (!process.env.TALOME_SECRET) process.env.TALOME_SECRET = "c".repeat(64);
});

const m = vi.hoisted(() => ({
  runDetectors: vi.fn(),
  triageEvents: vi.fn(),
  remediateEvent: vi.fn(),
  listContainers: vi.fn(async () => [] as unknown[]),
  writeNotification: vi.fn(),
}));

vi.mock("../agent-loop/detectors.js", () => ({ runDetectors: m.runDetectors }));
vi.mock("../agent-loop/triage.js", () => ({ triageEvents: m.triageEvents }));
vi.mock("../agent-loop/remediation.js", () => ({ remediateEvent: m.remediateEvent }));
vi.mock("../agent-loop/budget.js", () => ({
  isInStartupGrace: () => false,
  getBudgetZone: () => "green",
  getEffectiveRate: (n: number) => n,
}));
vi.mock("../db/notifications.js", () => ({ writeNotification: m.writeNotification }));
vi.mock("../docker/client.js", () => ({
  listContainers: m.listContainers,
  subscribeDockerEvents: vi.fn(() => () => {}),
  connectContainerToNetwork: vi.fn(),
}));
vi.mock("../docker/talome-network.js", () => ({ ensureTalomeNetwork: vi.fn(async () => {}) }));

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { withAppOperation, __resetActiveOperationsForTests } from "../ops/operations.js";
import {
  holdAppMaintenance,
  markContainersInMaintenance,
  releaseAppMaintenance,
  isAppInMaintenance,
  isContainerInBackupWindow,
  getAppMaintenanceReasons,
  __resetMaintenanceForTests,
} from "../backup/state.js";
import { checkRemediationGuard, resolveEventAppId } from "../agent-loop/app-scope.js";
import { createSemanticOutcomeProbe, registerSemanticOutcomeProbe } from "../agent-loop/semantic-probe.js";
import { evaluateRemediationOutcome, verifyPendingRemediations } from "../agent-loop/outcome-tracker.js";
import { runAgentCycleOnce } from "../agent-loop/index.js";
import { resetDedupCache } from "../agent-loop/event-dedup.js";
import type { SystemEvent } from "../agent-loop/types.js";
import type { VerifyOutcome } from "../verification/index.js";

const APP = "sonarr";

function installApp(appId: string, containerIds: string[] = []): void {
  const now = new Date().toISOString();
  db.insert(schema.installedApps).values({
    appId,
    storeSourceId: "test-store",
    status: "running",
    envConfig: "{}",
    containerIds: JSON.stringify(containerIds),
    version: "1",
    installedAt: now,
    updatedAt: now,
  }).run();
}

function event(source: string, data: Record<string, unknown> = {}): SystemEvent {
  return {
    id: randomUUID(),
    type: "container_down",
    severity: "warning",
    source,
    message: `${source} stopped`,
    data: { containerName: source, ...data },
    detectedAt: new Date().toISOString(),
  };
}

async function holdOperation(appId: string, kind: "update" | "restore" | "backup"): Promise<{ release: () => Promise<void> }> {
  let resolve!: () => void;
  const done = withAppOperation(appId, kind, "system", () => new Promise<{ success: boolean }>((r) => {
    resolve = () => r({ success: true });
  }));
  await new Promise((r) => setTimeout(r, 2));
  return {
    release: async () => {
      resolve();
      await done;
    },
  };
}

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetActiveOperationsForTests();
  __resetMaintenanceForTests();
  resetDedupCache();
  db.delete(schema.appOperationEvents).run();
  db.delete(schema.appOperations).run();
  db.delete(schema.installedApps).run();
  db.delete(schema.systemEvents).run();
  db.delete(schema.remediationLog).run();
  installApp(APP, ["abc123def456"]);
  installApp("sonarr-anime");
});

describe("maintenance windows", () => {
  it("a backup finishing inside an update does not end the update's window", () => {
    const releaseUpdate = holdAppMaintenance(APP, "update");
    markContainersInMaintenance(APP, ["abc123def456", "sonarr"]);
    releaseAppMaintenance(APP, 0); // the nested pre-update backup is done
    expect(isAppInMaintenance(APP)).toBe(true);
    expect(isContainerInBackupWindow("sonarr")).toBe(true);
    // Recreated containers get new ids but keep the app's naming
    expect(isContainerInBackupWindow("sonarr-sonarr-1", "fff000fff000")).toBe(true);
    expect(isContainerInBackupWindow("radarr")).toBe(false);
    expect(getAppMaintenanceReasons(APP)).toEqual(["update"]);

    releaseUpdate();
    releaseUpdate(); // idempotent
    expect(getAppMaintenanceReasons(APP)).toEqual([]);
    // Short grace period for restart settling — for the marked containers only:
    // app-name matching ends with the hold, so a recreated container that
    // crashes right after the update is not hidden.
    expect(isAppInMaintenance(APP)).toBe(true);
    expect(isContainerInBackupWindow("sonarr")).toBe(true);
    expect(isContainerInBackupWindow("sonarr-sonarr-1", "fff000fff000")).toBe(false);
  });

  it("a held app does not cover another installed app whose id shares its prefix", () => {
    const release = holdAppMaintenance(APP, "update");
    try {
      expect(isContainerInBackupWindow("sonarr-web-1")).toBe(true);
      expect(isContainerInBackupWindow("sonarr-anime")).toBe(false);
      expect(isContainerInBackupWindow("sonarr-anime-web-1")).toBe(false);
      expect(checkRemediationGuard(event("sonarr-anime-web-1")).blocked).toBe(false);
      expect(checkRemediationGuard(event("sonarr-web-1")).blocked).toBe(true);
    } finally {
      release();
    }
  });

  it("ends immediately with a zero grace period", () => {
    const release = holdAppMaintenance(APP, "restore", ["sonarr"], 0);
    release();
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(isAppInMaintenance(APP)).toBe(false);
      expect(isContainerInBackupWindow("sonarr")).toBe(false);
      resolve();
    }, 5));
  });
});

describe("remediation guard", () => {
  it("maps events to installed apps by explicit id, container id and container name", () => {
    expect(resolveEventAppId({ source: "x", data: { appId: APP } })).toBe(APP);
    expect(resolveEventAppId({ source: "whatever", data: { containerId: "abc123def456aaaa" } })).toBe(APP);
    expect(resolveEventAppId({ source: "sonarr-anime-web-1", data: {} })).toBe("sonarr-anime");
    expect(resolveEventAppId({ source: "sonarr", data: {} })).toBe(APP);
    expect(resolveEventAppId({ source: "disk", data: {} })).toBeNull();
  });

  it("blocks remediation while the app has a live operation", async () => {
    const held = await holdOperation(APP, "update");
    try {
      const guard = checkRemediationGuard(event("sonarr"));
      expect(guard).toMatchObject({ blocked: true, appId: APP });
      expect(guard.reason).toContain("update operation");
    } finally {
      await held.release();
    }
    expect(checkRemediationGuard(event("sonarr")).blocked).toBe(false);
  });

  it("blocks remediation inside a maintenance window", () => {
    const release = holdAppMaintenance(APP, "restore");
    try {
      const guard = checkRemediationGuard(event("sonarr"));
      expect(guard.blocked).toBe(true);
      expect(guard.reason).toContain("maintenance window");
    } finally {
      release();
    }
  });

  it("the agent loop skips triage and remediation for apps being operated on", async () => {
    const ev = event("sonarr");
    m.runDetectors.mockResolvedValue([ev]);
    m.triageEvents.mockImplementation(async (events: SystemEvent[]) => events.map((e) => ({ eventId: e.id, verdict: "act", reason: "down" })));
    m.remediateEvent.mockResolvedValue({ eventId: ev.id, action: "diagnosed", model: "x", confidence: 0.5, outcome: "pending", details: "" });

    const held = await holdOperation(APP, "update");
    try {
      await runAgentCycleOnce();
      expect(m.triageEvents).not.toHaveBeenCalled();
      expect(m.remediateEvent).not.toHaveBeenCalled();
      // Neither persisted nor deduplicated: the first occurrence after the
      // operation must count as new
      expect(db.select().from(schema.systemEvents).where(eq(schema.systemEvents.id, ev.id)).get()).toBeUndefined();
    } finally {
      await held.release();
    }

    // Same problem, still there after the operation — no dedup cache reset
    const ev2 = event("sonarr");
    m.runDetectors.mockResolvedValue([ev2]);
    await runAgentCycleOnce();
    expect(m.triageEvents).toHaveBeenCalledTimes(1);
    expect(m.remediateEvent).toHaveBeenCalledTimes(1);
    expect(db.select().from(schema.systemEvents).where(eq(schema.systemEvents.id, ev2.id)).get()).toBeTruthy();
  });

  it("re-checks right before remediating (an operation may start during triage)", async () => {
    const ev = event("sonarr");
    m.runDetectors.mockResolvedValue([ev]);
    let held: { release: () => Promise<void> } | null = null;
    m.triageEvents.mockImplementation(async (events: SystemEvent[]) => {
      held = await holdOperation(APP, "restore");
      return events.map((e) => ({ eventId: e.id, verdict: "act", reason: "down" }));
    });
    try {
      await runAgentCycleOnce();
      expect(m.triageEvents).toHaveBeenCalledTimes(1);
      expect(m.remediateEvent).not.toHaveBeenCalled();
    } finally {
      await (held as { release: () => Promise<void> } | null)?.release();
    }
  });

  it("does not judge a remediation while its app is being operated on", async () => {
    const ev = event("sonarr");
    db.insert(schema.systemEvents).values({
      id: ev.id, type: ev.type, severity: ev.severity, source: ev.source, message: ev.message,
      data: JSON.stringify(ev.data), occurrenceCount: 1, lastSeen: ev.detectedAt, createdAt: ev.detectedAt,
    }).run();
    db.insert(schema.remediationLog).values({
      id: randomUUID(), eventId: ev.id, action: "diagnosed", model: "x", confidence: 0.5, outcome: "pending", createdAt: new Date().toISOString(),
    } as typeof schema.remediationLog.$inferInsert).run();

    const held = await holdOperation(APP, "update");
    try {
      await verifyPendingRemediations();
      expect(db.select().from(schema.remediationLog).get()!.verifiedAt).toBeNull();
    } finally {
      await held.release();
    }
    await verifyPendingRemediations();
    expect(db.select().from(schema.remediationLog).get()!.verifiedAt).not.toBeNull();
  });
});

describe("semantic outcome probe", () => {
  const result = (status: string): VerifyOutcome => ({
    ok: true,
    result: {
      targetType: "app",
      targetId: APP,
      status: status as "verified",
      summary: `Sonarr: ${status}`,
      checks: [{ id: "api", label: "API key", status: status === "verified" ? "pass" : "fail", evidence: "", durationMs: 1, critical: true, active: false }],
      includeActive: false,
      durationMs: 1,
      verifiedAt: new Date().toISOString(),
    },
  });
  const ctx = () => ({
    remediation: {} as never,
    event: { source: "sonarr" } as never,
    eventData: { containerName: "sonarr" },
    containers: new Map(),
  });

  it("maps verification status to a remediation verdict", async () => {
    const verifyApp = vi.fn();
    const probe = createSemanticOutcomeProbe({ isVerifiableApp: () => true, verifyApp, resolveAppId: () => APP, isBusy: () => false });
    verifyApp.mockResolvedValueOnce(result("verified"));
    expect(await probe(ctx())).toMatchObject({ outcome: "success", probe: "semantic" });
    verifyApp.mockResolvedValueOnce(result("degraded"));
    expect(await probe(ctx())).toMatchObject({ outcome: "partial" });
    verifyApp.mockResolvedValueOnce(result("failed"));
    const failed = await probe(ctx());
    expect(failed).toMatchObject({ outcome: "failure" });
    expect(failed?.reason).toContain("API key");
    verifyApp.mockResolvedValueOnce(result("unknown"));
    expect(await probe(ctx())).toBeNull();
    verifyApp.mockResolvedValueOnce({ ok: false, code: "probe_error", error: "boom" });
    expect(await probe(ctx())).toBeNull();
  });

  it("gives no verdict for apps without a probe, busy apps, or when the deadline passes", async () => {
    const verifyApp = vi.fn(async () => result("verified"));
    expect(await createSemanticOutcomeProbe({ isVerifiableApp: () => false, verifyApp, resolveAppId: () => APP, isBusy: () => false })(ctx())).toBeNull();
    expect(await createSemanticOutcomeProbe({ isVerifiableApp: () => true, verifyApp, resolveAppId: () => APP, isBusy: () => true })(ctx())).toBeNull();
    expect(verifyApp).not.toHaveBeenCalled();
    const slow = vi.fn(() => new Promise<VerifyOutcome>(() => {}));
    expect(await createSemanticOutcomeProbe({ isVerifiableApp: () => true, verifyApp: slow, resolveAppId: () => APP, isBusy: () => false }, 20)(ctx())).toBeNull();
  });

  it("is registered with the outcome tracker exactly once", async () => {
    const off = registerSemanticOutcomeProbe();
    expect(registerSemanticOutcomeProbe()).toBe(off);
    off();
    // With no probe applicable the tracker falls back to the container probe
    const verdict = await evaluateRemediationOutcome({
      remediation: {} as never,
      event: { source: "sonarr" } as never,
      eventData: { containerName: "sonarr" },
      containers: new Map(),
    });
    expect(verdict.probe).toBe("container");
  });
});
