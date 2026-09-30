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
    dockerState.containers[0].brokenStarts = 1; // exits on the restored data only
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

describe("restore — the safety backup can undo the restore", () => {
  const NAMED_PG = `services:
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
  const BIND_PG = `services:
  web:
    image: example/web:1
    volumes:
      - ./config:/config
  db:
    image: postgres:16
    volumes:
      - ./postgres:/var/lib/postgresql/data
`;

  async function safetyManifest(safetyBackupId: string | null) {
    const { getBackupRow } = await import("../backup/store.js");
    const { loadManifest } = await import("../backup/verify.js");
    const row = getBackupRow(safetyBackupId!)!;
    const m = await loadManifest(row.manifest_path!);
    if (!m.ok) throw new Error(m.error);
    return m.manifest;
  }

  it("dumps the database of a stopped app (named volume) and puts it back when the load fails", async () => {
    const { appDir } = await installFakeApp(env.root, "stoppedpg", NAMED_PG, { "config/a.txt": "a1" });
    resetDocker([
      { id: "sp-web", name: "stoppedpg-web", service: "web", image: "example/web:1" },
      { id: "sp-db", name: "stoppedpg-db", service: "db", image: "postgres:16" },
    ]);
    const backup = await createAppBackup("stoppedpg");
    if (!backup.success) throw new Error(backup.error);
    expect(backup.method).toBe("dump");
    write(join(appDir, "config/a.txt"), "a2");
    // The user stops the app, then restores
    for (const c of dockerState.containers) c.status = "exited";
    dockerState.events = [];
    // The restore's load fails for real; loading the safety dump back works
    dockerState.loadStderrQueue = ['psql:/tmp/x.sql:40: ERROR:  relation "items" already exists'];

    const r = await restoreAppBackup(backup.backupId, FAST);
    expect(r.success).toBe(false);
    if (r.success) return;
    const safety = await safetyManifest(r.safetyBackupId);
    // The safety backup holds a dump of the database that is about to be overwritten
    expect(safety.dumps.some((d) => d.service === "db" && d.path)).toBe(true);
    expect(dockerState.events.indexOf("dump:db")).toBeGreaterThan(dockerState.events.indexOf("composeUp:db"));
    expect(r.rolledBack).toBe(true);
    // loaded twice: the restore (failed), then the safety dump
    expect(dockerState.events.filter((e) => e === "exec:psql")).toHaveLength(2);
    expect(readFileSync(join(appDir, "config/a.txt"), "utf-8")).toBe("a2");
    // the app was stopped before and is stopped again
    expect(dockerState.containers.every((c) => c.status !== "running")).toBe(true);
  });

  it("refuses the restore (and changes nothing) when a named-volume database cannot be dumped", async () => {
    const { appDir } = await installFakeApp(env.root, "nodumppg", NAMED_PG, { "config/a.txt": "a1" });
    resetDocker([
      { id: "nd-web", name: "nodumppg-web", service: "web", image: "example/web:1" },
      { id: "nd-db", name: "nodumppg-db", service: "db", image: "postgres:16" },
    ]);
    const backup = await createAppBackup("nodumppg");
    if (!backup.success) throw new Error(backup.error);
    write(join(appDir, "config/a.txt"), "a2");
    for (const c of dockerState.containers) c.status = "exited";
    dockerState.events = [];
    dockerState.failDumpServices.add("db");

    const r = await restoreAppBackup(backup.backupId, FAST);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toMatch(/Safety backup failed — nothing was changed/);
    expect(r.rolledBack).toBe(false);
    expect(dockerState.events).not.toContain("exec:psql");
    expect(readFileSync(join(appDir, "config/a.txt"), "utf-8")).toBe("a2");
    // the database started for the dump is stopped again
    expect(dockerState.containers.every((c) => c.status !== "running")).toBe(true);
  });

  it("captures a bind-mounted database Talome cannot read as a dump (non-root install)", async () => {
    if (process.getuid?.() === 0) return; // permissions don't apply to root
    const { appDir } = await installFakeApp(env.root, "rootlesspg", BIND_PG, {
      "config/a.txt": "a1",
      "postgres/PG_VERSION": "16",
    });
    resetDocker([
      { id: "rl-web", name: "rootlesspg-web", service: "web", image: "example/web:1" },
      { id: "rl-db", name: "rootlesspg-db", service: "db", image: "postgres:16" },
    ]);
    const backup = await createAppBackup("rootlesspg");
    if (!backup.success) throw new Error(backup.error);
    expect(backup.method).toBe("dump");
    // Postgres owns its data directory (uid 999, mode 0700)
    const pgdata = join(appDir, "postgres");
    chmodSync(pgdata, 0o000);
    try {
      const r = await restoreAppBackup(backup.backupId, FAST);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const safety = await safetyManifest(r.safetyBackupId);
      expect(safety.dumps.find((d) => d.service === "db")).toMatchObject({ replacesVolumes: [pgdata] });
      expect(safety.dumps.find((d) => d.service === "db")?.path).toBeTruthy();
      expect(safety.unreadable).toEqual([]);
      // files were archived with the app stopped
      expect(safety.method).toBe("dump");
      // the old data directory could not be deleted — the user is told instead of silently keeping a full copy
      expect(r.warnings.join(" ")).toMatch(/Could not delete the previous data/);
    } finally {
      for (const name of readdirSync(appDir)) {
        if (name.startsWith("postgres")) chmodSync(join(appDir, name), 0o755);
      }
    }
  });

  it("refuses the restore when the safety backup cannot read data the restore would replace", async () => {
    if (process.getuid?.() === 0) return;
    const { appDir } = await installFakeApp(env.root, "unreadnow", SIMPLE, {
      "config/app.conf": "version=1",
      "config/private/key.pem": "old key",
    });
    resetDocker([{ id: "un", name: "unreadnow", service: "app", image: "example/app:1.0" }]);
    const backup = await createAppBackup("unreadnow");
    if (!backup.success) throw new Error(backup.error);
    write(join(appDir, "config/private/key.pem"), "new key");
    write(join(appDir, "config/app.conf"), "version=2");
    chmodSync(join(appDir, "config/private"), 0o000);
    const before = listAppBackups("unreadnow").length;
    try {
      const r = await restoreAppBackup(backup.backupId, FAST);
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.error).toMatch(/Safety backup failed — nothing was changed/);
      expect(r.error).toContain(join(appDir, "config/private"));
      expect(readFileSync(join(appDir, "config/app.conf"), "utf-8")).toBe("version=2");
      // the incomplete safety backup is not kept, and the app runs again
      expect(listAppBackups("unreadnow").filter((b) => b.status === "completed")).toHaveLength(before);
      expect(dockerState.containers[0].status).toBe("running");
    } finally {
      chmodSync(join(appDir, "config/private"), 0o755);
    }
    expect(readFileSync(join(appDir, "config/private/key.pem"), "utf-8")).toBe("new key");
  });

  it("allows unreadable paths the restore keeps anyway", async () => {
    if (process.getuid?.() === 0) return;
    const { appDir } = await installFakeApp(env.root, "unreadboth", SIMPLE, {
      "config/app.conf": "version=1",
      "config/private/key.pem": "key",
    });
    resetDocker([{ id: "ub", name: "unreadboth", service: "app", image: "example/app:1.0" }]);
    // unreadable (no read bit) but still movable
    chmodSync(join(appDir, "config/private"), 0o300);
    try {
      const backup = await createAppBackup("unreadboth");
      if (!backup.success) throw new Error(backup.error);
      write(join(appDir, "config/app.conf"), "version=2");
      const r = await restoreAppBackup(backup.backupId, FAST);
      expect(r.success ? "" : r.error).toBe("");
      expect(readFileSync(join(appDir, "config/app.conf"), "utf-8")).toBe("version=1");
    } finally {
      chmodSync(join(appDir, "config/private"), 0o755);
    }
    expect(readFileSync(join(appDir, "config/private/key.pem"), "utf-8")).toBe("key");
  });

  it("reports a rollback as incomplete when the safety backup has no copy of a database loaded in place", async () => {
    const { uncoveredInPlaceDatabases } = await import("../backup/restore.js");
    const ctx = {
      compose: {
        projectName: null,
        services: [
          { name: "db", image: "postgres:16", containerName: null, environment: {}, volumes: [], dbEngine: "postgres" as const, dbDataPaths: [] },
          { name: "raw", image: "postgres:16", containerName: null, environment: {}, volumes: [], dbEngine: "postgres" as const, dbDataPaths: ["/d/raw"] },
        ],
      },
    };
    const base = { volumes: [] as Array<{ hostPath: string }>, dumps: [] as Array<{ service: string; path: string | null }> };
    const m = (x: Partial<typeof base>) => ({ ...base, ...x }) as never;
    expect(uncoveredInPlaceDatabases(m({}), ["db"], ctx)).toEqual(["db"]);
    expect(uncoveredInPlaceDatabases(m({ dumps: [{ service: "db", path: "dumps/db.sql" }] }), ["db"], ctx)).toEqual([]);
    expect(uncoveredInPlaceDatabases(m({ volumes: [{ hostPath: "/d/raw" }] }), ["raw"], ctx)).toEqual([]);
    expect(uncoveredInPlaceDatabases(m({}), ["raw"], ctx)).toEqual(["raw"]);
  });
});
