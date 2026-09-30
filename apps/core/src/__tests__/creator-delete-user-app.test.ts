import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// deleteUserApp removes ~/.talome/user-apps/apps/<id>/ — but never data the
// app's compose bind-mounts from inside it, and nothing outside it.

const h = vi.hoisted(() => {
  const home = `${(process.env.TMPDIR || "/tmp").replace(/\/$/, "")}/talome-delete-user-app-${process.pid}-${Date.now()}`;
  return { home, installed: undefined as unknown, uninstall: vi.fn(async () => ({ success: true })) };
});

vi.mock("node:os", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:os")>()), homedir: () => h.home }));
vi.mock("../db/index.js", () => {
  const chain = () => ({ from: () => ({ where: () => ({ get: () => h.installed }) }) });
  return {
    db: { select: chain, delete: () => ({ where: () => ({ run: () => undefined }) }) },
    schema: { installedApps: { appId: "app_id" }, appCatalog: { appId: "app_id", storeSourceId: "store_source_id" } },
  };
});
vi.mock("../stores/lifecycle.js", () => ({ uninstallApp: h.uninstall }));
vi.mock("../stores/adapters/talome-adapter.js", () => ({ talomeAdapter: {} }));
vi.mock("../app-specs/service.js", () => ({ saveAppSpec: vi.fn(), deleteAppSpec: vi.fn(), getStoredAppSpec: vi.fn() }));

import { deleteUserApp } from "../stores/creator.js";

const USER_APPS = join(h.home, ".talome", "user-apps");
const appDir = (id: string) => join(USER_APPS, "apps", id);

function write(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function makeApp(id: string, compose: string, extra: Record<string, string> = {}) {
  write(join(appDir(id), "manifest.json"), JSON.stringify({ id }));
  write(join(appDir(id), "docker-compose.yml"), compose);
  write(join(appDir(id), "talome-app.json"), "{}");
  for (const [rel, content] of Object.entries(extra)) write(join(appDir(id), rel), content);
}

beforeEach(() => {
  h.installed = undefined;
  write(join(USER_APPS, "registry.json"), JSON.stringify({ version: 1, apps: ["gone-app", "data-app", "keep-other"] }));
});
afterAll(() => rmSync(h.home, { recursive: true, force: true }));

describe("deleteUserApp", () => {
  it("removes the app directory", async () => {
    makeApp("gone-app", "services:\n  web:\n    image: nginx:1.27-alpine\n    volumes:\n      - pgdata:/data\nvolumes:\n  pgdata: {}\n");
    makeApp("keep-other", "services:\n  web:\n    image: nginx:1.27-alpine\n");
    const r = await deleteUserApp("gone-app");
    expect(r.success).toBe(true);
    expect(existsSync(appDir("gone-app"))).toBe(false);
    // other apps and the registry of the rest are untouched
    expect(existsSync(join(appDir("keep-other"), "manifest.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(USER_APPS, "registry.json"), "utf-8")).apps).toEqual(["data-app", "keep-other"]);
  });

  it("keeps data the compose bind-mounts from inside the app directory", async () => {
    makeApp("data-app", "services:\n  db:\n    image: postgres:16-alpine\n    volumes:\n      - ./pgdata:/var/lib/postgresql/data\n      - ./config/app:/config\n", {
      "pgdata/PG_VERSION": "16",
      "config/app/settings.json": "{}",
      "config/other.txt": "x",
      "app/page.tsx": "export {}",
    });
    const r = await deleteUserApp("data-app");
    expect(r.success).toBe(true);
    expect(readFileSync(join(appDir("data-app"), "pgdata/PG_VERSION"), "utf-8")).toBe("16");
    expect(existsSync(join(appDir("data-app"), "config/app/settings.json"))).toBe(true);
    expect(existsSync(join(appDir("data-app"), "manifest.json"))).toBe(false);
    expect(existsSync(join(appDir("data-app"), "docker-compose.yml"))).toBe(false);
    expect(existsSync(join(appDir("data-app"), "app"))).toBe(false);
    expect(r.keptData).toEqual(expect.arrayContaining([join(appDir("data-app"), "pgdata"), join(appDir("data-app"), "config")]));
  });

  it("keeps the whole directory when the compose mounts it or cannot be resolved", async () => {
    makeApp("whole-dir", "services:\n  web:\n    image: nginx:1.27-alpine\n    volumes:\n      - .:/app\n");
    expect((await deleteUserApp("whole-dir")).success).toBe(true);
    expect(existsSync(join(appDir("whole-dir"), "manifest.json"))).toBe(true);

    makeApp("var-dir", "services:\n  web:\n    image: nginx:1.27-alpine\n    volumes:\n      - ${DATA:-./data}:/data\n", { "data/x": "1" });
    expect((await deleteUserApp("var-dir")).success).toBe(true);
    expect(existsSync(join(appDir("var-dir"), "data/x"))).toBe(true);
  });

  it("keeps data the compose bind-mounts from inside the app directory by an absolute or ~ path", async () => {
    // The absolute form as written, and with symlinks resolved (TMPDIR is often a symlink)
    mkdirSync(appDir("abs-app"), { recursive: true });
    const real = realpathSync(appDir("abs-app"));
    const compose =
      "services:\n  db:\n    image: postgres:16-alpine\n    volumes:\n" +
      `      - ${appDir("abs-app")}/pgdata:/var/lib/postgresql/data\n` +
      `      - ${real}/uploads:/uploads\n` +
      "      - ~/.talome/user-apps/apps/abs-app/config:/config\n";
    makeApp("abs-app", compose, { "pgdata/PG_VERSION": "16", "uploads/a.jpg": "img", "config/c.json": "{}", "app/page.tsx": "export {}" });
    const r = await deleteUserApp("abs-app");
    expect(r.success).toBe(true);
    expect(readFileSync(join(appDir("abs-app"), "pgdata/PG_VERSION"), "utf-8")).toBe("16");
    expect(existsSync(join(appDir("abs-app"), "uploads/a.jpg"))).toBe(true);
    expect(existsSync(join(appDir("abs-app"), "config/c.json"))).toBe(true);
    expect(existsSync(join(appDir("abs-app"), "app"))).toBe(false);
    expect(existsSync(join(appDir("abs-app"), "manifest.json"))).toBe(false);
  });

  it("keeps the whole directory when the compose mounts a folder above it", async () => {
    makeApp("parent-mount", `services:\n  web:\n    image: nginx:1.27-alpine\n    volumes:\n      - ${join(USER_APPS, "apps")}:/apps\n`, { "data/x": "1" });
    expect((await deleteUserApp("parent-mount")).success).toBe(true);
    expect(existsSync(join(appDir("parent-mount"), "manifest.json"))).toBe(true);
    expect(existsSync(join(appDir("parent-mount"), "data/x"))).toBe(true);
  });

  it("never removes anything for an app id that is not a slug", async () => {
    write(join(USER_APPS, "apps", "precious.txt"), "keep");
    const r = await deleteUserApp("..");
    expect(r.success).toBe(true);
    expect(existsSync(join(USER_APPS, "apps", "precious.txt"))).toBe(true);
    expect(existsSync(join(USER_APPS, "registry.json"))).toBe(true);
  });

  it("keeps everything when uninstalling the app fails", async () => {
    makeApp("busy-app", "services:\n  web:\n    image: nginx:1.27-alpine\n");
    h.installed = { appId: "busy-app" };
    h.uninstall.mockResolvedValueOnce({ success: false, error: "an update is running" } as never);
    const r = await deleteUserApp("busy-app");
    expect(r.success).toBe(false);
    expect(existsSync(join(appDir("busy-app"), "manifest.json"))).toBe(true);
  });
});
