import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { prepareBackupEnv, installFakeApp, resetDocker, dockerState } from "./helpers/backups-fixture.js";

// Backups and restores as journaled app operations: real backup engine, real
// operations journal, real lifecycle start inside a restore. Docker is an
// in-memory double and `docker compose` is a mock.

const m = vi.hoisted(() => ({
  run: vi.fn(),
  writeNotification: vi.fn(),
  gate: null as Promise<void> | null,
  observed: [] as Array<{ at: string; appInMaintenance: boolean }>,
}));

vi.mock("../backup/docker-ops.js", async () => {
  const base = (await import("./helpers/backups-fixture.js")).dockerOpsMock();
  return {
    ...base,
    // The real path: restore → lifecycle start on the restore's own operation.
    startAppViaLifecycle: vi.fn(async (appId: string) => {
      const { startAppWithinHeldOperation } = await import("../stores/lifecycle.js");
      return startAppWithinHeldOperation(appId);
    }),
  };
});
vi.mock("../stores/compose-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stores/compose-exec.js")>();
  return {
    ...actual,
    run: m.run,
    buildEnv: (_appId: string, env: Record<string, string> = {}) => ({ ...env }),
    writeAppDotEnv: vi.fn(),
    discoverContainers: vi.fn(async () => ["c1"]),
    pinImageDigest: vi.fn(),
  };
});
vi.mock("../docker/client.js", () => ({
  listContainers: vi.fn(async () => []),
  listNetworks: vi.fn(async () => []),
  removeNetwork: vi.fn(),
  connectContainerToNetwork: vi.fn(),
  startContainer: vi.fn(),
  docker: {},
}));
vi.mock("../docker/talome-network.js", () => ({ ensureTalomeNetwork: vi.fn(async () => {}), injectTalomeNetwork: vi.fn() }));
vi.mock("../db/notifications.js", () => ({ writeNotification: m.writeNotification }));
vi.mock("../stores/compose-errors.js", () => ({ recordInstallError: vi.fn() }));
vi.mock("../stores/lifecycle-hooks.js", () => ({ executeHook: vi.fn(async () => {}) }));
vi.mock("../automation/engine.js", () => ({ fireTrigger: vi.fn(async () => []) }));
vi.mock("../proxy/caddy.js", () => ({ autoRegisterProxyRoute: vi.fn(), removeProxyRoutesForApp: vi.fn() }));
vi.mock("../app-registry/auto-configure.js", () => ({ autoConfigureApp: vi.fn() }));
vi.mock("../app-registry/index.js", () => ({ getAppCapabilities: vi.fn(() => null) }));

const env = prepareBackupEnv("wire-ops-backup-ops");
const { runMigrations } = await import("../db/migrate.js");
runMigrations();
const { db, schema } = await import("../db/index.js");
const { eq, sql } = await import("drizzle-orm");
const { createAppBackup } = await import("../backup/engine.js");
const { runBackupOperation, runRestoreOperation } = await import("../backup/operation.js");
const { runScheduledBackup } = await import("../backup/scheduler.js");
const { updateApp } = await import("../stores/lifecycle.js");
const { withAppOperation, getOperation, listOperationSteps, __resetActiveOperationsForTests } = await import("../ops/operations.js");
const { backupAppTool, restoreAppTool } = await import("../ai/tools/backup-tools.js");
const { backups } = await import("../routes/backups.js");
const state = await import("../backup/state.js");

afterAll(() => env.cleanup());

const APP = "opsapp";
const FAST = { healthTimeoutMs: 500, pollIntervalMs: 10 };
const COMPOSE = `services:
  web:
    image: example/web:1
    volumes:
      - ./config:/config
`;

const admin = new Hono();
admin.use("*", async (c, next) => {
  c.set("sessionRole" as never, "admin" as never);
  c.set("sessionUser" as never, "alice" as never);
  await next();
});
admin.route("/api/backups", backups);

const toolCtx = { toolCallId: "t", messages: [] };

