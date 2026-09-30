import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { prepareBackupEnv, installFakeApp, resetDocker, dockerState } from "./helpers/backups-fixture.js";

// Restore rollback and commit semantics. `rename` can be made to fail with
// EBUSY (a volume that is a mount point → restored in place) and `rm` can be
// observed (a crash while the previous data is deleted).

const fsHooks = vi.hoisted(() => ({
  failRename: null as null | ((from: string) => boolean),
  onRm: null as null | ((path: string) => void),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rename = async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
    if (fsHooks.failRename?.(String(from))) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${String(from)}'`), { code: "EBUSY" });
    }
    return actual.rename(from, to);
  };
  const rm = async (path: Parameters<typeof actual.rm>[0], opts?: Parameters<typeof actual.rm>[1]) => {
    fsHooks.onRm?.(String(path));
    return actual.rm(path, opts);
  };
  return { ...actual, rename, rm, default: { ...actual, rename, rm } };
});
vi.mock("../backup/docker-ops.js", async () => (await import("./helpers/backups-fixture.js")).dockerOpsMock());
vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

const env = prepareBackupEnv("backups-restore-rollback");
const { runMigrations } = await import("../db/migrate.js");
runMigrations();
const { db, schema } = await import("../db/index.js");
const { eq } = await import("drizzle-orm");
const { createAppBackup } = await import("../backup/engine.js");
const { restoreAppBackup } = await import("../backup/restore.js");
const { finishRestore, getRestoreRow, insertRestore, listRecoveryRecords, saveRecoveryRecord, updateRestoreStage } = await import("../backup/store.js");
const { recoverPendingOperations } = await import("../backup/recovery.js");

afterAll(() => env.cleanup());
beforeEach(() => {
  fsHooks.failRename = null;
  fsHooks.onRm = null;
});

const FAST = { healthTimeoutMs: 300, pollIntervalMs: 20 };
const TWO_VOLUMES = `services:
  app:
    image: example/app:1.0
    volumes:
      - ./config:/config
      - ./data:/data
`;

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function prepare(appId: string) {
  const { appDir, composePath } = await installFakeApp(env.root, appId, TWO_VOLUMES, { "config/app.conf": "version=1", "data/items.json": "[1]" });
  resetDocker([{ id: `${appId}-c`, name: appId, service: "app", image: "example/app:1.0" }]);
  const backup = await createAppBackup(appId);
  if (!backup.success) throw new Error(backup.error);
  write(join(appDir, "config/app.conf"), "version=2");
  write(join(appDir, "data/items.json"), "[1,2]");
  dockerState.events = [];
  return { appDir, composePath, backup };
}

describe("restore rollback", () => {
  it("undoes the directory swaps even when data changed in place and there is no safety backup", async () => {
    const { appDir, backup } = await prepare("inplacenosafety");
    const dataDir = join(appDir, "data");
    fsHooks.failRename = (from) => from === dataDir; // ./data is a mount point
    dockerState.containers[0].crashOnStart = true;

    const r = await restoreAppBackup(backup.backupId, { ...FAST, skipSafetyBackup: true });
    expect(r.success).toBe(false);
    if (r.success) return;
    // The swapped volume is back to its pre-restore state
    expect(readFileSync(join(appDir, "config/app.conf"), "utf-8")).toBe("version=2");
    expect(readdirSync(appDir).filter((n) => n.includes(".talome-"))).toEqual([]);
    // …but the in-place data cannot be put back, and the result says so
    expect(r.rolledBack).toBe(false);
    expect(r.error).toMatch(/could not be fully restored.*no safety backup/);
    expect(getRestoreRow(r.restoreId!)!.status).toBe("failed");
  });

  it("puts installed_apps.version back when an in-place restore is rolled back", async () => {
    const { appDir, composePath, backup } = await prepare("inplaceversion");
    // The app was updated after the backup
    writeFileSync(composePath, readFileSync(composePath, "utf-8").replace("example/app:1.0", "example/app:2.0"));
    db.update(schema.installedApps).set({ version: "2.0.0" }).where(eq(schema.installedApps.appId, "inplaceversion")).run();
    const dataDir = join(appDir, "data");
    fsHooks.failRename = (from) => from === dataDir;
    dockerState.containers[0].crashOnStart = true;

    const r = await restoreAppBackup(backup.backupId, FAST);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.rolledBack).toBe(true);
    expect(readFileSync(composePath, "utf-8")).toContain("example/app:2.0");
    expect(readFileSync(join(dataDir, "items.json"), "utf-8")).toBe("[1,2]");
    const installed = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, "inplaceversion")).get();
    expect(installed?.version).toBe("2.0.0");
  });

  it("keeps backup_restores.safety_backup_id when the rollback restores the safety backup", async () => {
    const { appDir, backup } = await prepare("inplacesafetyid");
    const dataDir = join(appDir, "data");
    fsHooks.failRename = (from) => from === dataDir; // in place → the rollback restores the safety backup
    dockerState.containers[0].crashOnStart = true;

    const r = await restoreAppBackup(backup.backupId, FAST);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.safetyBackupId).toBeTruthy();
    // The nested restore of the safety backup has no safety backup of its own:
    // its stage updates must not clear the column the dashboard reads
    expect(getRestoreRow(r.restoreId!)!.safety_backup_id).toBe(r.safetyBackupId);
  });

  it("never overwrites a recorded safety backup id with null", () => {
    insertRestore("stage-null-id", "some-backup", "stagenull");
    updateRestoreStage("stage-null-id", "stopping", "safety-1");
    updateRestoreStage("stage-null-id", "stopping", null);
    updateRestoreStage("stage-null-id", "extracting");
    expect(getRestoreRow("stage-null-id")!.safety_backup_id).toBe("safety-1");
    finishRestore("stage-null-id", "rolled_back", "x", { safetyBackupId: null });
    expect(getRestoreRow("stage-null-id")!.safety_backup_id).toBe("safety-1");
  });

  it("records the safety backup id from the final detail when no stage carried it", () => {
    insertRestore("finish-id", "some-backup", "finishid");
    finishRestore("finish-id", "failed", "x", { safetyBackupId: "safety-2" });
    expect(getRestoreRow("finish-id")!.safety_backup_id).toBe("safety-2");
  });
});

