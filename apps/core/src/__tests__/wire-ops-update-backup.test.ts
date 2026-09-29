import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { prepareBackupEnv, installFakeApp, resetDocker, dockerState } from "./helpers/backups-fixture.js";

// Updates + real backup engine + real operations journal. Docker is an
// in-memory double (backup/docker-ops.ts) and `docker compose` is a mock.

const m = vi.hoisted(() => {
  // A suspected semantic regression is re-checked once — no real wait in tests.
  process.env.TALOME_SEMANTIC_VERIFY_RETRY_MS = "1";
  return {
    run: vi.fn(),
    captureServiceImages: vi.fn(),
    verifyAppHealth: vi.fn(),
    restoreServiceImages: vi.fn(),
    probeHttp: vi.fn(),
    writeNotification: vi.fn(),
    isVerifiableApp: vi.fn((_id: string) => false),
    getLatestVerificationResult: vi.fn((_type: string, _id: string): { status: string } | null => null),
    verifyApp: vi.fn(),
    observed: [] as Array<{ at: string; appInMaintenance: boolean; containerInWindow: boolean }>,
  };
});

vi.mock("../backup/docker-ops.js", async () => (await import("./helpers/backups-fixture.js")).dockerOpsMock());
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
vi.mock("../ops/docker-probe.js", () => ({
  captureServiceImages: m.captureServiceImages,
  verifyAppHealth: m.verifyAppHealth,
  restoreServiceImages: m.restoreServiceImages,
  probeHttp: m.probeHttp,
}));
vi.mock("../verification/index.js", () => ({
  isVerifiableApp: m.isVerifiableApp,
  getLatestVerificationResult: m.getLatestVerificationResult,
  verifyApp: m.verifyApp,
}));
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

const env = prepareBackupEnv("wire-ops-update-backup");
const { runMigrations } = await import("../db/migrate.js");
runMigrations();
const { db, schema } = await import("../db/index.js");
const { eq, sql } = await import("drizzle-orm");
const { updateApp, rollbackUpdate } = await import("../stores/lifecycle.js");
const { getOperation, listOperationSteps, __resetActiveOperationsForTests } = await import("../ops/operations.js");
const state = await import("../backup/state.js");

afterAll(() => env.cleanup());

const APP = "bkapp";
const COMPOSE = `services:
  web:
    image: example/web:1
    volumes:
      - ./config:/config
`;
const NAMED_ONLY = `services:
  web:
    image: example/web:1
    volumes:
      - webdata:/data
volumes:
  webdata: {}
`;

const BASELINE = [{
  service: "web",
  containerId: "c1",
  containerName: "bkapp-web-1",
  imageRef: "example/web:1",
  imageId: "sha256:" + "a".repeat(64),
  repoDigest: "example/web@sha256:" + "b".repeat(64),
  status: "running",
}];
const AFTER = [{ ...BASELINE[0], containerId: "c2", imageId: "sha256:" + "e".repeat(64) }];
const healthy = { healthy: true, verdict: "healthy", reason: "ok", containers: [], checks: 3, elapsedMs: 10 };

function commands(): string[] {
  return m.run.mock.calls.map((c) => String(c[0]));
}

function observe(at: string): void {
  m.observed.push({
    at,
    appInMaintenance: state.isAppInMaintenance(APP),
    containerInWindow: state.isContainerInBackupWindow("bkapp-web-1", "c2"),
  });
}

