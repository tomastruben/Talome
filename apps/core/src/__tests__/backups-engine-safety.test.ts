import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { prepareBackupEnv, installFakeApp, resetDocker, dockerState } from "./helpers/backups-fixture.js";

vi.mock("../backup/docker-ops.js", async () => (await import("./helpers/backups-fixture.js")).dockerOpsMock());
vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

const env = prepareBackupEnv("backups-engine-safety");
const { runMigrations } = await import("../db/migrate.js");
runMigrations();
const { createAppBackup, deleteBackup } = await import("../backup/engine.js");
const { getBackupRow, listRecoveryRecords, saveRecoveryRecord, insertRestore, recoverInterruptedOperations } = await import("../backup/store.js");
const { isContainerInBackupWindow, cancelAppBackup, acquireAppOperation, tryStartVerify, endVerify } = await import("../backup/state.js");
const { loadManifest, verifyBackup } = await import("../backup/verify.js");
const { recoverPendingOperations } = await import("../backup/recovery.js");
const { writeNotification } = await import("../db/notifications.js");

afterAll(() => env.cleanup());
beforeEach(() => {
  vi.mocked(writeNotification).mockClear();
});

const TWO_SERVICE_COMPOSE = `services:
  web:
    image: example/web:1
    volumes:
      - ./config:/config
  worker:
    image: example/worker:1
    volumes:
      - ./config:/config
`;

