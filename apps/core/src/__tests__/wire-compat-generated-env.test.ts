/**
 * Talome-store manifests can ask Talome to generate an env value per install
 * ({"generate": "alnum32"}) — the app-store Immich DB password. An install
 * without the value succeeds and persists a random value; a reinstall reuses
 * the value kept in the app's .env (Postgres ignores a new password for an
 * existing data dir); a clean app-data folder gets a fresh one; explicit
 * install env wins. Real temp SQLite; Docker and the compose CLI are mocked.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const tmp = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/talome-wire-compat-genenv-${process.pid}-${Date.now()}`.replace(/\/+/g, "/");
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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { syncStore } from "../stores/sync.js";
import { installApp, uninstallApp } from "../stores/lifecycle.js";
import { APP_DATA_DIR } from "../stores/compose-exec.js";
import { fillGeneratedInstallEnv, generateEnvValue, readGeneratedEnvSpecs } from "../stores/generated-env.js";

const APP_STORE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "app-store");
const IMMICH_COMPOSE = join(APP_STORE, "apps", "immich", "docker-compose.yml");
const STORE = "talome-genenv";
const ALNUM32 = /^[A-Za-z0-9]{32}$/;

function installedEnv(appId: string): Record<string, string> {
  const row = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, appId)).get();
  return JSON.parse(row?.envConfig ?? "{}") as Record<string, string>;
}

function dotEnv(appId: string): string {
  return readFileSync(join(APP_DATA_DIR, appId, ".env"), "utf-8");
}

beforeAll(async () => {
  runMigrations();
  db.insert(schema.storeSources)
    .values({ id: STORE, name: "Talome app store", type: "talome", branch: "main", localPath: APP_STORE, enabled: true, appCount: 0 })
    .run();
  expect((await syncStore(STORE)).success).toBe(true);
});

afterAll(() => {
  rmSync(tmp.dir, { recursive: true, force: true });
});

describe("generated install env", () => {
  it("reads the generate hints from the manifest next to the compose file", () => {
    expect(readGeneratedEnvSpecs(IMMICH_COMPOSE)).toEqual([{ key: "DB_PASSWORD", kind: "alnum32" }]);
    expect(readGeneratedEnvSpecs(join(tmp.dir, "nowhere", "docker-compose.yml"))).toEqual([]);
  });

  it("generates strong values that differ every time", () => {
    const a = generateEnvValue("alnum32");
    const b = generateEnvValue("alnum32");
    expect(a).toMatch(ALNUM32);
    expect(b).toMatch(ALNUM32);
    expect(a).not.toBe(b);
    expect(generateEnvValue("hex64")).toMatch(/^[0-9a-f]{64}$/);
    // Two different installs never share a password.
    const one = fillGeneratedInstallEnv("immich-a", IMMICH_COMPOSE, {}).env.DB_PASSWORD;
    const two = fillGeneratedInstallEnv("immich-b", IMMICH_COMPOSE, {}).env.DB_PASSWORD;
    expect(one).toMatch(ALNUM32);
    expect(two).toMatch(ALNUM32);
    expect(one).not.toBe(two);
  });

  it("installs Immich without DB_PASSWORD and persists a random value", async () => {
    const result = await installApp("immich", STORE, {}, {});
    expect(result).toMatchObject({ success: true });
    const password = installedEnv("immich").DB_PASSWORD;
    expect(password).toMatch(ALNUM32);
    expect(password).not.toMatch(/^(postgres|immich|password)$/i);
    expect(dotEnv("immich")).toContain(`DB_PASSWORD=${password}\n`);
  });

  it("reuses the kept password on reinstall so the existing database still opens", async () => {
    const before = installedEnv("immich").DB_PASSWORD;
    expect((await uninstallApp("immich")).success).toBe(true);
    expect(existsSync(join(APP_DATA_DIR, "immich", ".env"))).toBe(true);

    expect((await installApp("immich", STORE, {}, {})).success).toBe(true);
    expect(installedEnv("immich").DB_PASSWORD).toBe(before);
  });

  it("generates a fresh password once the app's data folder is gone", async () => {
    const before = installedEnv("immich").DB_PASSWORD;
    expect((await uninstallApp("immich")).success).toBe(true);
    rmSync(join(APP_DATA_DIR, "immich"), { recursive: true, force: true });

    expect((await installApp("immich", STORE, {}, {})).success).toBe(true);
    const after = installedEnv("immich").DB_PASSWORD;
    expect(after).toMatch(ALNUM32);
    expect(after).not.toBe(before);
  });

  it("lets an explicit install env value win", async () => {
    expect((await uninstallApp("immich")).success).toBe(true);
    expect((await installApp("immich", STORE, { DB_PASSWORD: "ChosenByTheUser123" }, {})).success).toBe(true);
    expect(installedEnv("immich").DB_PASSWORD).toBe("ChosenByTheUser123");
  });

  it("ignores manifests without generate hints and malformed ones", () => {
    const dir = join(tmp.dir, "custom");
    mkdirSync(dir, { recursive: true });
    const compose = join(dir, "docker-compose.yml");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ env: [{ key: "X", generate: "bogus" }] }));
    expect(readGeneratedEnvSpecs(compose)).toEqual([]);
    writeFileSync(join(dir, "manifest.json"), "{not json");
    expect(fillGeneratedInstallEnv("custom", compose, { A: "1" })).toEqual({ env: { A: "1" }, generated: [], reused: [] });
  });
});
