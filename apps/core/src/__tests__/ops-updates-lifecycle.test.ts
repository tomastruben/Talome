import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// Per-file SQLite database — must be set before db/index.ts is imported.
vi.hoisted(() => {
  const tmp = process.env.TMPDIR ?? "/tmp";
  process.env.DATABASE_PATH = `${tmp.replace(/\/$/, "")}/talome-ops-lifecycle-${process.pid}-${Date.now()}.db`;
});

const m = vi.hoisted(() => ({
  run: vi.fn(),
  discoverContainers: vi.fn(async () => ["c0ffee000001"]),
  pinImageDigest: vi.fn(),
  captureServiceImages: vi.fn(),
  verifyAppHealth: vi.fn(),
  restoreServiceImages: vi.fn(),
  probeHttp: vi.fn(),
  isPreUpdateBackupEnabled: vi.fn(() => true),
  takePreUpdateBackup: vi.fn(),
  writeNotification: vi.fn(),
  recordInstallError: vi.fn(),
}));

vi.mock("../stores/compose-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stores/compose-exec.js")>();
  return {
    ...actual,
    run: m.run,
    buildEnv: (_appId: string, env: Record<string, string> = {}) => ({ ...env }),
    writeAppDotEnv: vi.fn(),
    discoverContainers: m.discoverContainers,
    pinImageDigest: m.pinImageDigest,
  };
});

vi.mock("../ops/docker-probe.js", () => ({
  captureServiceImages: m.captureServiceImages,
  verifyAppHealth: m.verifyAppHealth,
  restoreServiceImages: m.restoreServiceImages,
  probeHttp: m.probeHttp,
}));

vi.mock("../ops/pre-update-backup.js", () => ({
  isPreUpdateBackupEnabled: m.isPreUpdateBackupEnabled,
  takePreUpdateBackup: m.takePreUpdateBackup,
}));

vi.mock("../docker/client.js", () => ({
  listContainers: vi.fn(async () => []),
  listNetworks: vi.fn(async () => []),
  removeNetwork: vi.fn(),
  connectContainerToNetwork: vi.fn(),
  docker: {},
}));
vi.mock("../docker/talome-network.js", () => ({
  ensureTalomeNetwork: vi.fn(async () => {}),
  injectTalomeNetwork: vi.fn(),
}));
vi.mock("../db/notifications.js", () => ({ writeNotification: m.writeNotification }));
vi.mock("../stores/compose-errors.js", () => ({ recordInstallError: m.recordInstallError }));
vi.mock("../stores/lifecycle-hooks.js", () => ({ executeHook: vi.fn(async () => {}) }));
vi.mock("../automation/engine.js", () => ({ fireTrigger: vi.fn(async () => []) }));
vi.mock("../proxy/caddy.js", () => ({ autoRegisterProxyRoute: vi.fn(), removeProxyRoutesForApp: vi.fn() }));
vi.mock("../app-registry/auto-configure.js", () => ({ autoConfigureApp: vi.fn() }));
vi.mock("../app-registry/index.js", () => ({ getAppCapabilities: vi.fn(() => null) }));

import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq, desc } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { updateApp, restartApp, rollbackUpdate } from "../stores/lifecycle.js";
import {
  getOperation,
  listOperationSteps,
  withAppOperation,
  __resetActiveOperationsForTests,
} from "../ops/operations.js";
import type { ServiceImageState } from "../ops/docker-probe.js";

const APP_ID = "sonarr";
const STORE_ID = "test-store";
const ORIGINAL_COMPOSE = "services:\n  sonarr:\n    image: linuxserver/sonarr:4\n    restart: unless-stopped\n";

let composeDir = "";
let composePath = "";

const BASELINE: ServiceImageState[] = [{
  service: "sonarr",
  containerId: "c0ffee000001",
  containerName: "sonarr",
  imageRef: "linuxserver/sonarr:4",
  imageId: "sha256:" + "a".repeat(64),
  repoDigest: "linuxserver/sonarr@sha256:" + "b".repeat(64),
  status: "running",
}];

