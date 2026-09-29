import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { prepareBackupEnv, installFakeApp, resetDocker, dockerState } from "./helpers/backups-fixture.js";

vi.mock("../backup/docker-ops.js", async () => (await import("./helpers/backups-fixture.js")).dockerOpsMock());
vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

const env = prepareBackupEnv("backups-engine");
const { runMigrations } = await import("../db/migrate.js");
runMigrations();
const { createAppBackup, deleteBackup } = await import("../backup/engine.js");
const { getBackupRow, setAppBackupConfig } = await import("../backup/store.js");
const { TarGzWriter, readTarGz } = await import("../backup/tar.js");
const { loadManifest } = await import("../backup/verify.js");
const { writeNotification } = await import("../db/notifications.js");

afterAll(() => env.cleanup());

const SIMPLE_COMPOSE = `services:
  app:
    image: example/app:1.0
    volumes:
      - ./config:/config
      - ./data:/data
      - /mnt/media:/media
`;

function sha(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("createAppBackup — stop method", () => {
  it("stops running containers, archives, and starts them again", async () => {
    await installFakeApp(env.root, "stopapp", SIMPLE_COMPOSE, {
      "config/settings.xml": "<xml/>",
      "data/db.sqlite": "not really sqlite",
    });
    resetDocker([{ id: "c1", name: "stopapp", service: "app", image: "example/app:1.0" }]);

    const result = await createAppBackup("stopapp", { method: "stop" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.method).toBe("stop");
    expect(dockerState.events).toEqual(["stop:c1", "start:c1"]);
    expect(dockerState.containers[0].status).toBe("running");
    const row = getBackupRow(result.backupId)!;
    expect(row.status).toBe("completed");
    expect(row.method).toBe("stop");
  });

  it("restarts containers even when archiving fails", async () => {
    await installFakeApp(env.root, "failapp", SIMPLE_COMPOSE, { "config/a.txt": "a" });
    resetDocker([
      { id: "app1", name: "failapp", service: "app", image: "example/app:1.0" },
      { id: "db1", name: "failapp-db", service: "db", image: "postgres:16", status: "exited" },
    ]);
    vi.spyOn(TarGzWriter.prototype, "addTree").mockRejectedValueOnce(new Error("disk full"));

    const result = await createAppBackup("failapp", { method: "stop" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("disk full");
    // only the container that was running is stopped and started again
    expect(dockerState.events).toEqual(["stop:app1", "start:app1"]);
    expect(dockerState.containers.find((c) => c.id === "app1")!.status).toBe("running");
    expect(dockerState.containers.find((c) => c.id === "db1")!.status).toBe("exited");
    const row = getBackupRow(result.backupId!)!;
    expect(row.status).toBe("failed");
    // no partial backup left behind
    const appDir = join(env.root, "backups", "failapp");
    expect(existsSync(appDir) ? readdirSync(appDir) : []).toEqual([]);
  });

  it("notifies when a container cannot be restarted", async () => {
    await installFakeApp(env.root, "stuckapp", SIMPLE_COMPOSE, { "config/a.txt": "a" });
    resetDocker([{ id: "s1", name: "stuckapp", service: "app", image: "example/app:1.0" }]);
    dockerState.failStartIds.add("s1");
    const result = await createAppBackup("stuckapp", { method: "stop" });
    expect(result.success).toBe(true);
    expect(vi.mocked(writeNotification)).toHaveBeenCalledWith("critical", expect.stringContaining("not restarted"), expect.any(String), "stuckapp");
  });

  it("marks intentionally stopped containers so monitors don't treat them as crashes", async () => {
    const { isContainerInBackupWindow } = await import("../backup/state.js");
    await installFakeApp(env.root, "windowapp", SIMPLE_COMPOSE, { "config/a.txt": "a" });
    resetDocker([{ id: "abcdef123456", name: "windowapp", service: "app", image: "example/app:1.0" }]);
    expect(isContainerInBackupWindow("windowapp")).toBe(false);
    const result = await createAppBackup("windowapp", { method: "stop" });
    expect(result.success).toBe(true);
    // still covered for a short grace period after the restart
    expect(isContainerInBackupWindow("windowapp")).toBe(true);
    expect(isContainerInBackupWindow(undefined, `abcdef123456${"0".repeat(52)}`)).toBe(true);
    expect(isContainerInBackupWindow("windowapp-worker", "fedcba654321")).toBe(false);
  });

  it("does not stop anything for the live method", async () => {
    await installFakeApp(env.root, "liveapp", SIMPLE_COMPOSE, { "config/a.txt": "a" });
    resetDocker([{ id: "l1", name: "liveapp", service: "app", image: "example/app:1.0" }]);
    const result = await createAppBackup("liveapp", { method: "live" });
    expect(result.success && result.method).toBe("live");
    expect(dockerState.events).toEqual([]);
  });

  it("refuses a second concurrent backup of the same app", async () => {
    await installFakeApp(env.root, "busyapp", SIMPLE_COMPOSE, { "config/a.txt": "a" });
    resetDocker([]);
    const [a, b] = await Promise.all([createAppBackup("busyapp"), createAppBackup("busyapp")]);
    expect([a.success, b.success].sort()).toEqual([false, true]);
  });
});

describe("manifest", () => {
  it("records every file with size and sha256, and the archive checksum", async () => {
    const files = {
      "config/settings.xml": "<settings>1</settings>",
      "config/nested/deep.json": JSON.stringify({ a: 1 }),
      "data/blob.bin": Buffer.alloc(70_000, 3),
    };
    await installFakeApp(env.root, "manifestapp", SIMPLE_COMPOSE, files);
    resetDocker([{ id: "m1", name: "manifestapp", service: "app", image: "example/app:1.0" }]);
    const result = await createAppBackup("manifestapp");
    expect(result.success).toBe(true);
    if (!result.success) return;

    const loaded = await loadManifest(result.manifestPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const m = loaded.manifest;
    expect(m.appId).toBe("manifestapp");
    expect(m.appVersion).toBe("1.0.0");
    expect(m.method).toBe("stop"); // auto → stop (no database)
    expect(m.requestedMethod).toBe("auto");
    expect(m.volumes.map((v) => v.target).sort()).toEqual(["/config", "/data"]);
    expect(m.skippedVolumes.some((s) => s.raw === "/mnt/media")).toBe(true);
    expect(m.images[0].repoDigests[0]).toContain("sha256:m1");
    expect(m.compose?.sha256).toBe(sha(readFileSync(join(env.root, "apps", "manifestapp", "docker-compose.yml"))));
    expect(m.talomeVersion).toBeTruthy();

    for (const [rel, content] of Object.entries(files)) {
      const [vol, ...rest] = rel.split("/");
      const vKey = m.volumes.find((v) => v.target === `/${vol}`)!.key;
      const entry = m.files.find((f) => f.path === `volumes/${vKey}/${rest.join("/")}`);
      expect(entry, rel).toBeDefined();
      expect(entry!.sha256).toBe(sha(content));
      expect(entry!.size).toBe(Buffer.byteLength(content));
    }
    expect(m.archive?.sha256).toBe(sha(readFileSync(result.archivePath)));
    expect(getBackupRow(result.backupId)!.archive_sha256).toBe(m.archive?.sha256);

    // The archive carries its own copy of the manifest
    let embedded = "";
    await readTarGz(result.archivePath, async (h, body) => {
      if (h.name !== "talome-backup/manifest.json") return;
      for await (const chunk of body) embedded += chunk.toString("utf-8");
    });
    expect(JSON.parse(embedded).backupId).toBe(result.backupId);
  });

  it("applies per-app exclude patterns", async () => {
    await installFakeApp(env.root, "excludeapp", SIMPLE_COMPOSE, {
      "config/keep.txt": "keep",
      "config/cache/huge.bin": "cache",
      "config/logs/app.log": "log",
      "data/storage/photo.jpg": "photo",
    });
    setAppBackupConfig("excludeapp", { excludePatterns: ["cache/", "*.log", "data/storage/*"] });
    resetDocker([]);
    const result = await createAppBackup("excludeapp");
    expect(result.success).toBe(true);
    if (!result.success) return;
    const loaded = await loadManifest(result.manifestPath);
    if (!loaded.ok) throw new Error(loaded.error);
    const paths = loaded.manifest.files.map((f) => f.path).join("\n");
    expect(paths).toContain("keep.txt");
    expect(paths).not.toContain("huge.bin");
    expect(paths).not.toContain("app.log");
    expect(paths).not.toContain("photo.jpg");
    expect(loaded.manifest.excludePatterns).toEqual(["cache/", "*.log", "data/storage/*"]);
  });

  it("deleteBackup removes the backup directory and the record", async () => {
    await installFakeApp(env.root, "delapp", SIMPLE_COMPOSE, { "config/a.txt": "a" });
    resetDocker([]);
    const result = await createAppBackup("delapp");
    if (!result.success) throw new Error(result.error);
    expect(existsSync(result.archivePath)).toBe(true);
    const r = await deleteBackup(result.backupId);
    expect(r.ok).toBe(true);
    expect(existsSync(result.archivePath)).toBe(false);
    expect(existsSync(result.manifestPath)).toBe(false);
    expect(getBackupRow(result.backupId)).toBeNull();
  });
});

describe("createAppBackup — dump method", () => {
  const PG_COMPOSE = `services:
  web:
    image: example/web:2.0
    volumes:
      - ./config:/config
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: app
    volumes:
      - ./pgdata:/var/lib/postgresql/data
  cache:
    image: redis:7
    volumes:
      - ./redis:/data
`;

  it("dumps databases without stopping the app and leaves raw DB files out", async () => {
    await installFakeApp(env.root, "pgapp", PG_COMPOSE, {
      "config/app.yml": "a: 1",
      "pgdata/PG_VERSION": "16",
      "pgdata/base/1/1234": "raw pages",
      "redis/dump.rdb": "REDIS0011",
    });
    resetDocker([
      { id: "w1", name: "pgapp-web", service: "web", image: "example/web:2.0" },
      { id: "d1", name: "pgapp-db", service: "db", image: "postgres:16-alpine" },
      { id: "r1", name: "pgapp-cache", service: "cache", image: "redis:7" },
    ]);
    const result = await createAppBackup("pgapp");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.method).toBe("dump");
    expect(dockerState.events.some((e) => e.startsWith("stop:"))).toBe(false);
    expect(dockerState.events).toContain("dump:db");

    const loaded = await loadManifest(result.manifestPath);
    if (!loaded.ok) throw new Error(loaded.error);
    const m = loaded.manifest;
    const pgDump = m.dumps.find((d) => d.engine === "postgres")!;
    expect(pgDump.path).toBe("dumps/db.sql");
    expect(pgDump.replacesVolumes[0]).toMatch(/pgdata$/);
    expect(m.files.some((f) => f.path === "dumps/db.sql" && f.sha256 === pgDump.sha256)).toBe(true);
    expect(m.files.some((f) => f.path.includes("PG_VERSION"))).toBe(false);
    expect(m.files.some((f) => f.path.endsWith("dump.rdb"))).toBe(true);
  });

  it("fails the backup when the dump is truncated", async () => {
    await installFakeApp(env.root, "pgbad", PG_COMPOSE, { "config/app.yml": "a: 1", "pgdata/PG_VERSION": "16" });
    resetDocker([
      { id: "w2", name: "pgbad-web", service: "web", image: "example/web:2.0" },
      { id: "d2", name: "pgbad-db", service: "db", image: "postgres:16-alpine" },
    ]);
    dockerState.dumps.set("db", "--\n-- PostgreSQL database cluster dump\n--\nCREATE TABLE t (");
    const result = await createAppBackup("pgbad");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/incomplete/);
  });

  it("falls back to the stop method when the database container is not running", async () => {
    await installFakeApp(env.root, "pgdown", PG_COMPOSE, { "config/app.yml": "a: 1", "pgdata/PG_VERSION": "16" });
    resetDocker([
      { id: "w3", name: "pgdown-web", service: "web", image: "example/web:2.0" },
      { id: "d3", name: "pgdown-db", service: "db", image: "postgres:16-alpine", status: "exited" },
    ]);
    const result = await createAppBackup("pgdown");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.method).toBe("stop");
    expect(result.warnings.join(" ")).toMatch(/not running/);
    const loaded = await loadManifest(result.manifestPath);
    if (!loaded.ok) throw new Error(loaded.error);
    // cold copy of the raw DB directory is included instead
    expect(loaded.manifest.files.some((f) => f.path.includes("PG_VERSION"))).toBe(true);
    expect(dockerState.events).toEqual(["stop:w3", "start:w3"]);
  });
});

describe("Umbrel data root (storage.dataRoot)", () => {
  it("backs up the data folder an Umbrel app was installed with instead of treating it as media", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { db, schema } = await import("../db/index.js");
    const dataRoot = join(env.root, "ssd", "photo-vault");
    mkdirSync(join(dataRoot, "library"), { recursive: true });
    writeFileSync(join(dataRoot, "library", "photos.db"), "db");
    mkdirSync(join(dataRoot, "cache"), { recursive: true });
    writeFileSync(join(dataRoot, "cache", "thumb.jpg"), "thumb");
    const home = join(env.root, "umbrel-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "notes.txt"), "user media");
    // ${APP_DATA_DIR}/data was redirected to the chosen folder at install
    const compose = `services:
  app:
    image: example/photo:1
    volumes:
      - ${dataRoot}/library:/data/library
      - ${dataRoot}/cache:/data/cache
      - ${home}:/home
`;
    await installFakeApp(env.root, "photovault", compose, {});
    resetDocker([{ id: "pv", name: "photovault", service: "app", image: "example/photo:1" }]);
    db.insert(schema.appInstallOptions)
      .values({
        appId: "photovault",
        storeSourceId: "test-store",
        options: JSON.stringify({ dataRoot }),
        plan: JSON.stringify({ dataRoot: { declared: true, hostPath: dataRoot }, backupIgnore: ["data/cache/*"] }),
      })
      .run();
    // Umbrel backupIgnore, merged into the app's excludes at install
    setAppBackupConfig("photovault", { excludePatterns: ["data/cache/*"] });

    const r = await createAppBackup("photovault");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.volumes.sort()).toEqual([join(dataRoot, "cache"), join(dataRoot, "library")].sort());
    const m = await loadManifest(r.manifestPath);
    if (!m.ok) throw new Error(m.error);
    const files = m.manifest.files.map((f) => f.path);
    expect(files.some((p) => p.endsWith("photos.db"))).toBe(true);
    // backupIgnore patterns relative to ${APP_DATA_DIR} still apply under the moved root
    expect(files.some((p) => p.endsWith("thumb.jpg"))).toBe(false);
    // the user's mapped home folder stays media (not selected)
    expect(files.some((p) => p.endsWith("notes.txt"))).toBe(false);
  });
});