describe("stop method — containers are always restarted", () => {
  it("restarts already-stopped containers when stopping the next one fails", async () => {
    await installFakeApp(env.root, "stopfail", TWO_SERVICE_COMPOSE, { "config/a.txt": "a" });
    resetDocker([
      { id: "a1", name: "stopfail-web", service: "web", image: "example/web:1" },
      { id: "b1", name: "stopfail-worker", service: "worker", image: "example/worker:1" },
    ]);
    dockerState.failStopIds.add("b1");

    const result = await createAppBackup("stopfail", { method: "stop" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("stop timeout");
    // both were running before — both are running again
    expect(dockerState.containers.every((c) => c.status === "running")).toBe(true);
    expect(dockerState.events.filter((e) => e.startsWith("start:")).sort()).toEqual(["start:a1", "start:b1"]);
    expect(getBackupRow(result.backupId!)!.status).toBe("failed");
    // no alert suppression left behind forever, no pending recovery work
    await new Promise((r) => setTimeout(r, 5));
    expect(listRecoveryRecords().filter((r) => r.id === result.backupId)).toEqual([]);
  });

  it("releases the maintenance window after a failed stop", async () => {
    await installFakeApp(env.root, "windowfail", TWO_SERVICE_COMPOSE, { "config/a.txt": "a" });
    resetDocker([{ id: "w1", name: "windowfail-web", service: "web", image: "example/web:1" }]);
    dockerState.failStopIds.add("w1");
    const result = await createAppBackup("windowfail", { method: "stop" });
    expect(result.success).toBe(false);
    // Only a short grace period remains — not an endless alert blackout
    const later = Date.now() + 10 * 60 * 1000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      expect(isContainerInBackupWindow("windowfail-web")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("restarts containers when the backup is cancelled while pausing", async () => {
    await installFakeApp(env.root, "cancelpause", TWO_SERVICE_COMPOSE, { "config/a.txt": "a" });
    resetDocker([
      { id: "p1", name: "cancelpause-web", service: "web", image: "example/web:1" },
      { id: "p2", name: "cancelpause-worker", service: "worker", image: "example/worker:1" },
    ]);
    let stops = 0;
    dockerState.onStop = () => {
      stops++;
      if (stops === 1) cancelAppBackup("cancelpause");
    };
    const result = await createAppBackup("cancelpause", { method: "stop" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("Cancelled by user");
    expect(getBackupRow(result.backupId!)!.status).toBe("cancelled");
    // the second container was never stopped; the first one is running again
    expect(dockerState.events).toEqual(["stop:p1", "start:p1"]);
    expect(dockerState.containers.every((c) => c.status === "running")).toBe(true);
  });

  it("restarts containers when reading the compose file fails after stopping", async () => {
    const { composePath } = await installFakeApp(env.root, "composefail", TWO_SERVICE_COMPOSE, { "config/a.txt": "a" });
    resetDocker([{ id: "cf1", name: "composefail-web", service: "web", image: "example/web:1" }]);
    dockerState.onStop = () => {
      // compose disappears mid-backup (e.g. app being uninstalled)
      chmodSync(composePath, 0o000);
    };
    const result = await createAppBackup("composefail", { method: "stop" });
    chmodSync(composePath, 0o644);
    if (process.getuid?.() === 0) return; // root can read anything
    expect(result.success).toBe(false);
    expect(dockerState.containers[0].status).toBe("running");
    expect(dockerState.events).toEqual(["stop:cf1", "start:cf1"]);
  });
});

describe("crash recovery", () => {
  it("starts containers a backup had stopped when the server restarted mid-backup", async () => {
    resetDocker([{ id: "r1", name: "crashapp", service: "app", image: "x", status: "exited" }]);
    saveRecoveryRecord("crashed-backup", "crashapp", "backup", { containers: [{ id: "r1", name: "crashapp" }] });
    const out = await recoverPendingOperations({ backups: new Set(), restores: new Set() }, Date.now() + 1000);
    expect(out.find((o) => o.id === "crashed-backup")?.restarted).toBe(1);
    expect(dockerState.containers[0].status).toBe("running");
    expect(listRecoveryRecords().some((r) => r.id === "crashed-backup")).toBe(false);
    expect(vi.mocked(writeNotification)).toHaveBeenCalledWith("warning", expect.stringContaining("interrupted"), expect.any(String), "crashapp");
  });

  it("puts swapped data back when the server restarted mid-restore", async () => {
    const live = join(env.root, "crash-restore", "data");
    const old = `${live}.talome-old-abcd1234`;
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "keep.txt"), "original");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "keep.txt"), "half restored");
    insertRestore("abcd1234-restore", "some-backup", "crashrestore");
    saveRecoveryRecord("abcd1234-restore", "crashrestore", "restore", {
      swaps: [{ hostPath: live, old, existed: true, carried: [] }],
      restartApp: true,
    });
    resetDocker([{ id: "cr1", name: "crashrestore", service: "app", image: "x", status: "exited" }]);
    const out = await recoverPendingOperations({ backups: new Set(), restores: new Set() }, Date.now() + 1000);
    const o = out.find((x) => x.id === "abcd1234-restore")!;
    expect(o.undone).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(live, "keep.txt"), "utf-8")).toBe("original");
    expect(existsSync(old)).toBe(false);
    expect(dockerState.events).toContain("startApp");
    const { getRestoreRow } = await import("../backup/store.js");
    expect(getRestoreRow("abcd1234-restore")!.status).toBe("rolled_back");
  });

  it("skips operations that are still running", async () => {
    saveRecoveryRecord("live-op", "liveapp", "backup", { containers: [{ id: "x", name: "x" }] });
    const out = await recoverPendingOperations({ backups: new Set(["live-op"]), restores: new Set() }, Date.now() + 1000);
    expect(out.some((o) => o.id === "live-op")).toBe(false);
    expect(listRecoveryRecords().some((r) => r.id === "live-op")).toBe(true);
    // records written by the current process (e.g. a restore's safety backup) are left alone too
    saveRecoveryRecord("inner-safety", "liveapp", "backup", { containers: [{ id: "x", name: "x" }] });
    const again = await recoverPendingOperations({ backups: new Set(["live-op"]), restores: new Set() });
    expect(again.some((o) => o.id === "inner-safety")).toBe(false);
  });
});

describe("crash recovery — operations of other processes (MCP stdio)", () => {
  async function foreignRestore(appId: string, id: string, opts: { ownerPid: number; heartbeatAgoMs: number }) {
    const { db, schema } = await import("../db/index.js");
    const { sql } = await import("drizzle-orm");
    const { OWNER_HOST } = await import("../ops/operations.js");
    const live = join(env.root, `foreign-${appId}`, "data");
    const old = `${live}.talome-old-${id.slice(0, 8)}`;
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "keep.txt"), "original");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "keep.txt"), "half restored");
    const opId = `op-${id}`;
    const now = new Date().toISOString();
    const heartbeat = new Date(Date.now() - opts.heartbeatAgoMs).toISOString();
    db.insert(schema.appOperations)
      .values({ id: opId, appId, kind: "restore", actor: "mcp_stdio", status: "running", step: "restoring-files", progress: 60, startedAt: now, updatedAt: now, heartbeatAt: heartbeat, ownerPid: opts.ownerPid, ownerHost: OWNER_HOST })
      .run();
    insertRestore(id, "some-backup", appId);
    // Written just now by the other process (after this "server" started)
    const state = { swaps: [{ hostPath: live, old, existed: true, carried: [] }], restartApp: true, owner: { pid: opts.ownerPid, host: OWNER_HOST, operationId: opId } };
    db.run(sql`INSERT INTO backup_recovery (id, app_id, kind, state, updated_at) VALUES (${id}, ${appId}, 'restore', ${JSON.stringify(state)}, ${now})`);
    return { live, old, opId };
  }

  function deadPid(): number {
    const pid = spawnSync(process.execPath, ["-e", ""]).pid;
    if (!pid) throw new Error("no pid");
    return pid;
  }

  it("never undoes a restore another live process is still running — even at a later server boot", async () => {
    const { live } = await foreignRestore("foreignlive", "f1111111-restore", { ownerPid: process.ppid, heartbeatAgoMs: 1_000 });
    resetDocker([{ id: "fl1", name: "foreignlive", service: "app", image: "x", status: "exited" }]);
    // A server that started after the record was written
    const out = await recoverPendingOperations({ backups: new Set(), restores: new Set() }, Date.now() + 1000);
    expect(out.some((o) => o.id === "f1111111-restore")).toBe(false);
    expect(readFileSync(join(live, "keep.txt"), "utf-8")).toBe("half restored");
    expect(listRecoveryRecords().some((r) => r.id === "f1111111-restore")).toBe(true);
    expect(dockerState.events).not.toContain("startApp");
  });

  it("undoes the work of a process that died, while the server keeps running", async () => {
    const pid = deadPid();
    const { live, old } = await foreignRestore("foreigndead", "f2222222-restore", { ownerPid: pid, heartbeatAgoMs: 5 * 60_000 });
    resetDocker([{ id: "fd1", name: "foreigndead", service: "app", image: "x", status: "exited" }]);
    // Default startedAt: this process started before the record was written
    const out = await recoverPendingOperations({ backups: new Set(), restores: new Set() });
    expect(out.find((o) => o.id === "f2222222-restore")?.undone).toBe(true);
    expect(readFileSync(join(live, "keep.txt"), "utf-8")).toBe("original");
    expect(existsSync(old)).toBe(false);
    expect(dockerState.events).toContain("startApp");
  });

  it("does not mark the rows of a live foreign operation as interrupted", async () => {
    const { db, schema } = await import("../db/index.js");
    const { sql } = await import("drizzle-orm");
    const { OWNER_HOST, hasLiveOperation } = await import("../ops/operations.js");
    const now = new Date().toISOString();
    db.insert(schema.appOperations)
      .values({ id: "op-busy", appId: "busyapp", kind: "backup", actor: "mcp_stdio", status: "running", step: "archiving", progress: 40, startedAt: now, updatedAt: now, heartbeatAt: now, ownerPid: process.ppid, ownerHost: OWNER_HOST })
      .run();
    db.run(sql`INSERT INTO backups (id, app_id, status, started_at, triggered_by) VALUES ('busy-backup', 'busyapp', 'running', ${now}, 'manual')`);
    db.run(sql`INSERT INTO backups (id, app_id, status, started_at, triggered_by) VALUES ('dead-backup', 'deadapp', 'running', ${now}, 'manual')`);
    recoverInterruptedOperations({ backups: new Set(), restores: new Set(), verifies: new Set() }, { isAppBusy: hasLiveOperation });
    expect(getBackupRow("busy-backup")!.status).toBe("running");
    expect(getBackupRow("dead-backup")!.status).toBe("failed");
  });

  it("the server's recovery pass leaves a live stdio backup alone", async () => {
    const { db } = await import("../db/index.js");
    const { sql } = await import("drizzle-orm");
    const { OWNER_HOST } = await import("../ops/operations.js");
    const { runBackupRecovery } = await import("../backup/scheduler.js");
    const now = new Date().toISOString();
    const { schema } = await import("../db/index.js");
    db.insert(schema.appOperations)
      .values({ id: "op-stdio-backup", appId: "stdiobackup", kind: "backup", actor: "mcp_stdio", status: "running", step: "archiving", progress: 40, startedAt: now, updatedAt: now, heartbeatAt: now, ownerPid: process.ppid, ownerHost: OWNER_HOST })
      .run();
    db.run(sql`INSERT INTO backups (id, app_id, status, started_at, triggered_by) VALUES ('stdio-b1', 'stdiobackup', 'running', ${now}, 'manual')`);
    const state = { containers: [{ id: "sb1", name: "stdiobackup" }], owner: { pid: process.ppid, host: OWNER_HOST, operationId: "op-stdio-backup" } };
    db.run(sql`INSERT INTO backup_recovery (id, app_id, kind, state, updated_at) VALUES ('stdio-b1', 'stdiobackup', 'backup', ${JSON.stringify(state)}, ${now})`);
    resetDocker([{ id: "sb1", name: "stdiobackup", service: "app", image: "x", status: "exited" }]);
    await runBackupRecovery();
    // containers stay stopped for the archive, and the row is not failed
    expect(dockerState.containers[0].status).toBe("exited");
    expect(getBackupRow("stdio-b1")!.status).toBe("running");
    expect(listRecoveryRecords().some((r) => r.id === "stdio-b1")).toBe(true);
  });
});