const healthy = { healthy: true, reason: "ok", containers: [], checks: 3, elapsedMs: 10 };
const unhealthy = { healthy: false, reason: "Container sonarr is restarting", containers: [], checks: 40, elapsedMs: 120_000 };

function commands(): string[] {
  return m.run.mock.calls.map((c) => String(c[0]));
}

function installedRow() {
  return db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, APP_ID)).get();
}

function latestOperationId(): string {
  const row = db.select().from(schema.appOperations).orderBy(desc(schema.appOperations.startedAt)).limit(1).get();
  return row!.id;
}

beforeAll(() => {
  runMigrations();
  composeDir = mkdtempSync(join(tmpdir(), "talome-ops-lifecycle-"));
  composePath = join(composeDir, "docker-compose.yml");
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetActiveOperationsForTests();
  writeFileSync(composePath, ORIGINAL_COMPOSE);

  db.delete(schema.appOperationEvents).run();
  db.delete(schema.appOperations).run();
  db.delete(schema.updateSnapshots).run();
  db.delete(schema.installedApps).run();
  db.delete(schema.appCatalog).run();
  db.delete(schema.storeSources).run();

  db.insert(schema.storeSources).values({ id: STORE_ID, name: "Test", type: "talome" }).run();
  db.insert(schema.appCatalog).values({
    appId: APP_ID,
    storeSourceId: STORE_ID,
    name: "Sonarr",
    version: "4.1.0",
    source: "talome",
    composePath,
    webPort: 8989,
  }).run();
  const now = new Date().toISOString();
  db.insert(schema.installedApps).values({
    appId: APP_ID,
    storeSourceId: STORE_ID,
    status: "running",
    envConfig: JSON.stringify({ TZ: "UTC" }),
    containerIds: JSON.stringify(["c0ffee000001"]),
    version: "4.0.0",
    overrideComposePath: composePath,
    installedAt: now,
    updatedAt: now,
  }).run();

  m.run.mockResolvedValue({ stdout: "", stderr: "" });
  m.captureServiceImages.mockResolvedValue(BASELINE);
  m.probeHttp.mockResolvedValue({ port: 8989, ok: true, status: 200 });
  m.restoreServiceImages.mockResolvedValue([{ service: "sonarr", restored: true, method: "tag" }]);
  m.takePreUpdateBackup.mockResolvedValue({ attempted: true, success: true, backupFile: "/backups/sonarr/pre-update.tar.gz" });
  m.isPreUpdateBackupEnabled.mockReturnValue(true);
});

