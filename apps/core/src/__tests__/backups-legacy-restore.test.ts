import { describe, it, expect, vi, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { prepareBackupEnv, installFakeApp, resetDocker, dockerState } from "./helpers/backups-fixture.js";

// restore_app's legacy path (archives made before the backup engine: tar.gz
// of the app's folders relative to "/", no manifest).

vi.mock("../backup/docker-ops.js", async () => (await import("./helpers/backups-fixture.js")).dockerOpsMock());
vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

const env = prepareBackupEnv("backups-legacy-restore");
// Real paths: the archive's members are extracted relative to "/" and must not cross a symlinked /var
const root = realpathSync(env.root);
const { runMigrations } = await import("../db/migrate.js");
runMigrations();
const { restoreAppTool } = await import("../ai/tools/backup-tools.js");
const { restoreLegacyArchive } = await import("../backup/legacy-restore.js");
const { getBackupRoot } = await import("../backup/fs-utils.js");
const { TarGzWriter } = await import("../backup/tar.js");
const { getBackupRow, listAppBackups, getRestoreRow } = await import("../backup/store.js");

afterAll(() => env.cleanup());

const FAST = { healthTimeoutMs: 300, pollIntervalMs: 20 };
const toolCtx = { toolCallId: "t1", messages: [] } as never;
const COMPOSE = `services:
  app:
    image: example/app:1.0
    volumes:
      - ./config:/config
`;

type Entry = { path: string; content?: string; symlinkTo?: string; dir?: boolean };

/** A legacy archive: absolute paths stored without their leading "/". */
async function legacyArchive(forApp: string, entries: Entry[]): Promise<string> {
  const dir = join(getBackupRoot(), forApp);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2025-01-0${Math.floor(Math.random() * 9) + 1}-${Date.now()}.tar.gz`);
  const w = new TarGzWriter(file);
  const stat = { mode: 0o755, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, mtimeMs: Date.now() };
  for (const e of entries) {
    const name = e.path.replace(/^\/+/, "");
    if (e.dir) await w.addDirectory(name, { ...stat, mode: 0o40755 });
    else if (e.symlinkTo) await w.addSymlink(name, e.symlinkTo, { ...stat, mode: 0o120777 });
    else await w.addBuffer(name, Buffer.from(e.content ?? ""), 0o644);
  }
  await w.close();
  return file;
}

async function app(appId: string) {
  const { appDir } = await installFakeApp(root, appId, COMPOSE, { "config/app.conf": "version=2", "config/extra.txt": "kept" });
  resetDocker([{ id: `${appId}-c`, name: appId, service: "app", image: "example/app:1.0" }]);
  return { appDir, config: join(appDir, "config") };
}

describe("restore_app — legacy archives", () => {
  it("refuses an archive from another app's backup folder", async () => {
    const { config } = await app("legacyown");
    const other = await app("legacyother");
    const archive = await legacyArchive("legacyother", [
      { path: other.config, dir: true },
      { path: join(other.config, "app.conf"), content: "other app" },
    ]);
    const r = (await restoreAppTool.execute!({ appId: "legacyown", backupFile: archive, verifyFirst: false }, toolCtx)) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/legacyown's own folder/);
    expect(readFileSync(join(other.config, "app.conf"), "utf-8")).toBe("version=2");
    expect(readFileSync(join(config, "app.conf"), "utf-8")).toBe("version=2");
  });

  it("refuses an archive that would write outside the app's data folders, before changing anything", async () => {
    const { config } = await app("legacyescape");
    const victim = await app("legacyvictim");
    const archive = await legacyArchive("legacyescape", [
      { path: join(config, "app.conf"), content: "version=1" },
      { path: join(victim.config, "app.conf"), content: "overwritten" },
    ]);
    const before = listAppBackups("legacyescape").length;
    const r = (await restoreAppTool.execute!({ appId: "legacyescape", backupFile: archive, verifyFirst: false }, toolCtx)) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/not inside one of the app's data folders/);
    expect(readFileSync(join(victim.config, "app.conf"), "utf-8")).toBe("version=2");
    expect(readFileSync(join(config, "app.conf"), "utf-8")).toBe("version=2");
    expect(listAppBackups("legacyescape").length).toBe(before);
    expect(dockerState.events).toEqual([]);
  });

  it("refuses an archive that writes through a symlink it creates", async () => {
    const { config } = await app("legacylink");
    const outside = join(root, "outside-target");
    mkdirSync(outside, { recursive: true });
    const archive = await legacyArchive("legacylink", [
      { path: join(config, "link"), symlinkTo: outside },
      { path: join(config, "link", "planted.txt"), content: "pwned" },
    ]);
    const r = (await restoreAppTool.execute!({ appId: "legacylink", backupFile: archive, verifyFirst: false }, toolCtx)) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/through the symlink/);
    expect(existsSync(join(outside, "planted.txt"))).toBe(false);
  });

  it("takes a safety backup, restores and checks the app's health", async () => {
    const { config } = await app("legacyok");
    const archive = await legacyArchive("legacyok", [
      { path: config, dir: true },
      { path: join(config, "app.conf"), content: "version=1" },
    ]);
    const r = await restoreLegacyArchive("legacyok", archive, FAST);
    expect(r.success ? "" : r.error).toBe("");
    if (!r.success) return;
    expect(readFileSync(join(config, "app.conf"), "utf-8")).toBe("version=1");
    expect(readFileSync(join(config, "extra.txt"), "utf-8")).toBe("kept"); // merged, as before
    expect(r.safetyBackupId).toBeTruthy();
    expect(getBackupRow(r.safetyBackupId!)!.purpose).toBe("pre-restore");
    expect(dockerState.events).toContain("startApp");
  });

  it("puts the previous state back when the app is unhealthy afterwards", async () => {
    const { config } = await app("legacybad");
    const archive = await legacyArchive("legacybad", [
      { path: config, dir: true },
      { path: join(config, "app.conf"), content: "version=1" },
      { path: join(config, "from-backup.txt"), content: "old file" },
    ]);
    dockerState.containers[0].crashOnStart = true;
    const r = await restoreLegacyArchive("legacybad", archive, FAST);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.rolledBack).toBe(true);
    expect(r.safetyBackupId).toBeTruthy();
    expect(readFileSync(join(config, "app.conf"), "utf-8")).toBe("version=2");
    expect(existsSync(join(config, "from-backup.txt"))).toBe(false);
    const restores = (await import("../backup/store.js")).listRestores("legacybad");
    expect(restores[0]?.status).toBe("rolled_back");
    expect(getRestoreRow(restores[0].id)?.status).toBe("rolled_back");
  });
});
