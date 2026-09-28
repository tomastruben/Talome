import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// Per-file SQLite database — must be set before db/index.ts is imported.
vi.hoisted(() => {
  const tmp = process.env.TMPDIR ?? "/tmp";
  process.env.DATABASE_PATH = `${tmp.replace(/\/$/, "")}/talome-ops-agent-loop-${process.pid}-${Date.now()}.db`;
  if (!process.env.TALOME_SECRET) process.env.TALOME_SECRET = "b".repeat(64);
});

const m = vi.hoisted(() => ({
  createAnthropic: vi.fn(),
  generateObject: vi.fn(),
  generateText: vi.fn(),
  writeNotification: vi.fn(),
  listContainers: vi.fn(),
}));

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: m.createAnthropic }));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: m.generateObject,
  generateText: m.generateText,
}));
vi.mock("../agent-loop/budget.js", () => ({
  checkBudget: () => true,
  logAiUsage: vi.fn(),
  shouldRunService: () => ({ allowed: true }),
  getEffectiveRate: (n: number) => n,
}));
vi.mock("../db/notifications.js", () => ({ writeNotification: m.writeNotification }));
vi.mock("../db/audit.js", () => ({ writeAuditEntry: vi.fn() }));
vi.mock("../docker/client.js", () => ({ listContainers: m.listContainers }));
vi.mock("../ai/claude-process.js", () => ({
  isClaudeCodeAvailable: vi.fn(async () => false),
  spawnClaudeStreaming: vi.fn(),
}));
// Remediation tool definitions are irrelevant here — stub them out.
vi.mock("../ai/tools/docker-tools.js", () => ({ listContainersTool: {}, getContainerLogsTool: {}, restartContainerTool: {}, checkServiceHealthTool: {} }));
vi.mock("../ai/tools/system-tools.js", () => ({ getSystemStatsTool: {}, getDiskUsageTool: {}, getSystemHealthTool: {} }));
vi.mock("../ai/tools/diagnose-tool.js", () => ({ diagnoseAppTool: {} }));
vi.mock("../ai/tools/arr-tools.js", () => ({ arrGetStatusTool: {}, arrGetQueueDetailsTool: {}, arrListDownloadClientsTool: {} }));
vi.mock("../ai/tools/qbittorrent-tools.js", () => ({ qbtListTorrentsTool: {} }));
vi.mock("../ai/tools/jellyfin-tools.js", () => ({ jellyfinGetStatusTool: {}, jellyfinScanLibraryTool: {} }));
vi.mock("../ai/tools/storage-tools.js", () => ({ cleanupDockerTool: {} }));
vi.mock("../ai/tools/log-tools.js", () => ({ searchContainerLogsTool: {} }));
vi.mock("../ai/tools/app-tools.js", () => ({ rollbackUpdateTool: {}, checkDependenciesTool: {} }));

import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { setSetting } from "../utils/settings.js";
import { isEncrypted } from "../utils/crypto.js";
import { triageEvents } from "../agent-loop/triage.js";
import { remediateEvent, finalizeRemediation, classifyRemediationOutcome } from "../agent-loop/remediation.js";
import { verifyPendingRemediations, registerOutcomeProbe } from "../agent-loop/outcome-tracker.js";
import type { SystemEvent } from "../agent-loop/types.js";

const PLAINTEXT_KEY = "sk-ant-test-plaintext-key";

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

function persistEvent(event: SystemEvent) {
  db.insert(schema.systemEvents).values({
    id: event.id,
    type: event.type,
    severity: event.severity,
    source: event.source,
    message: event.message,
    data: JSON.stringify(event.data),
    createdAt: event.detectedAt,
  }).run();
}

function remediationFor(eventId: string) {
  return db.select().from(schema.remediationLog).where(eq(schema.remediationLog.eventId, eventId)).get();
}

function notificationTitles(): string[] {
  return m.writeNotification.mock.calls.map((c) => String(c[1]));
}

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  vi.clearAllMocks();
  db.delete(schema.remediationLog).run();
  db.delete(schema.systemEvents).run();
  m.createAnthropic.mockImplementation(() => (model: string) => ({ model }));
  setSetting("anthropic_key", PLAINTEXT_KEY);
});

