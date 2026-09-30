/**
 * App lifecycle trust (design P0-11), core side:
 * - install state is keyed by (store, app), with an orphan fallback;
 * - rename and port edits need an installed app (409 otherwise, and no
 *   "unknown" installed row is created);
 * - installing an app id that another store already installed says where;
 * - uninstall keeps app data unless asked, then erases only its data folder;
 * - a 409 conflict carries the running operation for humane copy.
 * Real temp SQLite; the lifecycle engine and Docker are mocked.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const tmp = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/talome-apps-install-state-${process.pid}-${Date.now()}`.replace(/\/+/g, "/");
  process.env.DATABASE_PATH = `${dir}/db/talome.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
  return { dir, home: `${dir}/home` };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedir = () => tmp.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock("../docker/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../docker/client.js")>();
  return { ...actual, listContainers: vi.fn(async () => []) };
});

const lifecycle = vi.hoisted(() => ({
  installApp: vi.fn(),
  uninstallApp: vi.fn(),
  startApp: vi.fn(),
  stopApp: vi.fn(),
  restartApp: vi.fn(),
  updateApp: vi.fn(),
  withAppMaintenance: vi.fn(),
  applyComposeEditToUpdateSnapshots: vi.fn(),
}));
vi.mock("../stores/lifecycle.js", () => lifecycle);

import { mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";

mkdirSync(join(tmp.dir, "db"), { recursive: true });
const { db, schema } = await import("../db/index.js");
const { runMigrations } = await import("../db/migrate.js");
const { apps, installedRowFor } = await import("../routes/apps.js");
const { withAppOperation, __resetActiveOperationsForTests } = await import("../ops/operations.js");
const { appDataDirFor, removeAppData } = await import("../ops/app-data.js");
const { APP_DATA_DIR } = await import("../stores/compose-exec.js");

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  rmSync(tmp.dir, { recursive: true, force: true });
});

function store(id: string, name: string) {
  db.insert(schema.storeSources).values({ id, name, type: id.startsWith("umbrel") ? "umbrel" : "talome" }).run();
}

function catalog(storeSourceId: string, appId: string, name = appId) {
  db.insert(schema.appCatalog)
    .values({ appId, storeSourceId, name, source: storeSourceId.startsWith("umbrel") ? "umbrel" : "talome", composePath: `/tmp/${storeSourceId}/${appId}.yml` })
    .run();
}

function install(appId: string, storeSourceId: string) {
  db.insert(schema.installedApps).values({ appId, storeSourceId, status: "running" }).run();
}

beforeEach(() => {
  __resetActiveOperationsForTests();
  db.delete(schema.appOperationEvents).run();
  db.delete(schema.appOperations).run();
  db.delete(schema.installedApps).run();
  db.delete(schema.appCatalog).run();
  db.delete(schema.storeSources).run();
  vi.clearAllMocks();
  store("talome-store", "Talome");
  store("umbrel-store", "Umbrel");
});

const patch = (path: string, body: unknown) =>
  apps.request(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("installedRowFor", () => {
  const row = { storeSourceId: "umbrel-store" };
  it("matches only the store the app was installed from", () => {
    expect(installedRowFor("umbrel-store", row, new Set(["umbrel-store", "talome-store"]))).toBe(row);
    expect(installedRowFor("talome-store", row, new Set(["umbrel-store", "talome-store"]))).toBeUndefined();
  });

  it("falls back to the app id when the install's store no longer lists the app", () => {
    expect(installedRowFor("talome-store", row, new Set(["talome-store"]))).toBe(row);
  });

  it("is undefined when nothing is installed", () => {
    expect(installedRowFor("talome-store", undefined, new Set())).toBeUndefined();
  });
});

describe("install state keyed by (store, app)", () => {
  it("shows the app as installed only in the store it came from (regression: both stores)", async () => {
    catalog("talome-store", "jellyfin", "Jellyfin");
    catalog("umbrel-store", "jellyfin", "Jellyfin");
    install("jellyfin", "umbrel-store");

    const umbrel = (await (await apps.request("/umbrel-store/jellyfin")).json()) as Record<string, any>;
    expect(umbrel.installed?.storeId).toBe("umbrel-store");
    expect(umbrel.installedFrom).toBeUndefined();

    const talome = (await (await apps.request("/talome-store/jellyfin")).json()) as Record<string, any>;
    expect(talome.installed).toBeNull();
    expect(talome.installedFrom).toEqual({ storeId: "umbrel-store", storeName: "Umbrel" });

    const list = (await (await apps.request("/")).json()) as Array<Record<string, any>>;
    const byStore = Object.fromEntries(list.map((a) => [a.storeId, !!a.installed]));
    expect(byStore).toEqual({ "umbrel-store": true, "talome-store": false });

    const installedOnly = (await (await apps.request("/?installed=true")).json()) as Array<Record<string, any>>;
    expect(installedOnly.map((a) => a.storeId)).toEqual(["umbrel-store"]);
    const notInstalled = (await (await apps.request("/?installed=false")).json()) as Array<Record<string, any>>;
    expect(notInstalled.map((a) => a.storeId)).toEqual(["talome-store"]);
  });

  it("still shows an app installed from a store that no longer lists it", async () => {
    catalog("talome-store", "sonarr");
    install("sonarr", "removed-store");
    const detail = (await (await apps.request("/talome-store/sonarr")).json()) as Record<string, any>;
    expect(detail.installed?.appId).toBe("sonarr");
  });

  it("refuses to install an app id another store installed, naming that store", async () => {
    catalog("talome-store", "jellyfin");
    catalog("umbrel-store", "jellyfin");
    install("jellyfin", "umbrel-store");
    const res = await apps.request("/talome-store/jellyfin/install", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("already installed from Umbrel");
    expect(lifecycle.installApp).not.toHaveBeenCalled();
  });
});

describe("PATCH rename and ports", () => {
  it("answers 409 before install and creates no installed row (regression: 'unknown' row)", async () => {
    catalog("talome-store", "radarr");
    const res = await patch("/talome-store/radarr", { displayName: "Movies" });
    expect(res.status).toBe(409);
    const ports = await patch("/talome-store/radarr", { ports: { "7878": 7879 } });
    expect(ports.status).toBe(409);
    expect(db.select().from(schema.installedApps).all()).toEqual([]);
    expect(lifecycle.withAppMaintenance).not.toHaveBeenCalled();
  });

  it("answers 409 on another store's copy of an installed app", async () => {
    catalog("talome-store", "jellyfin");
    catalog("umbrel-store", "jellyfin");
    install("jellyfin", "umbrel-store");
    const res = await patch("/talome-store/jellyfin", { displayName: "Media" });
    expect(res.status).toBe(409);
    expect(db.select().from(schema.installedApps).get()?.displayName ?? null).toBeNull();
  });

  it("renames an installed app", async () => {
    catalog("talome-store", "radarr");
    install("radarr", "talome-store");
    const res = await patch("/talome-store/radarr", { displayName: "Movies" });
    expect(res.status).toBe(200);
    expect(db.select().from(schema.installedApps).get()?.displayName).toBe("Movies");
  });
});

describe("DELETE keeps or erases app data", () => {
  function fakeUninstall(appId: string) {
    lifecycle.uninstallApp.mockImplementationOnce(async () => {
      db.delete(schema.installedApps).run();
      return { success: true, operationId: `op-${appId}` };
    });
  }

  function seedData(appId: string) {
    const dir = join(APP_DATA_DIR, appId);
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(join(dir, "config", "settings.xml"), "<x/>");
    return dir;
  }

  it("keeps the data folder by default", async () => {
    catalog("talome-store", "lidarr");
    install("lidarr", "talome-store");
    const dir = seedData("lidarr");
    fakeUninstall("lidarr");
    const res = await apps.request("/talome-store/lidarr", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).dataKept).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it("erases only the app's data folder with keepData=false", async () => {
    catalog("talome-store", "lidarr");
    install("lidarr", "talome-store");
    const dir = seedData("lidarr");
    const sibling = seedData("sonarr");
    fakeUninstall("lidarr");
    const res = await apps.request("/talome-store/lidarr?keepData=false", { method: "DELETE" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.dataRemoved).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  it("does not erase anything when the uninstall failed", async () => {
    catalog("talome-store", "lidarr");
    install("lidarr", "talome-store");
    const dir = seedData("lidarr");
    lifecycle.uninstallApp.mockResolvedValueOnce({ success: false, error: "compose down failed" });
    const res = await apps.request("/talome-store/lidarr?keepData=false", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect(existsSync(dir)).toBe(true);
  });
});

describe("removeAppData", () => {
  it("refuses ids that are not a plain folder name", async () => {
    expect(appDataDirFor("../etc")).toBeNull();
    expect(appDataDirFor("a/b")).toBeNull();
    expect(appDataDirFor("..")).toBeNull();
    expect((await removeAppData("../../home")).removed).toBe(false);
  });

  it("refuses while the app is still installed", async () => {
    install("plex", "talome-store");
    mkdirSync(join(APP_DATA_DIR, "plex"), { recursive: true });
    const result = await removeAppData("plex");
    expect(result).toMatchObject({ removed: false, reason: "still_installed" });
    expect(existsSync(join(APP_DATA_DIR, "plex"))).toBe(true);
  });

  it("removes a symlinked data folder's link, never its target", async () => {
    const target = join(tmp.dir, "elsewhere");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "keep.txt"), "keep");
    mkdirSync(APP_DATA_DIR, { recursive: true });
    symlinkSync(target, join(APP_DATA_DIR, "linked"));
    const result = await removeAppData("linked");
    expect(result.removed).toBe(true);
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
  });
});

describe("conflict response", () => {
  it("carries the running operation so the dashboard can say what is happening", async () => {
    catalog("talome-store", "sonarr");
    install("sonarr", "talome-store");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const running = withAppOperation("sonarr", "install", "assistant", async (ctx) => {
      ctx.step("pulling", 40, "Downloading");
      await gate;
      return { success: true };
    });

    let conflictMessage = "";
    lifecycle.restartApp.mockImplementationOnce(async () => {
      try {
        await withAppOperation("sonarr", "restart", "user", async () => ({ success: true }));
        return { success: true };
      } catch (err) {
        conflictMessage = (err as Error).message;
        const id = (err as { running: { id: string } }).running.id;
        return { success: false, error: conflictMessage, conflict: true, operationId: id };
      }
    });

    const res = await apps.request("/talome-store/sonarr/restart", { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, any>;
    expect(body.running).toMatchObject({ kind: "install", actor: "assistant", step: "pulling", progress: 40 });
    // Engine text reads correctly for agents too ("an install", not "a install").
    expect(conflictMessage).toContain("an install operation");

    release();
    await running;
  });
});