async function setupApp(compose = COMPOSE, preBackup = true): Promise<void> {
  db.run(sql`DELETE FROM app_operation_events`);
  db.run(sql`DELETE FROM app_operations`);
  db.run(sql`DELETE FROM update_snapshots`);
  db.run(sql`DELETE FROM backups`);
  db.run(sql`DELETE FROM app_update_policies`);
  db.run(sql`DELETE FROM app_catalog`);
  db.run(sql`DELETE FROM store_sources`);
  const { composePath } = await installFakeApp(env.root, APP, compose, { "config/settings.xml": "<x/>" });
  db.insert(schema.storeSources).values({ id: "test-store", name: "Test", type: "talome" }).run();
  db.insert(schema.appCatalog).values({ appId: APP, storeSourceId: "test-store", name: "Bk App", version: "1.1.0", source: "talome", composePath }).run();
  if (preBackup) {
    db.run(sql`INSERT INTO app_update_policies (app_id, policy, pre_backup, created_at) VALUES (${APP}, 'manual', 1, ${new Date().toISOString()})`);
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  __resetActiveOperationsForTests();
  state.__resetMaintenanceForTests();
  m.observed = [];
  resetDocker([{ id: "c1", name: "bkapp-web-1", service: "web", image: "example/web:1" }]);
  dockerState.onStop = () => observe("backup-stop");
  await setupApp();
  m.run.mockImplementation(async (cmd: string) => {
    if (cmd.includes(" up -d")) observe(cmd.includes("--force-recreate") ? "rollback-recreate" : "recreate");
    return { stdout: "", stderr: "" };
  });
  m.captureServiceImages.mockReset();
  m.captureServiceImages.mockResolvedValueOnce(BASELINE).mockResolvedValue(AFTER);
  m.verifyAppHealth.mockResolvedValue(healthy);
  m.restoreServiceImages.mockResolvedValue([{ service: "web", restored: true, method: "tag" }]);
  m.probeHttp.mockResolvedValue({ port: 0, ok: false });
  m.isVerifiableApp.mockReturnValue(false);
  m.getLatestVerificationResult.mockReturnValue(null);
});

describe("pre-update backup through the backup engine", () => {
  it("takes an application-consistent backup inside the update operation without conflict or deadlock", async () => {
    const result = await updateApp(APP, { actor: "user:alice" });

    expect(result).toMatchObject({ success: true, outcome: "updated" });
    expect(result.conflict).toBeUndefined();
    expect(result.preUpdateBackupId).toBeTruthy();

    // The backup is a real engine backup (manifest, stop method, pre-update purpose)
    const backup = db.select().from(schema.backups).where(eq(schema.backups.id, result.preUpdateBackupId!)).get()!;
    expect(backup.status).toBe("completed");
    expect(backup.purpose).toBe("pre-update");
    expect(backup.method).toBe("stop");
    expect(backup.manifestPath).toBeTruthy();

    // The app was stopped for the backup and started again BEFORE containers were recreated
    const stopIdx = dockerState.events.indexOf("stop:c1");
    const startIdx = dockerState.events.indexOf("start:c1");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(stopIdx);
    const upCall = m.run.mock.calls.findIndex((c) => String(c[0]).includes(" up -d"));
    expect(upCall).toBeGreaterThanOrEqual(0);

    // Backup id recorded on the operation and the archive on the update snapshot
    const op = getOperation(result.operationId!)!;
    expect(op.kind).toBe("update");
    expect(op.status).toBe("succeeded");
    expect((op.detail?.backup as { backupId?: string }).backupId).toBe(result.preUpdateBackupId);
    const snapshot = db.select().from(schema.updateSnapshots).get()!;
    expect(snapshot.backupPath).toBe(backup.filePath);

    // Only the update operation was journaled — the backup ran inside it
    expect(db.select().from(schema.appOperations).all()).toHaveLength(1);
  });

  it("aborts the update before recreating containers when the pre-update backup fails", async () => {
    dockerState.failStopIds.add("c1");

    const result = await updateApp(APP);

    expect(result.success).toBe(false);
    expect(result.backupFailed).toBe(true);
    expect(result.error).toContain("Pre-update backup failed");
    expect(result.error).toContain("force");
    // Images were pulled, but nothing was recreated
    expect(commands().some((c) => c.includes(" pull"))).toBe(true);
    expect(commands().some((c) => c.includes(" up -d"))).toBe(false);
    // The backup engine started the container it tried to stop again
    expect(dockerState.events).toContain("start:c1");

    const row = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, APP)).get()!;
    expect(row.status).toBe("running");
    expect(row.version).toBe("1.0.0");
    expect(db.select().from(schema.updateSnapshots).all()).toHaveLength(0);

    const op = getOperation(result.operationId!)!;
    expect(op.status).toBe("failed");
    expect(op.detail?.backupFailed).toBe(true);
    expect(op.detail?.appTouched).toBe(false);
    expect(m.writeNotification).toHaveBeenCalledWith("warning", "Update of Bk App aborted", expect.stringContaining("keeps running version 1.0.0"), APP);
  });

  it("aborts when another backup of the app holds the backup lock", async () => {
    const handle = state.acquireAppOperation(APP, "backup", "scheduled-backup")!;
    try {
      const result = await updateApp(APP);
      expect(result.success).toBe(false);
      expect(result.backupFailed).toBe(true);
      expect(result.error).toContain("already running");
      expect(commands().some((c) => c.includes(" up -d"))).toBe(false);
    } finally {
      handle.release();
    }
  });

  it("proceeds without a backup when the update is forced", async () => {
    dockerState.failStopIds.add("c1");

    const result = await updateApp(APP, { force: true });

    expect(result).toMatchObject({ success: true, outcome: "updated" });
    expect(result.preUpdateBackupId).toBeUndefined();
    expect(commands().some((c) => c.includes(" up -d"))).toBe(true);
    const op = getOperation(result.operationId!)!;
    expect(op.detail?.backupForced).toBe(true);
    expect(op.detail?.force).toBe(true);
    expect((op.detail?.backup as { success: boolean }).success).toBe(false);
  });

  it("treats an app with nothing to back up as a skip, not a failure", async () => {
    await setupApp(NAMED_ONLY);

    const result = await updateApp(APP);

    expect(result).toMatchObject({ success: true, outcome: "updated" });
    const backup = getOperation(result.operationId!)!.detail?.backup as { skipped?: boolean; code?: string };
    expect(backup.skipped).toBe(true);
    expect(backup.code).toBe("nothing_to_backup");
  });
});