describe("restore in place", () => {
  it("keeps nested excluded paths (Umbrel backupIgnore) when a volume is restored in place", async () => {
    const { setAppBackupConfig } = await import("../backup/store.js");
    const { appDir } = await installFakeApp(env.root, "inplaceexcl", TWO_VOLUMES, {
      "config/app.conf": "version=1",
      "data/items.json": "[1]",
      "data/cache/thumb-1.jpg": "thumb 1",
    });
    setAppBackupConfig("inplaceexcl", { excludePatterns: ["data/cache/*"] });
    resetDocker([{ id: "ie", name: "inplaceexcl", service: "app", image: "example/app:1.0" }]);
    const backup = await createAppBackup("inplaceexcl");
    if (!backup.success) throw new Error(backup.error);
    write(join(appDir, "data/items.json"), "[1,2]");
    write(join(appDir, "data/new.txt"), "created later");
    write(join(appDir, "data/cache/thumb-2.jpg"), "thumb 2");
    write(join(appDir, "data/later/deep/file.txt"), "later");
    const dataDir = join(appDir, "data");
    fsHooks.failRename = (from) => from === dataDir; // ./data is a mount point

    const r = await restoreAppBackup(backup.backupId, { ...FAST, skipSafetyBackup: true });
    expect(r.success ? "" : r.error).toBe("");
    expect(readFileSync(join(dataDir, "items.json"), "utf-8")).toBe("[1]");
    expect(existsSync(join(dataDir, "new.txt"))).toBe(false);
    expect(existsSync(join(dataDir, "later"))).toBe(false);
    // excluded content was never in the backup — it must survive the restore
    expect(readFileSync(join(dataDir, "cache/thumb-1.jpg"), "utf-8")).toBe("thumb 1");
    expect(readFileSync(join(dataDir, "cache/thumb-2.jpg"), "utf-8")).toBe("thumb 2");
  });
});

describe("restore commit", () => {
  it("records the restore as committed before deleting the previous data", async () => {
    const { appDir, backup } = await prepare("commitfirst");
    const seen: Array<boolean | undefined> = [];
    fsHooks.onRm = (path) => {
      if (!path.includes(".talome-old-")) return;
      const rec = listRecoveryRecords().find((x) => x.appId === "commitfirst" && x.kind === "restore");
      seen.push(rec?.state.committed);
    };
    const r = await restoreAppBackup(backup.backupId, FAST);
    expect(r.success).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((c) => c === true)).toBe(true);
    expect(readFileSync(join(appDir, "config/app.conf"), "utf-8")).toBe("version=1");
    expect(listRecoveryRecords().some((x) => x.appId === "commitfirst")).toBe(false);
  });

  it("a restart during cleanup finishes the cleanup instead of moving half-deleted data back", async () => {
    const live = join(env.root, "committed-restore", "library");
    const id = "c0ffee00-restore";
    const old = `${live}.talome-old-c0ffee00`;
    write(join(live, "restored.jpg"), "restored");
    write(join(old, "left-over.jpg"), "half deleted");
    insertRestore(id, "some-backup", "committedapp");
    saveRecoveryRecord(id, "committedapp", "restore", {
      swaps: [{ hostPath: live, old, existed: true, carried: [] }],
      restartApp: true,
      committed: true,
    });
    resetDocker([{ id: "cm1", name: "committedapp", service: "app", image: "x" }]);

    const out = await recoverPendingOperations({ backups: new Set(), restores: new Set() }, Date.now() + 1000);
    const o = out.find((x) => x.id === id)!;
    expect(o.committed).toBe(true);
    expect(readFileSync(join(live, "restored.jpg"), "utf-8")).toBe("restored");
    expect(existsSync(join(live, "left-over.jpg"))).toBe(false);
    expect(existsSync(old)).toBe(false);
    expect(readdirSync(dirname(live)).filter((n) => n.includes(".talome-failed"))).toEqual([]);
    expect(getRestoreRow(id)!.status).toBe("completed");
    expect(listRecoveryRecords().some((x) => x.id === id)).toBe(false);
  });
});
