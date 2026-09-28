import { describe, it, expect, vi, afterAll } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { prepareBackupEnv, installFakeApp, resetDocker, dockerState } from "./helpers/backups-fixture.js";

vi.mock("../backup/docker-ops.js", async () => (await import("./helpers/backups-fixture.js")).dockerOpsMock());
vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

const env = prepareBackupEnv("backups-restore-safety");
const { runMigrations } = await import("../db/migrate.js");
runMigrations();
const { createAppBackup } = await import("../backup/engine.js");
const { restoreAppBackup, waitForHealthy } = await import("../backup/restore.js");
const { listAppBackups, listRecoveryRecords } = await import("../backup/store.js");
const { significantLoadErrors } = await import("../backup/dumps.js");

afterAll(() => env.cleanup());

const FAST = { healthTimeoutMs: 300, pollIntervalMs: 20 };

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const SIMPLE = `services:
  app:
    image: example/app:1.0
    volumes:
      - ./config:/config
`;

describe("restore — disaster recovery", () => {
  it("restores when the app's data folders are gone (no safety backup needed)", async () => {
    const { appDir } = await installFakeApp(env.root, "lostdata", SIMPLE, { "config/app.conf": "version=1" });
    resetDocker([{ id: "ld", name: "lostdata", service: "app", image: "example/app:1.0" }]);
    const backup = await createAppBackup("lostdata");
    if (!backup.success) throw new Error(backup.error);
    rmSync(join(appDir, "config"), { recursive: true, force: true });
    const before = listAppBackups("lostdata").length;

    const r = await restoreAppBackup(backup.backupId, FAST);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.safetyBackupId).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/no safety backup/);
    expect(readFileSync(join(appDir, "config/app.conf"), "utf-8")).toBe("version=1");
    // no failed "safety" row added to the history
    expect(listAppBackups("lostdata").length).toBe(before);
    expect(listRecoveryRecords().some((x) => x.appId === "lostdata")).toBe(false);
  });

  it("backs up only the paths that still exist", async () => {
    const compose = `services:
  app:
    image: example/app:1.0
    volumes:
      - ./config:/config
      - ./data:/data
`;
    const { appDir } = await installFakeApp(env.root, "partial", compose, { "config/a.txt": "a", "data/b.txt": "b" });
    resetDocker([{ id: "pt", name: "partial", service: "app", image: "example/app:1.0" }]);
    const backup = await createAppBackup("partial");
    if (!backup.success) throw new Error(backup.error);
    rmSync(join(appDir, "data"), { recursive: true, force: true });
    const r = await restoreAppBackup(backup.backupId, FAST);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.safetyBackupId).toBeTruthy();
    expect(readFileSync(join(appDir, "data/b.txt"), "utf-8")).toBe("b");
  });
});

describe("restore — health check", () => {
  it("does not require one-shot containers that exit cleanly to keep running", async () => {
    const compose = `services:
  app:
    image: example/app:1.0
    volumes:
      - ./config:/config
  migrate:
    image: example/app:1.0
    restart: "no"
`;
    await installFakeApp(env.root, "oneshot", compose, { "config/a.txt": "a" });
    resetDocker([
      { id: "os-app", name: "oneshot-app", service: "app", image: "example/app:1.0" },
      { id: "os-mig", name: "oneshot-migrate", service: "migrate", image: "example/app:1.0", status: "exited", oneShotExitCode: 0 },
    ]);
    const backup = await createAppBackup("oneshot");
    if (!backup.success) throw new Error(backup.error);
    const r = await restoreAppBackup(backup.backupId, FAST);
    expect(r.success).toBe(true);
    if (r.success) expect(r.health.healthy).toBe(true);
  });

  it("still fails when a container that was running before does not come back", async () => {
    await installFakeApp(env.root, "stillbad", SIMPLE, { "config/a.txt": "a" });
    resetDocker([{ id: "sb", name: "stillbad", service: "app", image: "example/app:1.0" }]);
    const backup = await createAppBackup("stillbad");
    if (!backup.success) throw new Error(backup.error);
    dockerState.containers[0].oneShotExitCode = 1;
    const r = await restoreAppBackup(backup.backupId, FAST);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.rolledBack).toBe(true);
  });

  it("without a required set, accepts exited-0 containers but not crashed ones", async () => {
    const ctx = { appId: "hc", composePath: "/x/docker-compose.yml", compose: { projectName: null } as never };
    resetDocker([
      { id: "h1", name: "hc-app", service: "app", image: "x" },
      { id: "h2", name: "hc-init", service: "init", image: "x", status: "exited", oneShotExitCode: 0 },
    ]);
    expect((await waitForHealthy(ctx, null, 100, 5)).healthy).toBe(true);
    dockerState.containers[1].oneShotExitCode = 2;
    expect((await waitForHealthy(ctx, null, 60, 5)).healthy).toBe(false);
    // required = only "app": the crashed init container is not a blocker
    expect((await waitForHealthy(ctx, null, 100, 5, new Set(["app"]))).healthy).toBe(true);
    // a required container that is missing is a blocker
    expect((await waitForHealthy(ctx, null, 60, 5, new Set(["app", "worker"]))).healthy).toBe(false);
  });
});