describe("safe update pipeline", () => {
  it("pull failure leaves the app untouched (never stopped or recreated)", async () => {
    m.run.mockImplementation(async (cmd: string) => {
      if (cmd.includes(" pull")) throw Object.assign(new Error("pull failed"), { stderr: "manifest unknown" });
      return { stdout: "", stderr: "" };
    });

    const result = await updateApp(APP_ID);

    expect(result.success).toBe(false);
    expect(result.error).toContain("app left unchanged");
    const cmds = commands();
    expect(cmds.every((c) => c.includes(" pull"))).toBe(true);
    expect(cmds.some((c) => /\b(up|down|stop|restart|rm)\b/.test(c))).toBe(false);
    expect(m.takePreUpdateBackup).not.toHaveBeenCalled();
    expect(m.restoreServiceImages).not.toHaveBeenCalled();

    const row = installedRow()!;
    expect(row.status).toBe("running");
    expect(row.version).toBe("4.0.0");
    // Snapshot of a state that was never left is discarded
    expect(db.select().from(schema.updateSnapshots).all()).toHaveLength(0);

    const op = getOperation(result.operationId!)!;
    expect(op.status).toBe("failed");
    expect(op.detail?.appTouched).toBe(false);
    expect(m.writeNotification).toHaveBeenCalledWith("warning", "Update of Sonarr failed", expect.stringContaining("nothing was changed"), APP_ID);
  });

  it("captures the rollback snapshot before pulling and pulls before recreating", async () => {
    m.verifyAppHealth.mockResolvedValue(healthy);

    const result = await updateApp(APP_ID, { actor: "user:alice" });

    expect(result).toMatchObject({ success: true, verified: true });
    const pullCall = m.run.mock.calls.findIndex((c) => String(c[0]).includes(" pull"));
    const upCall = m.run.mock.calls.findIndex((c) => String(c[0]).includes(" up -d"));
    expect(pullCall).toBeGreaterThanOrEqual(0);
    expect(upCall).toBeGreaterThan(pullCall);
    expect(m.captureServiceImages.mock.invocationCallOrder[0]).toBeLessThan(m.run.mock.invocationCallOrder[pullCall]);
    expect(m.takePreUpdateBackup.mock.invocationCallOrder[0]).toBeGreaterThan(m.run.mock.invocationCallOrder[pullCall]);
    expect(m.takePreUpdateBackup.mock.invocationCallOrder[0]).toBeLessThan(m.run.mock.invocationCallOrder[upCall]);

    const snapshot = db.select().from(schema.updateSnapshots).get()!;
    expect(snapshot.previousCompose).toBe(ORIGINAL_COMPOSE);
    expect(JSON.parse(snapshot.previousImages!)).toEqual(BASELINE);
    expect(JSON.parse(snapshot.previousEnv!)).toEqual({ TZ: "UTC" });
    expect(snapshot.backupPath).toBe("/backups/sonarr/pre-update.tar.gz");
    expect(snapshot.newVersion).toBe("4.1.0");

    const row = installedRow()!;
    expect(row.status).toBe("running");
    expect(row.version).toBe("4.1.0");

    // Verification required the services that were running and the web UI that answered before
    expect(m.verifyAppHealth).toHaveBeenCalledWith(APP_ID, expect.objectContaining({
      requiredServices: ["sonarr"],
      webPort: 8989,
      requireHttp: true,
    }));

    const op = getOperation(result.operationId!)!;
    expect(op.status).toBe("succeeded");
    expect(op.actor).toBe("user:alice");
    expect((op.detail?.backup as { success: boolean }).success).toBe(true);
  });

  it("persists honest progress steps in order", async () => {
    m.verifyAppHealth.mockResolvedValue(healthy);
    const result = await updateApp(APP_ID);
    const steps = listOperationSteps(result.operationId!);
    expect(steps.map((s) => s.step)).toEqual([
      "starting", "preflight", "snapshot", "pull", "pull", "backup", "recreate", "verify", "finalize", "done",
    ]);
    const progress = steps.map((s) => s.progress);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(steps.at(-1)?.status).toBe("succeeded");
  });

  it("verification failure triggers automatic rollback, re-verification and a rolled_back record", async () => {
    m.verifyAppHealth.mockResolvedValueOnce(unhealthy).mockResolvedValueOnce(healthy);
    // Simulate the update having rewritten the compose file
    m.run.mockImplementation(async (cmd: string) => {
      if (cmd.endsWith(" up -d") || cmd.includes(" up -d\"")) writeFileSync(composePath, "services: {}\n");
      return { stdout: "", stderr: "" };
    });

    const result = await updateApp(APP_ID);

    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain("Container sonarr is restarting");
    expect(result.error).toContain("Rolled back to version 4.0.0");

    // Rollback restored images + compose and recreated
    expect(m.restoreServiceImages).toHaveBeenCalledWith(BASELINE);
    expect(commands().some((c) => c.includes("up -d --force-recreate --remove-orphans"))).toBe(true);
    expect(readFileSync(composePath, "utf-8")).toBe(ORIGINAL_COMPOSE);
    expect(m.verifyAppHealth).toHaveBeenCalledTimes(2);

    const row = installedRow()!;
    expect(row.version).toBe("4.0.0");
    expect(row.status).toBe("running");

    const snapshot = db.select().from(schema.updateSnapshots).get()!;
    expect(snapshot.rolledBack).toBe(true);
    expect(snapshot.rollbackReason).toContain("Health verification failed");

    const op = getOperation(result.operationId!)!;
    expect(op.status).toBe("rolled_back");
    expect(op.error).toContain("Health verification failed");
    expect(String(op.detail?.irreversibleNote)).toContain("cannot undo data");
    expect(listOperationSteps(op.id).map((s) => s.step)).toContain("rollback");

    expect(m.writeNotification).toHaveBeenCalledWith(
      "warning",
      "Update of Sonarr rolled back",
      expect.stringContaining("/backups/sonarr/pre-update.tar.gz"),
      APP_ID,
    );
  });

  it("recreate failure also rolls back", async () => {
    m.verifyAppHealth.mockResolvedValue(healthy);
    let ups = 0;
    m.run.mockImplementation(async (cmd: string) => {
      if (cmd.includes(" up -d") && !cmd.includes("--force-recreate")) {
        ups++;
        throw Object.assign(new Error("up failed"), { stderr: "port is already allocated" });
      }
      return { stdout: "", stderr: "" };
    });

    const result = await updateApp(APP_ID);
    expect(ups).toBe(1);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain("port is already allocated");
    expect(getOperation(result.operationId!)!.status).toBe("rolled_back");
  });

  it("marks the app error and the operation failed when rollback cannot recover", async () => {
    m.verifyAppHealth.mockResolvedValue(unhealthy);
    const result = await updateApp(APP_ID);
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(installedRow()!.status).toBe("error");
    expect(getOperation(result.operationId!)!.status).toBe("failed");
    expect(m.writeNotification).toHaveBeenCalledWith("critical", expect.stringContaining("could not be rolled back"), expect.any(String), APP_ID);
  });

  it("records a skipped backup when the update policy disables it", async () => {
    m.isPreUpdateBackupEnabled.mockReturnValue(false);
    m.verifyAppHealth.mockResolvedValue(healthy);
    const result = await updateApp(APP_ID);
    expect(m.takePreUpdateBackup).not.toHaveBeenCalled();
    const backup = getOperation(result.operationId!)!.detail?.backup as { attempted: boolean; reason: string };
    expect(backup.attempted).toBe(false);
    expect(backup.reason).toContain("update policy");
  });
});

