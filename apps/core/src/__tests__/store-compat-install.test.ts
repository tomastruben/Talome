/**
 * Umbrel 2.0 install hook: install options reach the pipeline via
 * AsyncLocalStorage, the compose file Talome runs carries folder/env/GPU
 * mappings, torOnly apps are refused, implements-based dependencies resolve.
 * Real temp SQLite; Docker, compose CLI, proxy and network are mocked.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const tmp = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/talome-store-compat-install-${process.pid}-${Date.now()}`.replace(/\/+/g, "/");
  process.env.DATABASE_PATH = `${dir}/db/talome.db`;
  return { dir, home: `${dir}/home` };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedir = () => tmp.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock("../docker/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../docker/client.js")>()),
  listContainers: vi.fn(async () => []),
  listNetworks: vi.fn(async () => []),
  removeNetwork: vi.fn(async () => {}),
  connectContainerToNetwork: vi.fn(async () => {}),
}));

vi.mock("../docker/talome-network.js", () => ({
  ensureTalomeNetwork: vi.fn(async () => {}),
  injectTalomeNetwork: vi.fn((doc: Record<string, unknown>) => doc),
}));

vi.mock("../proxy/caddy.js", () => ({
  autoRegisterProxyRoute: vi.fn(async () => {}),
  removeProxyRoutesForApp: vi.fn(async () => {}),
}));

vi.mock("../setup/triggers.js", () => ({ onAppInstalled: vi.fn() }));
vi.mock("../app-registry/auto-configure.js", () => ({
  autoConfigureApp: vi.fn(async () => ({ apiKeyExtracted: false, settingsSaved: [], wiring: [], warnings: [] })),
}));
vi.mock("../automation/engine.js", () => ({ fireTrigger: vi.fn(async () => {}) }));

vi.mock("../stores/compose-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/compose-exec.js")>()),
  run: vi.fn(async () => ({ stdout: "", stderr: "" })),
  validateCompose: vi.fn(async () => ({ valid: true })),
  discoverContainers: vi.fn(async () => ["c1"]),
  pinImageDigest: vi.fn(),
}));

import { existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { syncStore } from "../stores/sync.js";
import { installApp } from "../stores/lifecycle.js";
import { withAppLock } from "../stores/compose-exec.js";
import {
  appRequiresHttps,
  applyUmbrelV2Install,
  getActiveUmbrelInstallOptions,
  getAppBackupIgnore,
  getAppInstallOptions,
  reconcileUmbrelDependencies,
  runWithUmbrelInstallOptions,
} from "../stores/umbrel-v2-install.js";
import { stores } from "../routes/stores.js";
import { composeServiceImages, readImageRefState } from "../ops/image-refs.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "umbrel-apps");
const STORE = "fx";

function catalogRow(appId: string) {
  return db
    .select()
    .from(schema.appCatalog)
    .where(eq(schema.appCatalog.appId, appId))
    .all()
    .find((r) => r.storeSourceId === STORE)!;
}

function markInstalled(appId: string): void {
  const now = new Date().toISOString();
  db.insert(schema.installedApps)
    .values({ appId, storeSourceId: STORE, status: "running", installedAt: now, updatedAt: now })
    .run();
}

beforeAll(async () => {
  runMigrations();
  db.insert(schema.storeSources)
    .values({ id: STORE, name: "Fixtures", type: "umbrel", branch: "main", localPath: FIXTURES, enabled: true, appCount: 0 })
    .run();
  const result = await syncStore(STORE);
  expect(result.success).toBe(true);
});

afterAll(() => {
  rmSync(tmp.dir, { recursive: true, force: true });
});

describe("install options context", () => {
  it("propagates through the per-app lock", async () => {
    const options = { folders: { photos: "/Volumes/Photos" } };
    const seen = await runWithUmbrelInstallOptions(options, () =>
      withAppLock("ctx-test", async () => {
        await new Promise((r) => setTimeout(r, 5));
        return getActiveUmbrelInstallOptions();
      }),
    );
    expect(seen).toEqual(options);
    expect(getActiveUmbrelInstallOptions()).toEqual({});
  });
});

describe("applyUmbrelV2Install", () => {
  it("is a no-op for non-Umbrel apps", () => {
    const row = { ...catalogRow("immich"), source: "casaos" };
    const result = applyUmbrelV2Install(row, "immich", row.composePath, { A: "1" });
    expect(result).toEqual({ ok: true, composePath: null, env: { A: "1" }, plan: null });
  });

  it("refuses torOnly apps with a clear reason", () => {
    const row = catalogRow("onion-board");
    const result = applyUmbrelV2Install(row, "onion-board", row.composePath, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Tor-only/);
  });

  it("rejects environment values outside the allowed options", async () => {
    const row = catalogRow("webui-tuner");
    const result = await runWithUmbrelInstallOptions({ environment: { LOG_LEVEL: "verbose" } }, async () =>
      applyUmbrelV2Install(row, "webui-tuner", row.composePath, {}),
    );
    expect(result.ok).toBe(false);
  });

  it("lets the install `env` parameter override a manifest default (compose keeps ${NAME})", async () => {
    const row = catalogRow("webui-tuner");
    const result = await runWithUmbrelInstallOptions({ environment: { LOG_LEVEL: "debug" } }, async () =>
      applyUmbrelV2Install(row, "tuner-env", row.composePath, { MODEL_HOST: "http://mine:2" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.MODEL_HOST).toBe("http://mine:2");
    const doc = yaml.load(readFileSync(result.composePath!, "utf-8")) as { services: { web: { environment: Record<string, string> } } };
    expect(doc.services.web.environment).toMatchObject({ MODEL_URL: "${MODEL_HOST}", LOG_LEVEL: "debug" });
  });

  it("refuses a chosen folder that is a symlink into a protected tree", async () => {
    const link = join(tmp.dir, "sneaky-link");
    symlinkSync("/etc", link);
    const row = catalogRow("photo-vault");
    const result = await runWithUmbrelInstallOptions({ folders: { photos: link } }, async () =>
      applyUmbrelV2Install(row, "sneaky", row.composePath, {}),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/resolves to .*etc/);
  });

  it("only exposes saved options for installed apps and prunes stale rows", async () => {
    // "tuner-env" saved options above but was never installed.
    expect(getAppInstallOptions("tuner-env")).toBeNull();
    const row = catalogRow("webui-tuner");
    await runWithUmbrelInstallOptions({ environment: { LOG_LEVEL: "info" } }, async () =>
      applyUmbrelV2Install(row, "tuner-other", row.composePath, {}),
    );
    const ids = db.select().from(schema.appInstallOptions).all().map((r) => r.appId);
    expect(ids).toContain("tuner-other");
    expect(ids).not.toContain("tuner-env");
  });
});

describe("installApp with Umbrel 2.0 options (end to end, docker mocked)", () => {
  it("writes folderAccess mounts, data root and env choices into the compose Talome runs", async () => {
    const result = await runWithUmbrelInstallOptions(
      { folders: { photos: "/Volumes/Photos", import: "/srv/inbox" } },
      () => installApp("photo-vault", STORE, {}, {}),
    );
    expect(result).toMatchObject({ success: true });

    const installed = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, "photo-vault")).get()!;
    expect(installed.overrideComposePath).toBe(join(tmp.home, ".talome", "app-data", "photo-vault", "docker-compose.yml"));
    const doc = yaml.load(readFileSync(installed.overrideComposePath!, "utf-8")) as { services: Record<string, { volumes: string[] }> };
    expect(Object.keys(doc.services)).toEqual(["web"]);
    expect(doc.services.web.volumes).toEqual(
      expect.arrayContaining(["/Volumes/Photos:/photoprism/originals", "/srv/inbox:/photoprism/import:ro"]),
    );

    const saved = getAppInstallOptions("photo-vault");
    expect(saved?.options).toEqual({ folders: { photos: "/Volumes/Photos", import: "/srv/inbox" } });
    expect(saved?.plan).toMatchObject({ requiresHttps: false });
  });

  it("maps ${UMBREL_ROOT} paths so legacy apps install without UMBREL_ROOT", async () => {
    const result = await installApp("jellyfin", STORE, {}, {});
    expect(result).toMatchObject({ success: true });
    const installed = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, "jellyfin")).get()!;
    const text = readFileSync(installed.overrideComposePath!, "utf-8");
    expect(text).not.toContain("UMBREL_ROOT");
    expect(text).toContain(join(tmp.home, ".talome", "app-data", "jellyfin", "downloads"));
    // fallback folders are created up front
    expect(existsSync(join(tmp.home, ".talome", "app-data", "jellyfin", "downloads"))).toBe(true);
  });

  it("applies environment choices and required defaults to the compose + .env", async () => {
    const result = await runWithUmbrelInstallOptions({ environment: { LOG_LEVEL: "debug" } }, () =>
      installApp("webui-tuner", STORE, {}, {}),
    );
    expect(result).toMatchObject({ success: true });
    const installed = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, "webui-tuner")).get()!;
    const doc = yaml.load(readFileSync(installed.overrideComposePath!, "utf-8")) as { services: { web: { environment: Record<string, string> } } };
    expect(doc.services.web.environment.LOG_LEVEL).toBe("debug");
    expect(JSON.parse(installed.envConfig).MODEL_HOST).toBe("http://ollama_ollama_1:11434");
  });

  it("refuses a torOnly app before creating an installed row", async () => {
    const result = await installApp("onion-board", STORE, {}, {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Tor-only/);
    expect(db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, "onion-board")).get()).toBeUndefined();
  });

  it("keeps the existing API working without options", async () => {
    const result = await installApp("immich", STORE, {}, {});
    expect(result.success).toBe(true);
    expect(getAppBackupIgnore("immich")).toEqual(["data/model-cache/*"]);
    expect(appRequiresHttps("immich")).toBe(false);
  });

  it("records the image refs it installed, so updates can tell them from the user's pins", async () => {
    const result = await installApp("nextcloud", STORE, {}, {});
    expect(result.success).toBe(true);
    const installed = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, "nextcloud")).get()!;
    const images = composeServiceImages(installed.overrideComposePath!);
    expect(images).toMatchObject({ db: "mariadb:10.11.5", redis: "redis:7.2.4" });
    const state = readImageRefState("nextcloud")!;
    expect(state.pinned).toEqual({});
    expect(Object.keys(state.managed).sort()).toEqual(Object.keys(images).sort());
    for (const [service, image] of Object.entries(images)) expect(state.managed[service]).toEqual([image]);
  });
});

describe("dependencies via implements", () => {
  it("accepts an installed app that implements the dependency", () => {
    markInstalled("ollama"); // implements llm-runtime
    const row = { ...catalogRow("webui-tuner"), dependencies: JSON.stringify(["llm-runtime"]) };
    const check = reconcileUmbrelDependencies(row, {
      satisfied: false,
      missing: [{ appId: "llm-runtime", name: "llm-runtime" }],
      installed: [],
    });
    expect(check.satisfied).toBe(true);
    expect(check.installed[0]).toMatchObject({ appId: "ollama", name: "ollama (provides llm-runtime)" });
  });

  it("still reports dependencies nobody provides", async () => {
    const result = await installApp("sonarr", STORE, {}, {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Missing dependencies: transmission/);
  });
});

describe("POST /api/stores/:storeId/apps/:appId/install-plan", () => {
  const app = new Hono().route("/api/stores", stores);

  it("previews folders, env inputs and blockers", async () => {
    const res = await app.request(`/api/stores/${STORE}/apps/photo-vault/install-plan`, {
      method: "POST",
      body: JSON.stringify({ folders: { photos: "/etc" } }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { folders: { id: string }[]; blockers: string[] }; umbrel: { storage: unknown } };
    expect(body.plan.folders.map((f) => f.id)).toEqual(["photos", "import"]);
    expect(body.plan.blockers[0]).toMatch(/protected system folder/);
    expect(body.umbrel.storage).toEqual({ dataRoot: "data" });
  });

  it("works without a body and 404s for unknown apps", async () => {
    const ok = await app.request(`/api/stores/${STORE}/apps/onion-board/install-plan`, { method: "POST" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { plan: { supported: boolean } }).plan.supported).toBe(false);
    const missing = await app.request(`/api/stores/${STORE}/apps/nope/install-plan`, { method: "POST" });
    expect(missing.status).toBe(404);
  });

  it("validates the body", async () => {
    const res = await app.request(`/api/stores/${STORE}/apps/photo-vault/install-plan`, {
      method: "POST",
      body: JSON.stringify({ folders: "nope" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid force flag on sync", async () => {
    const res = await app.request(`/api/stores/${STORE}/sync?force=maybe`, { method: "POST" });
    expect(res.status).toBe(400);
  });
});