describe("maintenance windows around updates and rollbacks", () => {
  it("holds the app in maintenance during the backup and the recreate, and releases it on success", async () => {
    const result = await updateApp(APP);
    expect(result.success).toBe(true);

    const stop = m.observed.find((o) => o.at === "backup-stop")!;
    const recreate = m.observed.find((o) => o.at === "recreate")!;
    expect(stop.appInMaintenance).toBe(true);
    // Recreated containers (new id) are covered while the update holds the app
    expect(recreate.appInMaintenance).toBe(true);
    expect(recreate.containerInWindow).toBe(true);

    // Released: no hold left (only the short settling grace period remains)
    expect(state.getAppMaintenanceReasons(APP)).toEqual([]);
  });

  it("releases the window when the update fails and its rollback fails too", async () => {
    await setupApp(COMPOSE, false);
    m.run.mockImplementation(async (cmd: string) => {
      if (cmd.includes(" up -d")) {
        observe(cmd.includes("--force-recreate") ? "rollback-recreate" : "recreate");
        throw Object.assign(new Error("compose up failed"), { stderr: "port is already allocated" });
      }
      return { stdout: "", stderr: "" };
    });

    const result = await updateApp(APP);

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(m.observed.find((o) => o.at === "recreate")?.appInMaintenance).toBe(true);
    expect(m.observed.find((o) => o.at === "rollback-recreate")?.appInMaintenance).toBe(true);
    expect(state.getAppMaintenanceReasons(APP)).toEqual([]);
  });

  it("releases the window when the update throws", async () => {
    await setupApp(COMPOSE, false);
    m.verifyAppHealth.mockRejectedValue(new Error("docker socket gone"));

    await expect(updateApp(APP)).rejects.toThrow("docker socket gone");
    expect(state.getAppMaintenanceReasons(APP)).toEqual([]);
  });

  it("a manual rollback holds the window and offers the pre-update backup for a data restore", async () => {
    const updated = await updateApp(APP);
    expect(updated.success).toBe(true);
    m.observed = [];

    const result = await rollbackUpdate(APP);

    expect(result.success).toBe(true);
    expect(result.preUpdateBackupId).toBe(updated.preUpdateBackupId);
    expect(result.dataRestoreHint).toContain(updated.preUpdateBackupId!);
    expect(m.observed.find((o) => o.at === "rollback-recreate")?.appInMaintenance).toBe(true);
    expect(state.getAppMaintenanceReasons(APP)).toEqual([]);
  });
});