describe("restore — incomplete backups", () => {
  it("keeps paths that were unreadable at backup time instead of deleting them", async () => {
    if (process.getuid?.() === 0) return;
    const { appDir } = await installFakeApp(env.root, "keepunread", SIMPLE, {
      "config/app.conf": "version=1",
      "config/private/key.pem": "precious",
    });
    resetDocker([]);
    chmodSync(join(appDir, "config/private"), 0o000);
    const backup = await createAppBackup("keepunread", { method: "live" });
    chmodSync(join(appDir, "config/private"), 0o755);
    if (!backup.success) throw new Error(backup.error);
    write(join(appDir, "config/app.conf"), "version=2");

    const r = await restoreAppBackup(backup.backupId, { ...FAST, skipSafetyBackup: true });
    expect(r.success).toBe(true);
    expect(readFileSync(join(appDir, "config/app.conf"), "utf-8")).toBe("version=1");
    expect(readFileSync(join(appDir, "config/private/key.pem"), "utf-8")).toBe("precious");
    expect(readdirSync(appDir).filter((n) => n.includes(".talome-"))).toEqual([]);
  });
});

describe("restore — database dumps into an existing (named-volume) database", () => {
  const compose = `services:
  web:
    image: example/web:1
    volumes:
      - ./config:/config
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
`;

  it("ignores the errors every pg_dumpall --clean load produces", () => {
    expect(significantLoadErrors('psql:/tmp/x.sql:14: ERROR:  current user cannot be dropped\nERROR:  role "postgres" already exists\nSET')).toEqual([]);
    expect(significantLoadErrors('ERROR:  relation "items" already exists')).toHaveLength(1);
  });

  it("treats real load errors as a failed restore instead of a warning", async () => {
    await installFakeApp(env.root, "namedpg", compose, { "config/a.txt": "a" });
    resetDocker([
      { id: "np-web", name: "namedpg-web", service: "web", image: "example/web:1" },
      { id: "np-db", name: "namedpg-db", service: "db", image: "postgres:16" },
    ]);
    const backup = await createAppBackup("namedpg");
    if (!backup.success) throw new Error(backup.error);
    expect(backup.method).toBe("dump");

    dockerState.loadStderr = 'psql:/tmp/x.sql:40: ERROR:  relation "items" already exists';
    const r = await restoreAppBackup(backup.backupId, FAST);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/existing database/);

    dockerState.loadStderr = 'ERROR:  current user cannot be dropped\nERROR:  role "postgres" already exists';
    const ok = await restoreAppBackup(backup.backupId, FAST);
    expect(ok.success).toBe(true);
  });
});

describe("restore — nested volumes", () => {
  it("restores a parent before its nested volume so neither is lost", async () => {
    const compose = `services:
  app:
    image: example/app:1.0
    volumes:
      - ./data:/data
      - ./data/uploads:/uploads
`;
    const { appDir } = await installFakeApp(env.root, "nestedrestore", compose, { "data/a.txt": "a1", "data/uploads/u.txt": "u1" });
    resetDocker([{ id: "nr", name: "nestedrestore", service: "app", image: "example/app:1.0" }]);
    const dataDir = join(appDir, "data");
    const backup = await createAppBackup("nestedrestore", { volumes: [join(dataDir, "uploads"), dataDir] });
    if (!backup.success) throw new Error(backup.error);
    write(join(dataDir, "a.txt"), "a2");
    write(join(dataDir, "uploads/u.txt"), "u2");
    const r = await restoreAppBackup(backup.backupId, FAST);
    expect(r.success).toBe(true);
    expect(readFileSync(join(dataDir, "a.txt"), "utf-8")).toBe("a1");
    expect(readFileSync(join(dataDir, "uploads/u.txt"), "utf-8")).toBe("u1");
    expect(readdirSync(appDir).filter((n) => n.includes(".talome-"))).toEqual([]);
  });
});
