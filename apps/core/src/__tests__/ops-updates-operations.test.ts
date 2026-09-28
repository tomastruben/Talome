import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// Per-file SQLite database — must be set before db/index.ts is imported.
vi.hoisted(() => {
  const tmp = process.env.TMPDIR ?? "/tmp";
  process.env.DATABASE_PATH = `${tmp.replace(/\/$/, "")}/talome-ops-operations-${process.pid}-${Date.now()}.db`;
});

const { mockListContainers, mockMarkInterruptedAutomationRuns } = vi.hoisted(() => ({
  mockListContainers: vi.fn(),
  mockMarkInterruptedAutomationRuns: vi.fn(() => 0),
}));

vi.mock("../docker/client.js", () => ({
  listContainers: mockListContainers,
  docker: { getContainer: vi.fn(), getImage: vi.fn() },
}));

vi.mock("../automation/engine.js", () => ({
  markInterruptedAutomationRuns: mockMarkInterruptedAutomationRuns,
}));

import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import {
  withAppOperation,
  OperationConflictError,
  getOperation,
  listOperationSteps,
  listOperations,
  listAppOperations,
  onOperationEvent,
  runWithActor,
  currentActor,
  __resetActiveOperationsForTests,
  type OperationEvent,
} from "../ops/operations.js";
import { recoverOperationsOnBoot, markInterruptedOperations } from "../ops/recovery.js";
import { operationsRoute } from "../ops/routes.js";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  __resetActiveOperationsForTests();
  db.delete(schema.appOperationEvents).run();
  db.delete(schema.appOperations).run();
  db.delete(schema.installedApps).run();
  vi.clearAllMocks();
});

