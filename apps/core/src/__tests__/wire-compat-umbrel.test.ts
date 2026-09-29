/**
 * Umbrel compatibility wiring:
 * - `backupIgnore` reaches the app's backup excludes on install (union with
 *   user patterns) and through a one-time, marker-guarded startup backfill
 * - catalog rewrites drop the container list's catalog lookup memo
 * - check_dependencies resolves Umbrel `implements` providers like install does
 * Real temp SQLite; Docker, compose CLI, proxy and network are mocked.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const tmp = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/talome-wire-compat-umbrel-${process.pid}-${Date.now()}`.replace(/\/+/g, "/");
  process.env.DATABASE_PATH = `${dir}/db/talome.db`;
  return { dir, home: `${dir}/home` };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedir = () => tmp.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

// Safety net: no git/network access to real remotes from this suite.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const guard = (cmd: string) => {
    if (/https?:\/\//.test(cmd)) throw new Error(`network git command blocked in tests: ${cmd}`);
  };
  const { promisify } = await import("node:util");
  const exec = ((cmd: string, ...rest: unknown[]) => {
    guard(cmd);
    return (actual.exec as (...args: unknown[]) => unknown)(cmd, ...rest);
  }) as typeof actual.exec;
  const promisified = promisify(actual.exec);
  Object.defineProperty(exec, promisify.custom, {
    value: (cmd: string, opts?: object) => {
      guard(cmd);
      return promisified(cmd, opts ?? {});
    },
  });
  return { ...actual, exec, default: { ...actual, exec } };
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
  autoRegisterProxyRoute: vi.fn(async () => ({ registered: false, reason: "proxy-disabled" })),
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

import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { CATALOG_PARSER_VERSION, initializeStores, removeStore, replaceStoreCatalog, syncStore } from "../stores/sync.js";
import { installApp } from "../stores/lifecycle.js";
import {
  backfillUmbrelBackupIgnore,
  mergeAppBackupIgnore,
  UMBREL_BACKUP_IGNORE_BACKFILL_KEY,
} from "../stores/umbrel-v2-install.js";
import { getAppBackupConfig, setAppBackupConfig } from "../backup/store.js";
import { getSetting } from "../utils/settings.js";
import { onCatalogChanged } from "../stores/catalog-events.js";
import { checkDependenciesTool } from "../ai/tools/app-tools.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "umbrel-apps");
const STORE = "fx";
const OTHER_STORE = "fx-copy";

function markInstalled(appId: string): void {
  const now = new Date().toISOString();
  db.insert(schema.installedApps)
    .values({ appId, storeSourceId: STORE, status: "running", installedAt: now, updatedAt: now })
    .run();
}

function clearMarker(): void {
  db.delete(schema.settings).where(eq(schema.settings.key, UMBREL_BACKUP_IGNORE_BACKFILL_KEY)).run();
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

describe("mergeAppBackupIgnore", () => {
  it("unions with user patterns, keeps their order and de-duplicates", () => {
    setAppBackupConfig("merge-app", { excludePatterns: ["*.log", "data/model-cache/*"] });
    const added = mergeAppBackupIgnore("merge-app", ["data/model-cache/*", "./data/thumbs/", "/etc/passwd", "../escape", "data/thumbs/"]);
    expect(added).toEqual(["data/thumbs/"]);
    expect(getAppBackupConfig("merge-app").excludePatterns).toEqual(["*.log", "data/model-cache/*", "data/thumbs/"]);
    // Idempotent
    expect(mergeAppBackupIgnore("merge-app", ["data/thumbs/"])).toEqual([]);
  });

  it("keeps the method and other settings and respects the schema cap", () => {
    const full = Array.from({ length: 199 }, (_, i) => `user-${i}/*`);
    setAppBackupConfig("cap-app", { method: "stop", excludePatterns: full, healthUrl: "http://cap:1/health" });
    expect(mergeAppBackupIgnore("cap-app", ["a/*", "b/*"])).toEqual(["a/*"]);
    const config = getAppBackupConfig("cap-app");
    expect(config.excludePatterns).toHaveLength(200);
    expect(config.method).toBe("stop");
    expect(config.healthUrl).toBe("http://cap:1/health");
  });

  it("does nothing for apps without patterns", () => {
    expect(mergeAppBackupIgnore("none-app", [])).toEqual([]);
    expect(db.all(sql`SELECT app_id FROM app_backup_configs WHERE app_id = 'none-app'`)).toEqual([]);
  });
});

describe("Umbrel install → backup excludes", () => {
  it("merges the manifest's backupIgnore into the installed app's backup config", async () => {
    setAppBackupConfig("immich", { excludePatterns: ["user/*.tmp"] });
    const result = await installApp("immich", STORE, {}, {});
    expect(result.success).toBe(true);
    // Invalid patterns (/etc/passwd, ../escape) are dropped; the user's pattern stays first.
    expect(getAppBackupConfig("immich").excludePatterns).toEqual(["user/*.tmp", "data/model-cache/*"]);
  });

  it("leaves non-Umbrel-ignore apps without a backup config", async () => {
    const result = await installApp("nextcloud", STORE, {}, {});
    expect(result.success).toBe(true);
    expect(getAppBackupConfig("nextcloud").excludePatterns).toEqual([]);
  });
});

describe("one-time backfill for already-installed Umbrel apps", () => {
  it("merges once, sets the marker and never re-adds patterns the user removed", () => {
    clearMarker();
    setAppBackupConfig("immich", { excludePatterns: ["keep/me"] });

    const first = backfillUmbrelBackupIgnore();
    expect(first).toEqual({ ran: true, updated: ["immich"] });
    expect(getAppBackupConfig("immich").excludePatterns).toEqual(["keep/me", "data/model-cache/*"]);
    expect(getSetting(UMBREL_BACKUP_IGNORE_BACKFILL_KEY)).toBeTruthy();

    // User deliberately drops the Umbrel pattern — the guarded backfill leaves it alone.
    setAppBackupConfig("immich", { excludePatterns: ["keep/me"] });
    expect(backfillUmbrelBackupIgnore()).toEqual({ ran: false, updated: [] });
    expect(getAppBackupConfig("immich").excludePatterns).toEqual(["keep/me"]);
  });

  it("runs from initializeStores after the boot catalog sync (no top-level DB work)", async () => {
    clearMarker();
    setAppBackupConfig("immich", { excludePatterns: [] });
    // Default stores already synced recently by the current parser → no network work at boot.
    const now = new Date().toISOString();
    for (const gitUrl of [
      "https://github.com/IceWhaleTech/CasaOS-AppStore.git",
      "https://github.com/getumbrel/umbrel-apps.git",
      "https://github.com/bigbeartechworld/big-bear-casaos.git",
    ]) {
      db.insert(schema.storeSources)
        .values({
          id: `default-${gitUrl.length}-${gitUrl.slice(19, 27)}`,
          name: gitUrl,
          type: "casaos",
          gitUrl,
          branch: "main",
          enabled: false,
          appCount: 1,
          lastSyncedAt: now,
          lastParsedRev: `abc:casaos:v${CATALOG_PARSER_VERSION}`,
        })
        .run();
    }

    initializeStores();
    await vi.waitFor(() => expect(getSetting(UMBREL_BACKUP_IGNORE_BACKFILL_KEY)).toBeTruthy(), { timeout: 10_000 });
    expect(getAppBackupConfig("immich").excludePatterns).toEqual(["data/model-cache/*"]);
  });
});

const catalogChanged = vi.fn();
onCatalogChanged(catalogChanged);

describe("catalog rewrites signal the container catalog lookup", () => {
  it("replaceStoreCatalog and removeStore signal a change", () => {
    const spy = catalogChanged;
    db.insert(schema.storeSources)
      .values({ id: OTHER_STORE, name: "Copy", type: "umbrel", branch: "main", localPath: FIXTURES, enabled: false, appCount: 0 })
      .run();
    spy.mockClear();
    replaceStoreCatalog(OTHER_STORE, []);
    expect(spy).toHaveBeenCalledTimes(1);
    removeStore(OTHER_STORE);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("a store sync that rewrites the catalog signals a change", async () => {
    const spy = catalogChanged;
    spy.mockClear();
    const result = await syncStore(STORE, { force: true });
    expect(result.success).toBe(true);
    expect(spy).toHaveBeenCalled();
  });
});

describe("check_dependencies resolves Umbrel implements like install_app", () => {
  const check = (input: Record<string, unknown>) =>
    (checkDependenciesTool.execute as Function)(input, {}) as Promise<{
      satisfied: boolean;
      missing: Array<{ appId: string }>;
      installed: Array<{ appId: string; name: string }>;
      message: string;
    }>;

  it("reports the dependency missing when nothing provides it", async () => {
    db.update(schema.appCatalog)
      .set({ dependencies: JSON.stringify(["llm-runtime"]) })
      .where(eq(schema.appCatalog.appId, "webui-tuner"))
      .run();
    const result = await check({ appId: "webui-tuner", storeId: STORE });
    expect(result.satisfied).toBe(false);
    expect(result.missing.map((d) => d.appId)).toEqual(["llm-runtime"]);
  });

  it("accepts an installed app that implements the dependency", async () => {
    markInstalled("ollama"); // implements llm-runtime
    const result = await check({ appId: "webui-tuner", storeId: STORE });
    expect(result.satisfied).toBe(true);
    expect(result.installed[0]).toMatchObject({ appId: "ollama", name: "ollama (provides llm-runtime)" });
    expect(result.message).toBe("All dependencies are satisfied.");
  });

  it("honours explicit provider choices and rejects uninstalled ones", async () => {
    const chosen = await check({ appId: "webui-tuner", storeId: STORE, umbrel: { dependencies: { "llm-runtime": "ollama" } } });
    expect(chosen.satisfied).toBe(true);
    const wrong = await check({ appId: "webui-tuner", storeId: STORE, umbrel: { dependencies: { "llm-runtime": "localai" } } });
    expect(wrong.satisfied).toBe(false);
  });

  it("keeps working for non-Umbrel apps and unknown apps", async () => {
    const unknown = await check({ appId: "does-not-exist", storeId: STORE });
    expect(unknown.satisfied).toBe(true);
  });
});