describe("anthropic_key decryption", () => {
  it("stores the key encrypted at rest", () => {
    const row = db.select().from(schema.settings).where(eq(schema.settings.key, "anthropic_key")).get();
    expect(row?.value).not.toBe(PLAINTEXT_KEY);
    expect(isEncrypted(row!.value)).toBe(true);
  });

  it("triage passes the decrypted key to the provider", async () => {
    m.generateObject.mockResolvedValue({ object: { assessments: [] }, usage: { inputTokens: 1, outputTokens: 1 } });
    await triageEvents([makeEvent()], 10);
    expect(m.createAnthropic).toHaveBeenCalledWith({ apiKey: PLAINTEXT_KEY });
  });

  it("remediation passes the decrypted key to the provider", async () => {
    m.generateText.mockResolvedValue({ text: "Diagnosis: fine\nConfidence: high", steps: [], usage: {} });
    const event = makeEvent({ source: "radarr-key-test" });
    await remediateEvent(event, { eventId: event.id, verdict: "act", reason: "test" }, 10, false);
    expect(m.createAnthropic).toHaveBeenCalledWith({ apiKey: PLAINTEXT_KEY });
  });
});

describe("remediation status semantics", () => {
  it("a write-tool run is pending_verification and never announced as fixed", () => {
    const event = makeEvent();
    persistEvent(event);
    const result = finalizeRemediation(event, "Restarted it. Confidence: high", ["get_container_logs", "restart_container"], "test-model");

    expect(result.outcome).toBe("pending_verification");
    expect(remediationFor(event.id)?.outcome).toBe("pending_verification");
    expect(notificationTitles()).toEqual(["Agent attempted fix: sonarr"]);
    expect(notificationTitles().some((t) => t.includes("fixed"))).toBe(false);
  });

  it("a diagnosis-only run stays pending", () => {
    expect(classifyRemediationOutcome(["get_container_logs"])).toEqual({ tookAction: false, outcome: "pending" });
    expect(classifyRemediationOutcome(["rollback_update"])).toEqual({ tookAction: true, outcome: "pending_verification" });
  });

  it("reports fixed only after verification passes", async () => {
    const event = makeEvent();
    persistEvent(event);
    finalizeRemediation(event, "Restarted", ["restart_container"], "test-model");
    m.writeNotification.mockClear();
    m.listContainers.mockResolvedValue([{ id: "1", name: "sonarr", image: "x", status: "running", ports: [], created: "", labels: {} }]);

    // Too early — attempted fixes get time to settle
    await verifyPendingRemediations({ now: Date.now() + 10_000 });
    expect(remediationFor(event.id)?.outcome).toBe("pending_verification");
    expect(m.writeNotification).not.toHaveBeenCalled();

    await verifyPendingRemediations({ now: Date.now() + 120_000 });
    expect(remediationFor(event.id)?.outcome).toBe("success");
    expect(notificationTitles()).toEqual(["Agent fixed: sonarr"]);
  });

  it("reports 'attempted, not verified' when verification fails", async () => {
    const event = makeEvent();
    persistEvent(event);
    finalizeRemediation(event, "Restarted", ["restart_container"], "test-model");
    m.writeNotification.mockClear();
    m.listContainers.mockResolvedValue([{ id: "1", name: "sonarr", image: "x", status: "exited", ports: [], created: "", labels: {} }]);

    await verifyPendingRemediations({ now: Date.now() + 120_000 });
    expect(remediationFor(event.id)?.outcome).toBe("failure");
    expect(notificationTitles()).toEqual(["Agent attempted fix, not verified: sonarr"]);
  });

  it("non-container events stay partial and are reported as not verified", async () => {
    const event = makeEvent({ type: "disk_trend", source: "disk:/", data: { mountPath: "/" } });
    persistEvent(event);
    finalizeRemediation(event, "Pruned images", ["cleanup_docker"], "test-model");
    m.writeNotification.mockClear();
    m.listContainers.mockResolvedValue([]);

    await verifyPendingRemediations({ now: Date.now() + 120_000 });
    expect(remediationFor(event.id)?.outcome).toBe("partial");
    expect(notificationTitles()).toEqual(["Agent attempted fix, not verified: disk:/"]);
  });

  it("registered outcome probes can verify non-container events", async () => {
    const unregister = registerOutcomeProbe("disk", async ({ eventData }) =>
      eventData.mountPath === "/" ? { outcome: "success", reason: "Disk usage back under threshold", probe: "disk" } : null,
    );
    try {
      const event = makeEvent({ type: "disk_trend", source: "disk:/", data: { mountPath: "/" } });
      persistEvent(event);
      finalizeRemediation(event, "Pruned images", ["cleanup_docker"], "test-model");
      m.writeNotification.mockClear();
      m.listContainers.mockResolvedValue([]);

      await verifyPendingRemediations({ now: Date.now() + 120_000 });
      expect(remediationFor(event.id)?.outcome).toBe("success");
      expect(notificationTitles()).toEqual(["Agent fixed: disk:/"]);
    } finally {
      unregister();
    }
  });
});