/** Hold an operation on the app until the returned release() is called. */
async function holdOperation(kind: "update" | "install"): Promise<{ release: () => void; done: Promise<unknown>; id: string }> {
  let release!: () => void;
  const done = withAppOperation(APP, kind, "user:bob", () => new Promise<{ success: boolean }>((r) => {
    release = () => r({ success: true });
  }));
  await new Promise((r) => setTimeout(r, 5));
  const id = db.select().from(schema.appOperations).where(eq(schema.appOperations.kind, kind)).get()!.id;
  return { release, done, id };
}

let backupId = "";

beforeEach(async () => {
  vi.clearAllMocks();
  __resetActiveOperationsForTests();
  state.__resetMaintenanceForTests();
  m.gate = null;
  m.observed = [];
  db.run(sql`DELETE FROM app_operation_events`);
  db.run(sql`DELETE FROM app_operations`);
  db.run(sql`DELETE FROM app_catalog`);
  db.run(sql`DELETE FROM store_sources`);
  const { composePath } = await installFakeApp(env.root, APP, COMPOSE, { "config/settings.xml": "<v1/>" });
  db.insert(schema.storeSources).values({ id: "test-store", name: "Test", type: "talome" }).run();
  db.insert(schema.appCatalog).values({ appId: APP, storeSourceId: "test-store", name: "Ops App", version: "1.0.0", source: "talome", composePath }).run();
  resetDocker([{ id: "c1", name: "opsapp-web-1", service: "web", image: "example/web:1" }]);
  m.run.mockImplementation(async (cmd: string) => {
    if (cmd.includes(" up -d")) {
      m.observed.push({ at: "compose-up", appInMaintenance: state.isAppInMaintenance(APP) });
      if (m.gate) await m.gate;
      for (const c of dockerState.containers) c.status = "running";
    }
    return { stdout: "", stderr: "" };
  });
  const b = await createAppBackup(APP);
  if (!b.success) throw new Error(b.error);
  backupId = b.backupId;
  dockerState.events = [];
});