describe("lifecycle entry points use the per-app operation lock", () => {
  it("rejects a conflicting operation with conflict=true and the running op id", async () => {
    let release!: () => void;
    const held = withAppOperation(APP_ID, "backup", "system", () => new Promise<{ success: boolean }>((r) => {
      release = () => r({ success: true });
    }));
    await new Promise((r) => setTimeout(r, 5));
    const runningId = latestOperationId();

    const result = await restartApp(APP_ID);
    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.operationId).toBe(runningId);
    expect(result.error).toContain("backup operation");
    expect(m.run).not.toHaveBeenCalled();

    const upd = await updateApp(APP_ID);
    expect(upd.conflict).toBe(true);

    release();
    await held;
  });

  it("manual rollback restores the latest snapshot as a journaled rollback operation", async () => {
    m.verifyAppHealth.mockResolvedValue(healthy);
    await updateApp(APP_ID);
    writeFileSync(composePath, "services: {}\n");

    const result = await rollbackUpdate(APP_ID, { actor: "assistant" });
    expect(result).toMatchObject({ success: true, rolledBackTo: "4.0.0", verified: true });
    expect(readFileSync(composePath, "utf-8")).toBe(ORIGINAL_COMPOSE);
    expect(m.restoreServiceImages).toHaveBeenCalledWith(BASELINE);
    const op = getOperation(result.operationId!)!;
    expect(op.kind).toBe("rollback");
    expect(op.actor).toBe("assistant");
    expect(op.status).toBe("succeeded");
    expect(installedRow()!.version).toBe("4.0.0");
  });
});