describe("withAppOperation — per-app lock", () => {
  it("fails fast with a message naming the running operation", async () => {
    const gate = deferred();
    const first = withAppOperation("sonarr", "update", "user:alice", async (ctx) => {
      ctx.step("pull", 30, "Pulling");
      await gate.promise;
      return { success: true };
    });

    let conflict: unknown;
    try {
      await withAppOperation("sonarr", "restart", "assistant", async () => ({ success: true }));
    } catch (err) {
      conflict = err;
    }

    expect(conflict).toBeInstanceOf(OperationConflictError);
    const e = conflict as OperationConflictError;
    expect(e.running.kind).toBe("update");
    expect(e.message).toContain("Cannot restart sonarr");
    expect(e.message).toContain("update operation");
    expect(e.message).toContain(e.running.id);
    expect(e.message).toContain("user:alice");
    expect(e.message).toContain('step "pull" at 30%');

    // A different app is not blocked
    await expect(withAppOperation("radarr", "restart", "user", async () => ({ success: true }))).resolves.toEqual({ success: true });

    gate.resolve();
    await first;

    // Lock released after completion
    await expect(withAppOperation("sonarr", "restart", "user", async () => ({ success: true }))).resolves.toEqual({ success: true });
  });

  it("releases the lock when the operation throws", async () => {
    await expect(withAppOperation("app", "start", "user", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    await expect(withAppOperation("app", "start", "user", async () => ({ success: true }))).resolves.toBeTruthy();
  });
});

describe("withAppOperation — durable journal", () => {
  it("writes the running row before work starts", async () => {
    let seen: ReturnType<typeof getOperation> = null;
    await withAppOperation("jellyfin", "install", "user", async (ctx) => {
      seen = getOperation(ctx.id);
      return { success: true };
    });
    expect(seen).not.toBeNull();
    expect(seen!.status).toBe("running");
    expect(seen!.kind).toBe("install");
    expect(seen!.heartbeatAt).toBeTruthy();
  });

  it("persists progress rows in order and records the terminal status", async () => {
    const events: OperationEvent[] = [];
    const off = onOperationEvent((e) => events.push(e));
    let opId = "";
    await withAppOperation("plex", "update", "user", async (ctx) => {
      opId = ctx.id;
      ctx.step("snapshot", 5, "Recording state");
      ctx.step("pull", 10, "Pulling");
      ctx.step("pull", 40, "Pulled");
      ctx.step("verify", 70);
      return { success: true };
    });
    off();

    const steps = listOperationSteps(opId);
    expect(steps.map((s) => [s.status, s.step, s.progress])).toEqual([
      ["running", "starting", 0],
      ["running", "snapshot", 5],
      ["running", "pull", 10],
      ["running", "pull", 40],
      ["running", "verify", 70],
      ["succeeded", "done", 100],
    ]);
    expect(steps.map((s) => s.id)).toEqual([...steps.map((s) => s.id)].sort((a, b) => a - b));

    const op = getOperation(opId)!;
    expect(op.status).toBe("succeeded");
    expect(op.progress).toBe(100);
    expect(op.finishedAt).toBeTruthy();

    expect(events.map((e) => e.step)).toEqual(["starting", "snapshot", "pull", "pull", "verify", "done"]);
    expect(events.at(-1)?.status).toBe("succeeded");
  });

  it("classifies { success: false } as failed and keeps the last step", async () => {
    let opId = "";
    await withAppOperation("app1", "start", "user", async (ctx) => {
      opId = ctx.id;
      ctx.step("start_containers", 40);
      return { success: false, error: "port in use" };
    });
    const op = getOperation(opId)!;
    expect(op.status).toBe("failed");
    expect(op.error).toBe("port in use");
    expect(op.step).toBe("start_containers");
    expect(op.progress).toBe(40);
  });

  it("records rolled_back when the operation says so", async () => {
    let opId = "";
    await withAppOperation("app2", "update", "user", async (ctx) => {
      opId = ctx.id;
      ctx.markRolledBack("Health verification failed");
      return { success: false, error: "rolled back" };
    });
    const op = getOperation(opId)!;
    expect(op.status).toBe("rolled_back");
    expect(op.error).toBe("Health verification failed");
  });

  it("marks thrown operations failed and rethrows", async () => {
    let opId = "";
    await expect(withAppOperation("app3", "uninstall", "user", async (ctx) => {
      opId = ctx.id;
      throw new Error("docker socket gone");
    })).rejects.toThrow("docker socket gone");
    expect(getOperation(opId)!.status).toBe("failed");
    expect(getOperation(opId)!.error).toBe("docker socket gone");
  });

  it("merges detail and lists operations (active filter)", async () => {
    const gate = deferred();
    const p = withAppOperation("app4", "update", "user", async (ctx) => {
      ctx.setDetail({ snapshotId: 7 });
      ctx.setDetail({ backup: { success: true } });
      await gate.promise;
      return { success: true };
    });
    await new Promise((r) => setTimeout(r, 5));
    const active = listOperations({ active: true });
    expect(active).toHaveLength(1);
    expect(active[0].detail).toEqual({ snapshotId: 7, backup: { success: true } });
    gate.resolve();
    await p;
    expect(listOperations({ active: true })).toHaveLength(0);
    expect(listAppOperations("app4")).toHaveLength(1);
  });

  it("propagates the actor through async context", async () => {
    let actorSeen = "";
    await runWithActor("automation:abc", async () => {
      actorSeen = currentActor();
    });
    expect(actorSeen).toBe("automation:abc");
    expect(currentActor()).toBe("system");
  });
});

function insertRunningOp(
  id: string,
  appId: string,
  kind: string,
  status = "running",
  owner: { pid?: number | null; heartbeatAgoMs?: number } = {},
) {
  const at = new Date(Date.now() - 60_000).toISOString();
  const heartbeat = new Date(Date.now() - (owner.heartbeatAgoMs ?? 60_000)).toISOString();
  db.insert(schema.appOperations).values({
    id, appId, kind, actor: "mcp", status, step: "pull", progress: 30,
    startedAt: at, updatedAt: at, heartbeatAt: heartbeat, ownerPid: owner.pid ?? null,
  }).run();
}

describe("cross-process coordination (MCP stdio shares the database)", () => {
  it("an active operation owned by another live process blocks the app", async () => {
    insertRunningOp("op-mcp", "sonarr", "restart", "running", { pid: process.ppid, heartbeatAgoMs: 1_000 });
    await expect(withAppOperation("sonarr", "update", "user", async () => ({ success: true })))
      .rejects.toThrow(/restart operation \(op-mcp\)/);
  });

  it("a stale heartbeat or dead owner does not block", async () => {
    insertRunningOp("op-stale", "radarr", "restart", "running", { pid: process.ppid, heartbeatAgoMs: 10 * 60_000 });
    insertRunningOp("op-dead", "lidarr", "restart", "running", { pid: 2 ** 22 + 12345, heartbeatAgoMs: 1_000 });
    await expect(withAppOperation("radarr", "update", "user", async () => ({ success: true }))).resolves.toBeTruthy();
    await expect(withAppOperation("lidarr", "update", "user", async () => ({ success: true }))).resolves.toBeTruthy();
  });

  it("boot recovery leaves another live process's operation running", () => {
    insertRunningOp("op-live", "sonarr", "restart", "running", { pid: process.ppid, heartbeatAgoMs: 1_000 });
    insertRunningOp("op-orphan", "radarr", "restart", "running", { pid: 2 ** 22 + 12345, heartbeatAgoMs: 1_000 });
    const marked = markInterruptedOperations();
    expect(marked.map((o) => o.id)).toEqual(["op-orphan"]);
    expect(getOperation("op-live")!.status).toBe("running");
  });

  it("records the owning pid on new operations", async () => {
    let opId = "";
    await withAppOperation("owned", "start", "user", async (ctx) => {
      opId = ctx.id;
      return { success: true };
    });
    const row = db.select().from(schema.appOperations).where(eq(schema.appOperations.id, opId)).get();
    expect(row?.ownerPid).toBe(process.pid);
  });
});

describe("boot recovery", () => {

  it("marks running/queued operations interrupted without re-running them", async () => {
    insertRunningOp("op-1", "sonarr", "update");
    insertRunningOp("op-2", "radarr", "install", "queued");
    insertRunningOp("op-3", "lidarr", "start", "succeeded");

    const marked = markInterruptedOperations();
    expect(marked.map((o) => o.id).sort()).toEqual(["op-1", "op-2"]);
    expect(getOperation("op-1")!.status).toBe("interrupted");
    expect(getOperation("op-2")!.status).toBe("interrupted");
    expect(getOperation("op-3")!.status).toBe("succeeded");
    expect(getOperation("op-1")!.finishedAt).toBeTruthy();
    expect(listOperationSteps("op-1").at(-1)?.status).toBe("interrupted");
  });

  it("reconciles actual container state and un-sticks transient app status", async () => {
    insertRunningOp("op-upd", "sonarr", "update");
    const now = new Date().toISOString();
    db.insert(schema.installedApps).values({
      appId: "sonarr", storeSourceId: "store", status: "updating",
      installedAt: now, updatedAt: now,
    }).run();
    db.insert(schema.installedApps).values({
      appId: "stuck", storeSourceId: "store", status: "installing",
      installedAt: now, updatedAt: now,
    }).run();
    mockListContainers.mockResolvedValue([
      { id: "aaa111", name: "sonarr", image: "linuxserver/sonarr:4", status: "running", ports: [], created: now, labels: {} },
    ]);

    const result = recoverOperationsOnBoot({ delayMs: 0, sweeper: false });
    expect(result.interruptedOperations.map((o) => o.id)).toEqual(["op-upd"]);
    expect(mockMarkInterruptedAutomationRuns).toHaveBeenCalledTimes(1);

    const findings = await result.reconciled;
    const sonarr = findings.find((f) => f.appId === "sonarr")!;
    expect(sonarr.containers).toEqual([{ name: "sonarr", status: "running", image: "linuxserver/sonarr:4" }]);
    expect(sonarr.installedStatusAfter).toBe("running");
    expect(sonarr.note).toContain("Nothing was re-run automatically");

    const op = getOperation("op-upd")!;
    expect(op.status).toBe("interrupted");
    expect((op.detail?.reconcile as { installedStatusAfter: string }).installedStatusAfter).toBe("running");

    const app = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, "sonarr")).get();
    expect(app?.status).toBe("running");
    // Stuck install with no journaled op and no containers → error (not silently "installing" forever)
    const stuck = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, "stuck")).get();
    expect(stuck?.status).toBe("error");
  });

  it("records a reconcile error when Docker is unavailable and leaves status alone", async () => {
    insertRunningOp("op-x", "plex", "restart");
    const now = new Date().toISOString();
    db.insert(schema.installedApps).values({
      appId: "plex", storeSourceId: "store", status: "updating", installedAt: now, updatedAt: now,
    }).run();
    mockListContainers.mockRejectedValue(new Error("socket not found"));

    const { reconciled } = recoverOperationsOnBoot({ delayMs: 0, sweeper: false });
    const findings = await reconciled;
    expect(findings[0].error).toContain("socket not found");
    const app = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, "plex")).get();
    expect(app?.status).toBe("updating");
    expect(getOperation("op-x")!.status).toBe("interrupted");
  });
});