describe("restores are app operations", () => {
  it("journals the restore and starts the app on the restore's own operation (no self-conflict)", async () => {
    const r = await runRestoreOperation(APP, backupId, FAST, { actor: "user:alice" });

    expect(r.success).toBe(true);
    expect(r.conflict).toBeUndefined();
    const op = getOperation(r.operationId!)!;
    expect(op.kind).toBe("restore");
    expect(op.status).toBe("succeeded");
    expect(op.actor).toBe("user:alice");
    expect(op.detail?.backupId).toBe(backupId);
    const steps = listOperationSteps(op.id).map((s) => s.step);
    expect(steps).toEqual(expect.arrayContaining(["checking", "safety-backup", "extracting", "starting", "start:start_containers", "health-check"]));
    // The start ran inside the restore — no separate "start" operation was opened
    expect(db.select().from(schema.appOperations).all().map((o) => o.kind)).toEqual(["restore"]);
    expect(m.run.mock.calls.some((c) => String(c[0]).includes(" up -d"))).toBe(true);
    // Maintenance window held during the start, released afterwards
    expect(m.observed[0]?.appInMaintenance).toBe(true);
    expect(state.getAppMaintenanceReasons(APP)).toEqual([]);
  });

  it("refuses a restore while an update runs on the app — nothing is touched", async () => {
    const held = await holdOperation("update");
    try {
      const r = await runRestoreOperation(APP, backupId, FAST);
      expect(r.success).toBe(false);
      expect(r.conflict).toBe(true);
      expect(r.operationId).toBe(held.id);
      if (!r.success) expect(r.error).toContain("update operation");
      expect(dockerState.events).toEqual([]);

      const res = await admin.request(`/api/backups/${backupId}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("update");

      const tool = (await restoreAppTool.execute!({ appId: APP, backupId, verifyFirst: false }, toolCtx)) as Record<string, unknown>;
      expect(tool.success).toBe(false);
      expect(tool.conflict).toBe(true);
      expect(dockerState.events).toEqual([]);
    } finally {
      held.release();
      await held.done;
    }
  });

  it("refuses an update while a restore runs on the app", async () => {
    let open!: () => void;
    m.gate = new Promise<void>((r) => {
      open = r;
    });
    const restore = runRestoreOperation(APP, backupId, FAST);
    // Wait until the restore reached the start (compose up is gated)
    for (let i = 0; i < 200 && m.observed.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(m.observed.length).toBe(1);

    const upd = await updateApp(APP);
    expect(upd.success).toBe(false);
    expect(upd.conflict).toBe(true);
    expect(upd.error).toContain("restore operation");

    open();
    const r = await restore;
    expect(r.success).toBe(true);
  });

  it("the REST restore endpoint starts a journaled operation", async () => {
    const res = await admin.request(`/api/backups/${backupId}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { operationId: string; restoreId: string };
    expect(body.operationId).toBeTruthy();
    for (let i = 0; i < 400 && getOperation(body.operationId)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 10));
    const op = getOperation(body.operationId)!;
    expect(op.kind).toBe("restore");
    expect(op.actor).toBe("user:alice");
    expect(op.detail?.restoreId).toBe(body.restoreId);
  });
});

describe("backups are app operations", () => {
  it("journals a backup with progress and the backup id", async () => {
    const r = await runBackupOperation(APP, { purpose: "manual" }, { actor: "assistant" });
    expect(r.success).toBe(true);
    const op = getOperation(r.operationId!)!;
    expect(op).toMatchObject({ kind: "backup", status: "succeeded", actor: "assistant" });
    expect(op.detail?.backupId).toBe(r.success ? r.backupId : "");
    expect(listOperationSteps(op.id).map((s) => s.step)).toEqual(expect.arrayContaining(["preparing", "pausing", "archiving", "resuming"]));
  });

  it("backup_app, the trigger endpoint and scheduled backups conflict cleanly with a running update", async () => {
    const held = await holdOperation("update");
    try {
      const tool = (await backupAppTool.execute!({ appId: APP, stopFirst: false, triggeredBy: "manual" }, toolCtx)) as Record<string, unknown>;
      expect(tool.success).toBe(false);
      expect(tool.conflict).toBe(true);

      const res = await admin.request("/api/backups/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: APP }),
      });
      expect(res.status).toBe(409);

      const schedule = { id: "s1", app_id: APP, cron: "0 2 * * *", cloud_target: null, retention_days: 30, enabled: 1, last_run_at: null, created_at: new Date().toISOString() };
      // Waits (bounded) for the update, then gives up with a "skipped" notice
      const scheduled = await runScheduledBackup(schedule, APP, { conflictWaitMs: 30 });
      expect(scheduled.success).toBe(false);
      expect(m.writeNotification).toHaveBeenCalledWith("warning", "Backup skipped", expect.stringContaining(APP), APP, { dedupe: false });

      // Nothing was stopped
      expect(dockerState.events).toEqual([]);
    } finally {
      held.release();
      await held.done;
    }
  });

  it("a scheduled backup that collides with an update waits for it and then runs", async () => {
    const held = await holdOperation("update");
    const schedule = { id: "s2", app_id: APP, cron: "0 2 * * *", cloud_target: null, retention_days: 30, enabled: 1, last_run_at: null, created_at: new Date().toISOString() };
    const scheduled = runScheduledBackup(schedule, APP, { conflictWaitMs: 5_000 });
    await new Promise((r) => setTimeout(r, 30));
    // Still waiting: nothing stopped while the update runs
    expect(dockerState.events).toEqual([]);
    held.release();
    await held.done;

    const result = await scheduled;
    expect(result.success).toBe(true);
    expect(m.writeNotification).not.toHaveBeenCalledWith("warning", "Backup skipped", expect.anything(), expect.anything(), expect.anything());
    expect(m.writeNotification).toHaveBeenCalledWith("info", "Backup completed", expect.stringContaining(APP), APP, { dedupe: false });
    const ops = db.select().from(schema.appOperations).all().map((o) => `${o.kind}:${o.status}`);
    expect(ops).toEqual(expect.arrayContaining(["update:succeeded", "backup:succeeded"]));
  });

  it("the trigger endpoint returns the operation id of the background backup", async () => {
    const res = await admin.request("/api/backups/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: APP }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { operationId: string };
    for (let i = 0; i < 400 && getOperation(body.operationId)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(getOperation(body.operationId)).toMatchObject({ kind: "backup", status: "succeeded", actor: "user:alice" });
  });
});