describe("semantic verification after updates", () => {
  const verification = (status: string, summary: string) => ({
    ok: true,
    result: {
      targetType: "app",
      targetId: APP,
      status,
      summary,
      checks: [{ id: "api", label: "API key", status: status === "verified" ? "pass" : "fail", evidence: "HTTP 401", durationMs: 1, critical: true, active: false }],
      includeActive: false,
      durationMs: 5,
      verifiedAt: new Date().toISOString(),
    },
  });

  beforeEach(async () => {
    await setupApp(COMPOSE, false);
    m.isVerifiableApp.mockReturnValue(true);
  });

  it("rolls back when a verified app fails its outcome checks after the update", async () => {
    m.getLatestVerificationResult.mockReturnValue({ status: "verified" });
    m.verifyApp.mockResolvedValue(verification("failed", "Bk App: API key rejected"));

    const result = await updateApp(APP);

    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.outcome).toBe("rolled_back");
    expect(result.error).toContain("Outcome verification regressed");
    expect(m.restoreServiceImages).toHaveBeenCalledWith(BASELINE);
    // A suspected regression is confirmed once before acting; the restored version is re-checked.
    expect(m.verifyApp).toHaveBeenCalledTimes(3);

    const op = getOperation(result.operationId!)!;
    expect(op.status).toBe("rolled_back");
    const semantic = op.detail?.semanticVerification as { regression: boolean; baseline: string; status: string; attempts: number };
    expect(semantic).toMatchObject({ regression: true, baseline: "verified", status: "failed", attempts: 2 });
    expect(op.detail?.semanticAfterRollback).toBeTruthy();
    expect(listOperationSteps(op.id).map((s) => s.step)).toEqual(expect.arrayContaining(["verify", "semantic_verify", "rollback"]));
    expect(m.writeNotification).toHaveBeenCalledWith("warning", "Update of Bk App rolled back", expect.stringContaining("Outcome verification regressed"), APP);

    const row = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, APP)).get()!;
    expect(row.version).toBe("1.0.0");
  });

  it("does not roll back when the outcome checks are only degraded", async () => {
    m.getLatestVerificationResult.mockReturnValue({ status: "verified" });
    m.verifyApp.mockResolvedValue(verification("degraded", "Bk App: one indexer failing"));

    const result = await updateApp(APP);

    expect(result).toMatchObject({ success: true, outcome: "updated" });
    expect(result.semanticVerification).toMatchObject({ status: "degraded", regression: false });
    expect(m.restoreServiceImages).not.toHaveBeenCalled();
    expect(m.verifyApp).toHaveBeenCalledTimes(1);
    expect(getOperation(result.operationId!)!.status).toBe("succeeded");
    expect(m.writeNotification).toHaveBeenCalledWith("warning", "Bk App updated, outcome checks degraded", expect.stringContaining("one indexer failing"), APP);
  });

  it("does not roll back a failure that was not verified before the update", async () => {
    m.getLatestVerificationResult.mockReturnValue({ status: "failed" });
    m.verifyApp.mockResolvedValue(verification("failed", "Bk App: API key rejected"));

    const result = await updateApp(APP);

    expect(result).toMatchObject({ success: true, outcome: "updated" });
    expect(result.semanticVerification).toMatchObject({ status: "failed", baseline: "failed", regression: false });
    expect(m.restoreServiceImages).not.toHaveBeenCalled();
  });

  it("records unknown when the outcome probe does not answer in time, without rolling back", async () => {
    m.getLatestVerificationResult.mockReturnValue({ status: "verified" });
    m.verifyApp.mockResolvedValue({ ok: false, code: "probe_error", error: "Verification failed to run: boom" });

    const result = await updateApp(APP);

    expect(result).toMatchObject({ success: true, outcome: "updated" });
    expect(result.semanticVerification).toMatchObject({ status: "unknown", regression: false });
    expect(m.restoreServiceImages).not.toHaveBeenCalled();
  });

  it("skips outcome checks for apps without a probe", async () => {
    m.isVerifiableApp.mockReturnValue(false);
    const result = await updateApp(APP);
    expect(result.success).toBe(true);
    expect(result.semanticVerification).toBeUndefined();
    expect(m.verifyApp).not.toHaveBeenCalled();
    expect(listOperationSteps(result.operationId!).map((s) => s.step)).not.toContain("semantic_verify");
  });
});