describe("incomplete backups", () => {
  it("records unreadable paths in the manifest and fails verification", async () => {
    if (process.getuid?.() === 0) return; // permissions don't apply to root
    const { appDir } = await installFakeApp(env.root, "unreadable", `services:
  app:
    image: example/app:1
    volumes:
      - ./config:/config
`, { "config/ok.txt": "fine", "config/secret/db.bin": "owned by container user" });
    chmodSync(join(appDir, "config/secret"), 0o000);
    resetDocker([]);
    const result = await createAppBackup("unreadable", { method: "live" });
    chmodSync(join(appDir, "config/secret"), 0o755);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.warnings.some((w) => w.includes("incomplete"))).toBe(true);
    const m = await loadManifest(result.manifestPath);
    expect(m.ok && m.manifest.unreadable).toEqual([expect.stringMatching(/^volumes\/0-config\/secret$/)]);
    const v = await verifyBackup(result.backupId);
    expect(v.status).toBe("failed");
    expect(v.errors.join(" ")).toContain("unreadable");
  });
});

describe("nested volumes", () => {
  it("archives a nested volume once and leaves raw DB files out of the parent", async () => {
    await installFakeApp(env.root, "nested", `services:
  app:
    image: example/app:1
    volumes:
      - ./data:/data
  db:
    image: postgres:16
    volumes:
      - ./data/db:/var/lib/postgresql/data
`, { "data/app.txt": "app", "data/db/PG_VERSION": "16", "data/db/base/1": "raw page" });
    resetDocker([
      { id: "n1", name: "nested-app", service: "app", image: "example/app:1" },
      { id: "n2", name: "nested-db", service: "db", image: "postgres:16" },
    ]);
    const result = await createAppBackup("nested", { volumes: [join(env.root, "apps/nested/data"), join(env.root, "apps/nested/data/db")] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const m = await loadManifest(result.manifestPath);
    if (!m.ok) throw new Error(m.error);
    expect(m.manifest.method).toBe("dump");
    const paths = m.manifest.files.map((f) => f.path);
    expect(paths.some((p) => p.includes("PG_VERSION") || p.endsWith("base/1"))).toBe(false);
    expect(paths.some((p) => p.endsWith("app.txt"))).toBe(true);
  });
});

describe("deletion guard", () => {
  it("refuses to delete a backup that is being verified or restored", async () => {
    await installFakeApp(env.root, "inuse", `services:
  app:
    image: example/app:1
    volumes:
      - ./config:/config
`, { "config/a.txt": "a" });
    resetDocker([]);
    const b = await createAppBackup("inuse", { method: "live" });
    if (!b.success) throw new Error(b.error);
    expect(tryStartVerify(b.backupId)).toBe(true);
    expect((await deleteBackup(b.backupId)).ok).toBe(false);
    endVerify(b.backupId);

    const handle = acquireAppOperation("inuse", "restore", "restore-inuse")!;
    insertRestore("restore-inuse", b.backupId, "inuse");
    expect((await deleteBackup(b.backupId)).ok).toBe(false);
    handle.release();
    expect((await deleteBackup(b.backupId)).ok).toBe(true);
  });
});

describe("restore_app legacy path", () => {
  it("recognises archives made by the current engine so they are never extracted to /", async () => {
    const { isEngineArchivePath } = await import("../ai/tools/backup-tools.js");
    await installFakeApp(env.root, "legacyguard", `services:
  app:
    image: example/app:1
    volumes:
      - ./config:/config
`, { "config/a.txt": "a" });
    resetDocker([]);
    const b = await createAppBackup("legacyguard", { method: "live" });
    if (!b.success) throw new Error(b.error);
    expect(isEngineArchivePath(b.archivePath)).toBe(true);
    const legacy = join(env.root, "legacy", "legacyguard", "2025-01-01.tar.gz");
    mkdirSync(join(env.root, "legacy", "legacyguard"), { recursive: true });
    writeFileSync(legacy, "x");
    expect(isEngineArchivePath(legacy)).toBe(false);
  });
});