describe("operations API", () => {
  it("GET /?active=1 lists only running operations; GET /:id includes ordered steps", async () => {
    const gate = deferred();
    const running = withAppOperation("app-a", "update", "user", async (ctx) => {
      ctx.step("pull", 20);
      await gate.promise;
      return { success: true };
    });
    let doneId = "";
    await withAppOperation("app-b", "start", "user", async (ctx) => {
      doneId = ctx.id;
      return { success: true };
    });

    const activeRes = await operationsRoute.request("/?active=1");
    expect(activeRes.status).toBe(200);
    const active = (await activeRes.json()) as { appId: string; status: string }[];
    expect(active.map((o) => [o.appId, o.status])).toEqual([["app-a", "running"]]);

    const allRes = await operationsRoute.request("/");
    expect(((await allRes.json()) as unknown[]).length).toBe(2);

    const oneRes = await operationsRoute.request(`/${doneId}`);
    const one = (await oneRes.json()) as { status: string; steps: { step: string }[] };
    expect(one.status).toBe("succeeded");
    expect(one.steps.map((s) => s.step)).toEqual(["starting", "done"]);

    expect((await operationsRoute.request("/missing")).status).toBe(404);
    expect((await operationsRoute.request("/?limit=0")).status).toBe(400);

    gate.resolve();
    await running;
  });
});
