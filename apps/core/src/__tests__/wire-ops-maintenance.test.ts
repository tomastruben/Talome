import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// Maintenance windows as seen by monitors and detectors: operations run from
// another Talome process (the MCP stdio server) count through the journal, and
// a container skipped during a window is still reported if it stays down.

vi.hoisted(() => {
  const tmp = process.env.TMPDIR ?? "/tmp";
  process.env.DATABASE_PATH = `${tmp.replace(/\/$/, "")}/talome-wire-ops-maintenance-${process.pid}-${Date.now()}.db`;
  if (!process.env.TALOME_SECRET) process.env.TALOME_SECRET = "d".repeat(64);
});

const m = vi.hoisted(() => ({
  listContainers: vi.fn(async () => [] as unknown[]),
}));

vi.mock("../docker/client.js", () => ({
  listContainers: m.listContainers,
  getContainerLogs: vi.fn(async () => ""),
  getSystemStats: vi.fn(async () => {
    throw new Error("not in tests");
  }),
}));

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { __resetActiveOperationsForTests } from "../ops/operations.js";
import { isContainerUnderOperation, __resetOperationWindowCacheForTests } from "../ops/maintenance.js";
import { holdAppMaintenance, __resetMaintenanceForTests } from "../backup/state.js";
import { runDetectors, resetDetectorState } from "../agent-loop/detectors.js";
import { DEFAULT_AGENT_LOOP_CONFIG } from "../agent-loop/types.js";

function installApp(appId: string): void {
  const now = new Date().toISOString();
  db.insert(schema.installedApps).values({
    appId,
    storeSourceId: "test-store",
    status: "running",
    envConfig: "{}",
    containerIds: "[]",
    version: "1",
    installedAt: now,
    updatedAt: now,
  }).run();
}

/** A journal row owned by another live process (the parent of this test worker). */
function foreignOperation(appId: string, opts: { kind?: string; status?: string; finishedAgoMs?: number } = {}): void {
  const now = new Date().toISOString();
  const finishedAt = opts.finishedAgoMs === undefined ? null : new Date(Date.now() - opts.finishedAgoMs).toISOString();
  db.insert(schema.appOperations).values({
    id: randomUUID(),
    appId,
    kind: opts.kind ?? "update",
    actor: "assistant",
    status: opts.status ?? "running",
    step: "recreate",
    progress: 55,
    detail: null,
    error: null,
    idempotencyKey: null,
    startedAt: now,
    updatedAt: now,
    heartbeatAt: now,
    finishedAt,
    ownerPid: process.ppid,
    ownerHost: hostname(),
  } as typeof schema.appOperations.$inferInsert).run();
}

function container(name: string, status: string) {
  return { id: `${name}-id`, name, image: "img", status, ports: [], created: new Date().toISOString(), labels: {} };
}

async function downEvents(): Promise<string[]> {
  const events = await runDetectors({ ...DEFAULT_AGENT_LOOP_CONFIG, imageStalenessDays: 10_000 });
  return events.filter((e) => e.type === "container_down").map((e) => e.source);
}

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetActiveOperationsForTests();
  __resetMaintenanceForTests();
  __resetOperationWindowCacheForTests();
  resetDetectorState();
  db.delete(schema.appOperationEvents).run();
  db.delete(schema.appOperations).run();
  db.delete(schema.installedApps).run();
  installApp("sonarr");
  installApp("sonarr-anime");
  installApp("radarr");
});

describe("operations in another process", () => {
  it("a live update in another process puts the app's containers in the window", () => {
    foreignOperation("sonarr");
    expect(isContainerUnderOperation("sonarr")).toBe(true);
    expect(isContainerUnderOperation("sonarr-web-1")).toBe(true);
    expect(isContainerUnderOperation("radarr")).toBe(false);
    // Longest app id wins: another app sharing the prefix is not covered
    expect(isContainerUnderOperation("sonarr-anime-web-1")).toBe(false);
  });

  it("covers a short settling grace after the operation finished, then nothing", () => {
    foreignOperation("sonarr", { status: "succeeded", finishedAgoMs: 2_000 });
    expect(isContainerUnderOperation("sonarr")).toBe(true);
    __resetOperationWindowCacheForTests();
    db.delete(schema.appOperations).run();
    foreignOperation("sonarr", { status: "succeeded", finishedAgoMs: 10 * 60_000 });
    expect(isContainerUnderOperation("sonarr")).toBe(false);
  });

  it("ignores operations that do not touch containers", () => {
    foreignOperation("sonarr", { kind: "configure" });
    expect(isContainerUnderOperation("sonarr")).toBe(false);
  });
});

describe("detectors during and after a window", () => {
  it("does not report a container stopped mid-operation, but does if it is still down afterwards", async () => {
    m.listContainers.mockResolvedValue([container("sonarr", "running")]);
    expect(await downEvents()).toEqual([]);

    const release = holdAppMaintenance("sonarr", "update", [], 0);
    m.listContainers.mockResolvedValue([container("sonarr", "exited")]);
    expect(await downEvents()).toEqual([]);
    release();
    await new Promise((r) => setTimeout(r, 5));

    // The window is over and the container never came back
    expect(await downEvents()).toEqual(["sonarr"]);
  });

  it("stays quiet when the container came back before the window ended", async () => {
    m.listContainers.mockResolvedValue([container("sonarr", "running")]);
    await downEvents();

    foreignOperation("sonarr");
    m.listContainers.mockResolvedValue([container("sonarr", "exited")]);
    expect(await downEvents()).toEqual([]);

    db.delete(schema.appOperations).run();
    __resetOperationWindowCacheForTests();
    m.listContainers.mockResolvedValue([container("sonarr", "running")]);
    expect(await downEvents()).toEqual([]);
  });

  it("still reports another app sharing the held app's prefix", async () => {
    m.listContainers.mockResolvedValue([container("sonarr-anime-web-1", "running")]);
    await downEvents();
    const release = holdAppMaintenance("sonarr", "update");
    try {
      m.listContainers.mockResolvedValue([container("sonarr-anime-web-1", "exited")]);
      expect(await downEvents()).toEqual(["sonarr-anime-web-1"]);
    } finally {
      release();
    }
  });
});
