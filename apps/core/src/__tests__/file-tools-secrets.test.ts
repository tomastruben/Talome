/**
 * Alternate read-tier paths to the same secrets read_file guards: read_user_file
 * (its allowed root used to be ~/.talome, which holds the install's .env and the
 * database directory; it is now ~/.talome/files, but a symlink placed there can
 * still point at the .env) and read/write_app_config_file (which allowed any host
 * path when the app had no known mounts, and followed symlinks out of a mount).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const fx = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const home = `${base}/talome-file-tools-${process.pid}-${Date.now()}`;
  // Every path the tools compute from the home folder stays inside this sandbox.
  process.env.HOME = home;
  process.env.DATABASE_PATH = `${home}/.talome/data/talome.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
  return { home, talome: `${home}/.talome` };
});

const mockDbGet = vi.hoisted(() => vi.fn());
vi.mock("../db/index.js", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ get: mockDbGet }) }) }) },
  schema: { installedApps: { appId: "appId" }, settings: { key: "key" } },
}));
vi.mock("../db/audit.js", () => ({ writeAuditEntry: vi.fn() }));

import { readUserFileTool } from "../ai/tools/filesystem-tools.js";
import { readAppConfigFileTool, writeAppConfigFileTool } from "../ai/tools/config-tools.js";

type Exec = (args: Record<string, unknown>, options: unknown) => Promise<Record<string, unknown>>;
const opts = { toolCallId: "t", messages: [] };
const readUser = (path: string) => (readUserFileTool as unknown as { execute: Exec }).execute({ path, maxLines: 50, offset: 0 }, opts);
const readConfig = (appId: string, filePath: string) => (readAppConfigFileTool as unknown as { execute: Exec }).execute({ appId, filePath }, opts);
const writeConfig = (appId: string, filePath: string, content: string) =>
  (writeAppConfigFileTool as unknown as { execute: Exec }).execute({ appId, filePath, content }, opts);

const SECRET = "TALOME_SECRET=f00dfacecafe0123456789-secret";
const envFile = () => join(fx.talome, "server/apps/core/.env");

beforeAll(() => {
  const t = fx.talome;
  mkdirSync(join(t, "server/apps/core"), { recursive: true });
  mkdirSync(join(t, "data"), { recursive: true });
  mkdirSync(join(t, "backups"), { recursive: true });
  mkdirSync(join(t, "notes"), { recursive: true });
  mkdirSync(join(t, "files/notes"), { recursive: true });
  mkdirSync(join(t, "app-data/homeassistant"), { recursive: true });
  writeFileSync(envFile(), `${SECRET}\n`);
  writeFileSync(join(t, "data/talome.db-wal"), SECRET);
  writeFileSync(join(t, "data/talome.secret"), "f00dfacecafe0123456789");
  writeFileSync(join(t, "data/notes.txt"), SECRET);
  writeFileSync(join(t, "backups/talome-db-pre-update-1.db"), SECRET);
  writeFileSync(join(t, "notes/readme.txt"), "hello from notes");
  symlinkSync(envFile(), join(t, "notes/innocent.txt"));
  writeFileSync(join(t, "files/notes/readme.txt"), "hello from notes");
  // Inside the allowed root, so only the secret-path guard (realpath) stops it.
  symlinkSync(envFile(), join(t, "files/notes/innocent.txt"));
  writeFileSync(join(t, "app-data/homeassistant/configuration.yaml"), "homeassistant:\n");
  symlinkSync(envFile(), join(t, "app-data/homeassistant/linked.yaml"));
  writeFileSync(
    join(t, "app-data/homeassistant/docker-compose.yml"),
    `services:\n  homeassistant:\n    image: ha\n    volumes:\n      - ${join(t, "app-data/homeassistant")}:/config\n`,
  );
});

afterAll(() => {
  rmSync(fx.home, { recursive: true, force: true });
});

describe("read_user_file", () => {
  it("refuses Talome's .env, database directory and database snapshots", async () => {
    for (const path of [envFile(), join(fx.talome, "data/talome.db-wal"), join(fx.talome, "data/talome.secret"), join(fx.talome, "data/notes.txt"), join(fx.talome, "backups/talome-db-pre-update-1.db"), join(fx.talome, "notes/innocent.txt"), join(fx.talome, "files/notes/innocent.txt")]) {
      const r = await readUser(path);
      expect(r.error, path).toMatch(/Access denied/);
      expect(JSON.stringify(r)).not.toContain("f00dfacecafe");
    }
  });

  it("still reads ordinary files under the allowed roots", async () => {
    const r = await readUser(join(fx.talome, "files/notes/readme.txt"));
    expect(r.error).toBeUndefined();
    expect(String(r.content)).toContain("hello from notes");
  });
});

describe("app config file tools", () => {
  it("refuse any path when the app has no known mounts", async () => {
    mockDbGet.mockReturnValue(undefined);
    const read = await readConfig("not-installed", envFile());
    expect(read.success).toBe(false);
    expect(JSON.stringify(read)).not.toContain("f00dfacecafe");

    const write = await writeConfig("not-installed", join(fx.talome, "notes/readme.txt"), "pwned");
    expect(write.success).toBe(false);
    expect(readFileSync(join(fx.talome, "notes/readme.txt"), "utf-8")).toBe("hello from notes");
  });

  it("follow the real path: a symlink inside a mount may not lead out of it", async () => {
    mockDbGet.mockReturnValue({ overrideComposePath: join(fx.talome, "app-data/homeassistant/docker-compose.yml") });
    const linked = await readConfig("homeassistant", join(fx.talome, "app-data/homeassistant/linked.yaml"));
    expect(linked.success).toBe(false);
    expect(JSON.stringify(linked)).not.toContain("f00dfacecafe");

    const ok = await readConfig("homeassistant", join(fx.talome, "app-data/homeassistant/configuration.yaml"));
    expect(ok.success).toBe(true);
  });

  it("do not treat a sibling folder with the mount's name prefix as inside it", async () => {
    mkdirSync(join(fx.talome, "app-data/homeassistant-other"), { recursive: true });
    writeFileSync(join(fx.talome, "app-data/homeassistant-other/x.yaml"), "other: true\n");
    mockDbGet.mockReturnValue({ overrideComposePath: join(fx.talome, "app-data/homeassistant/docker-compose.yml") });
    const r = await readConfig("homeassistant", join(fx.talome, "app-data/homeassistant-other/x.yaml"));
    expect(r.success).toBe(false);
  });
});
