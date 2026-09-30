/**
 * Regressions from end-to-end testing against a real Docker engine
 * (review-findings/e2e-report.md, group A1): start must not `down` first,
 * containers are found by compose project label, uninstall verifies removal
 * and removes only anonymous volumes, updates carry catalog config changes and
 * return their outcome, REST lifecycle operations are audited, a missing
 * compose plugin is named as such, and refused calls leave no journal row.
 * Real temp SQLite; the docker CLI (`run`) and Docker API listing are mocked.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const tmp = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/talome-lifecycle-e2e-${process.pid}-${Date.now()}`.replace(/\/+/g, "/");
  process.env.DATABASE_PATH = `${dir}/db/talome.db`;
  return { dir, home: `${dir}/home` };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedir = () => tmp.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

const m = vi.hoisted(() => ({
  run: vi.fn(),
  listContainers: vi.fn(),
  validateCompose: vi.fn(),
  probeDockerCompose: vi.fn(),
  captureServiceImages: vi.fn(),
  verifyAppHealth: vi.fn(),
  restoreServiceImages: vi.fn(),
  probeHttp: vi.fn(),
  writeNotification: vi.fn(),
}));

vi.mock("../stores/compose-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stores/compose-exec.js")>();
  return {
    ...actual,
    run: m.run,
    buildEnv: (_appId: string, env: Record<string, string> = {}) => ({ ...env }),
    writeAppDotEnv: vi.fn(),
    validateCompose: m.validateCompose,
    probeDockerCompose: m.probeDockerCompose,
    pinImageDigest: vi.fn(),
  };
});

vi.mock("../docker/client.js", () => ({
  listContainers: m.listContainers,
  listNetworks: vi.fn(async () => []),
  removeNetwork: vi.fn(),
  connectContainerToNetwork: vi.fn(),
  docker: {},
}));

vi.mock("../ops/docker-probe.js", () => ({
  captureServiceImages: m.captureServiceImages,
  verifyAppHealth: m.verifyAppHealth,
  restoreServiceImages: m.restoreServiceImages,
  probeHttp: m.probeHttp,
}));
vi.mock("../ops/pre-update-backup.js", () => ({
  isPreUpdateBackupEnabled: vi.fn(() => false),
  takePreUpdateBackup: vi.fn(),
  findPreUpdateBackupId: vi.fn(() => null),
  backupTriggerForActor: vi.fn(() => "manual"),
}));
vi.mock("../ops/semantic-verify.js", () => ({
  hasSemanticProbe: vi.fn(async () => false),
  getSemanticBaseline: vi.fn(async () => null),
  runSemanticVerification: vi.fn(),
}));
vi.mock("../docker/talome-network.js", () => ({
  ensureTalomeNetwork: vi.fn(async () => {}),
  injectTalomeNetwork: vi.fn((doc: Record<string, unknown>) => doc),
}));
vi.mock("../db/notifications.js", () => ({ writeNotification: m.writeNotification }));
vi.mock("../stores/compose-errors.js", () => ({ recordInstallError: vi.fn() }));
vi.mock("../stores/lifecycle-hooks.js", () => ({ executeHook: vi.fn(async () => {}) }));
vi.mock("../automation/engine.js", () => ({ fireTrigger: vi.fn(async () => []) }));
vi.mock("../setup/triggers.js", () => ({ onAppInstalled: vi.fn() }));
vi.mock("../proxy/caddy.js", () => ({ autoRegisterProxyRoute: vi.fn(), removeProxyRoutesForApp: vi.fn() }));
vi.mock("../app-registry/auto-configure.js", () => ({ autoConfigureApp: vi.fn() }));
vi.mock("../app-registry/index.js", () => ({ getAppCapabilities: vi.fn(() => null) }));

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { installApp, startApp, stopApp, restartApp, uninstallApp, updateApp, rollbackUpdate } from "../stores/lifecycle.js";
import {
  APP_DATA_DIR,
  COMPOSE_MISSING_MESSAGE,
  composeFileProjectName,
  isComposeMissingError,
  selectComposeContainers,
} from "../stores/compose-exec.js";
import { mergeCatalogConfig, readCatalogBase, recordCatalogBase } from "../stores/catalog-sync.js";
import { runInActorContext } from "../ai/actor-context.js";
import { __resetActiveOperationsForTests } from "../ops/operations.js";
import type { ServiceImageState } from "../ops/docker-probe.js";
import { apps } from "../routes/apps.js";

const STORE = "user-apps";
const APP = "bkrs-pgapp";

interface FakeContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: never[];
  created: string;
  labels: Record<string, string>;
}

let live: FakeContainer[] = [];
let composePath = "";

function container(id: string, name: string, labels: Record<string, string>, status = "running"): FakeContainer {
  return { id, name, image: "postgres:16-alpine", status, ports: [], created: new Date(0).toISOString(), labels };
}

function projectLabels(project: string, file: string): Record<string, string> {
  return { "com.docker.compose.project": project, "com.docker.compose.project.config_files": file, "com.docker.compose.service": "x" };
}

function commands(): string[] {
  return m.run.mock.calls.map((c) => String(c[0]));
}

function installedRow(appId = APP) {
  return db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, appId)).get();
}

function operationRows(appId = APP) {
  return db.select().from(schema.appOperations).where(eq(schema.appOperations.appId, appId)).all();
}

function addApp(appId: string, compose: string, opts: { status?: string; override?: string | null; version?: string; catalogVersion?: string; source?: string } = {}): string {
  const dir = join(tmp.dir, "user-apps", "apps", appId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "docker-compose.yml");
  writeFileSync(path, compose);
  db.insert(schema.appCatalog).values({
    appId, storeSourceId: STORE, name: appId, version: opts.catalogVersion ?? "1.0.0", source: opts.source ?? "user-created", composePath: path,
  }).run();
  const now = new Date().toISOString();
  if (opts.status !== undefined) {
    db.insert(schema.installedApps).values({
      appId, storeSourceId: STORE, status: opts.status, envConfig: "{}", containerIds: "[]",
      version: opts.version ?? "1.0.0", overrideComposePath: opts.override === undefined ? path : opts.override, installedAt: now, updatedAt: now,
    }).run();
  }
  return path;
}

beforeAll(() => {
  mkdirSync(join(tmp.dir, "db"), { recursive: true });
  runMigrations();
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetActiveOperationsForTests();
  for (const t of [schema.appOperationEvents, schema.appOperations, schema.updateSnapshots, schema.installedApps, schema.appCatalog, schema.auditLog]) {
    db.delete(t).run();
  }
  db.delete(schema.storeSources).run();
  db.insert(schema.storeSources).values({ id: STORE, name: "User apps", type: "talome" }).run();

  // The creator names containers after their services (container_name: bkrs-db).
  composePath = addApp(APP, "services:\n  bkrs-db:\n    image: postgres:16-alpine\n    container_name: bkrs-db\n", { status: "stopped" });
  live = [container("db0000000001", "bkrs-db", projectLabels(APP, composePath), "exited")];

  m.listContainers.mockImplementation(async () => live.map((c) => ({ ...c, labels: { ...c.labels } })));
  m.run.mockImplementation(async (cmd: string) => {
    if (cmd.includes(" up -d")) live = live.map((c) => ({ ...c, status: "running" }));
    if (cmd.includes(" down")) live = [];
    return { stdout: "", stderr: "" };
  });
  m.validateCompose.mockResolvedValue({ valid: true });
  m.probeDockerCompose.mockResolvedValue({ available: true, version: "2.29.0" });
});

describe("start keeps the app's containers (and their anonymous volumes)", () => {
  it("runs `up -d` without `down` first and records the containers found by compose project label", async () => {
    const result = await startApp(APP);

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    const cmds = commands();
    // `down` would delete the containers and orphan their anonymous volumes (data loss).
    expect(cmds.some((c) => /\bdown\b/.test(c))).toBe(false);
    expect(cmds.filter((c) => c.includes(" up -d"))).toHaveLength(1);
    // Found although the container is not named after the app.
    expect(JSON.parse(installedRow()!.containerIds)).toEqual(["db0000000001"]);
    expect(installedRow()!.status).toBe("running");
  });

  it("restart recreates in place (no `down`) and discovers by label", async () => {
    const result = await restartApp(APP);
    expect(result.success).toBe(true);
    expect(commands().some((c) => /\bdown\b/.test(c))).toBe(false);
    expect(JSON.parse(installedRow()!.containerIds)).toEqual(["db0000000001"]);
  });
});

describe("container selection by compose project", () => {
  const file = "/data/apps/Some_Dir/docker-compose.yml";

  it("derives the project name like compose does (top-level name, else the directory)", () => {
    const dir = join(tmp.dir, "names", "My_App.x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "docker-compose.yml"), "services: {}\n");
    expect(composeFileProjectName(join(dir, "docker-compose.yml"))).toBe("my_appx");
    writeFileSync(join(dir, "named.yml"), "name: Custom-Name\nservices: {}\n");
    expect(composeFileProjectName(join(dir, "named.yml"))).toBe("custom-name");
  });

  it("matches the project label or config file, never other projects whose names start with the id", () => {
    const all = [
      { id: "a", name: "db", labels: projectLabels("some_dir", file) },
      { id: "b", name: "plex-meta-manager", labels: projectLabels("plex-meta-manager", "/x/pmm.yml") },
      { id: "c", name: "plex-hand-started", labels: {} },
    ];
    expect(selectComposeContainers(all, "plex", file).map((c) => c.id)).toEqual(["a"]);
    // Without a labelled container, discovery falls back to names — but not to another plex-* project.
    expect(selectComposeContainers(all.slice(1), "plex").map((c) => c.id)).toEqual(["c"]);
    // Removal paths are strict: labels only.
    expect(selectComposeContainers(all.slice(1), "plex", null, { strict: true })).toEqual([]);
  });
});

describe("uninstall verifies removal and keeps user data", () => {
  it("fails and keeps the app tracked when compose down fails and the containers cannot be removed", async () => {
    live = [container("db0000000001", "bkrs-db", projectLabels(APP, composePath))];
    m.run.mockImplementation(async (cmd: string) => {
      if (cmd.includes(" down")) throw Object.assign(new Error("down failed"), { stderr: "unknown shorthand flag: 'f' in -f" });
      return { stdout: "", stderr: "" }; // `docker rm -f` "succeeds" but the container stays
    });

    const result = await uninstallApp(APP);

    expect(result.success).toBe(false);
    expect(result.error).toContain("bkrs-db still exist");
    expect(installedRow()).toBeDefined();
    expect(commands()).toContain("docker rm -f db0000000001");
  });

  it("removes the containers by compose project label when compose down fails", async () => {
    live = [container("db0000000001", "bkrs-db", projectLabels(APP, composePath))];
    m.run.mockImplementation(async (cmd: string) => {
      if (cmd.includes(" down")) throw Object.assign(new Error("down failed"), { stderr: "compose unavailable" });
      if (cmd.startsWith("docker rm -f")) live = [];
      return { stdout: "", stderr: "" };
    });

    const result = await uninstallApp(APP);

    expect(result.success).toBe(true);
    expect(installedRow()).toBeUndefined();
    // Never -v: that would also remove named volumes.
    expect(commands().some((c) => / -v\b/.test(c))).toBe(false);
  });

  it("removes only the project's anonymous volumes, recorded before `down`, never named volumes", async () => {
    const anon = "a".repeat(64);
    const legacyAnon = "b".repeat(64);
    live = [container("db0000000001", "bkrs-db", projectLabels(APP, composePath))];
    m.run.mockImplementation(async (cmd: string) => {
      if (cmd.startsWith("docker inspect")) {
        return {
          stdout: JSON.stringify([
            { Type: "volume", Name: "bkrs-pgapp_pgdata" },
            { Type: "volume", Name: anon },
            { Type: "volume", Name: legacyAnon },
            { Type: "volume", Name: "c".repeat(64) },
            { Type: "bind", Source: "/home/me/.talome/app-data/bkrs-pgapp/data" },
          ]) + "\n",
          stderr: "",
        };
      }
      if (cmd.startsWith("docker volume inspect")) {
        return {
          stdout: [
            `bkrs-pgapp_pgdata {"com.docker.compose.project":"bkrs-pgapp","com.docker.compose.volume":"pgdata"}`,
            `${anon} {"com.docker.volume.anonymous":""}`,
            `${legacyAnon} null`,
            // 64-hex but declared by compose: a named volume, kept.
            `${"c".repeat(64)} {"com.docker.compose.volume":"x"}`,
          ].join("\n"),
          stderr: "",
        };
      }
      if (cmd.includes(" down")) live = [];
      return { stdout: "", stderr: "" };
    });

    const result = await uninstallApp(APP);

    expect(result.success).toBe(true);
    const cmds = commands();
    const inspectAt = cmds.findIndex((c) => c.startsWith("docker inspect"));
    const downAt = cmds.findIndex((c) => c.includes(" down"));
    expect(inspectAt).toBeGreaterThanOrEqual(0);
    expect(inspectAt).toBeLessThan(downAt);
    const removed = cmds.filter((c) => c.startsWith("docker volume rm")).map((c) => c.split(" ").pop());
    expect(removed.sort()).toEqual([anon, legacyAnon].sort());
    expect(cmds.some((c) => c.includes("down -v") || c.includes("--volumes"))).toBe(false);
  });

  it("still removes the containers when the catalog entry is gone", async () => {
    db.delete(schema.appCatalog).run();
    live = [container("db0000000001", "bkrs-db", projectLabels(APP, composePath))];

    const result = await uninstallApp(APP);
    expect(result.success).toBe(true);
    expect(commands().some((c) => c.includes(`-f "${composePath}" down`))).toBe(true);
    expect(live).toEqual([]);
  });
});

describe("calls on apps that are not installed", () => {
  it("are refused before a journal row is written", async () => {
    db.delete(schema.installedApps).run();
    for (const call of [stopApp, startApp, restartApp, uninstallApp, updateApp, rollbackUpdate]) {
      const result = await call(APP);
      expect(result.success).toBe(false);
      expect(result.error).toBe("App is not installed");
    }
    expect(operationRows()).toEqual([]);
    expect(m.run).not.toHaveBeenCalled();
  });
});

describe("audit of lifecycle operations started outside a tool call", () => {
  beforeEach(() => {
    db.delete(schema.users).run();
    db.insert(schema.users).values({ id: "u1", username: "alice", passwordHash: "x", role: "admin" }).run();
  });

  it("writes one attributed row for a REST start", async () => {
    const result = await startApp(APP, { actor: "user:u1" });
    expect(result.success).toBe(true);

    const rows = db.select().from(schema.auditLog).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "Started app",
      tier: "modify",
      actorKind: "user",
      actorId: "u1",
      actorLabel: "alice",
      source: "api",
      outcome: "success",
    });
    expect(rows[0].details).toContain(APP);
    expect(rows[0].details).toContain(result.operationId!);
  });

  it("records failures too, and leaves tool calls to executeTool's own audit row", async () => {
    m.run.mockRejectedValue(Object.assign(new Error("boom"), { stderr: "port is already allocated" }));
    const failed = await startApp(APP, { actor: "user:u1" });
    expect(failed.success).toBe(false);
    expect(db.select().from(schema.auditLog).all()).toMatchObject([{ action: "Start failed", outcome: "error", actorId: "u1" }]);

    db.delete(schema.auditLog).run();
    m.run.mockResolvedValue({ stdout: "", stderr: "" });
    await runInActorContext({ kind: "mcp_token", id: "tok-1", label: "MCP token" }, "mcp", () => stopApp(APP));
    expect(db.select().from(schema.auditLog).all()).toEqual([]);
  });
});

describe("missing Docker Compose v2 plugin", () => {
  it("is reported as such by start, not as a compose error", async () => {
    m.run.mockRejectedValue(Object.assign(new Error("exit 125"), { stderr: "unknown shorthand flag: 'f' in -f\nSee 'docker --help'." }));
    const result = await startApp(APP);
    expect(result.success).toBe(false);
    expect(result.error).toBe(COMPOSE_MISSING_MESSAGE);
    expect(result.error).toContain("Docker Compose v2 plugin not found");
  });

  it("is reported as such by install instead of 'Compose file validation failed'", async () => {
    addApp("fresh-app", "services:\n  web:\n    image: nginx:1.29-alpine\n");
    m.validateCompose.mockResolvedValue({ valid: false, error: "unknown shorthand flag: 'f' in -f" });
    m.probeDockerCompose.mockResolvedValue({ available: false, error: "docker: 'compose' is not a docker command." });

    const result = await installApp("fresh-app", STORE);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Docker Compose v2 plugin not found");
    expect(result.error).not.toContain("Compose file validation failed");
    expect(installedRow("fresh-app")).toBeUndefined();
  });

  it("recognises the classic CLI's errors for a missing plugin", () => {
    expect(isComposeMissingError("unknown shorthand flag: 'f' in -f")).toBe(true);
    expect(isComposeMissingError("docker: 'compose' is not a docker command.")).toBe(true);
    expect(isComposeMissingError("service \"db\" refers to undefined volume x")).toBe(false);
  });
});

describe("updates carry catalog configuration changes", () => {
  const PROBE = "upd-probe";
  let catalogPath = "";
  let overridePath = "";

  const CATALOG_V1 = {
    services: {
      web: {
        image: "nginx:1.29-alpine",
        environment: { A: "1", B: "orig" },
        healthcheck: { test: ["CMD", "true"], interval: "30s" },
        ports: ["8080:80"],
      },
    },
  };
  const CATALOG_V2 = {
    services: {
      web: {
        image: "nginx:1.29-alpine",
        environment: { A: "2", B: "new", PROBE: "v2" },
        healthcheck: { test: ["CMD", "wget", "-q", "localhost"], interval: "10s" },
        ports: ["9090:80"],
      },
    },
  };
  // What the install wrote: the catalog plus Talome's port remap and network, and a user env edit.
  const OVERRIDE = {
    services: {
      web: {
        image: "nginx:1.29-alpine",
        environment: { A: "1", B: "mine" },
        healthcheck: { test: ["CMD", "true"], interval: "30s" },
        ports: ["18080:80"],
        networks: ["talome"],
      },
    },
    networks: { talome: { external: true } },
  };

  const baseline: ServiceImageState[] = [{
    service: "web", containerId: "c1", containerName: "upd-probe-web-1", imageRef: "nginx:1.29-alpine",
    imageId: "sha256:" + "a".repeat(64), repoDigest: null, status: "running",
  }];
  // `up -d` recreated the container (new config), same image bytes.
  const recreatedSameImage: ServiceImageState[] = [{ ...baseline[0], containerId: "c2" }];

  beforeEach(() => {
    catalogPath = addApp(PROBE, yaml.dump(CATALOG_V2), { status: "running", version: "1.3.0", catalogVersion: "1.5.0", override: null });
    overridePath = join(APP_DATA_DIR, PROBE, "docker-compose.yml");
    rmSync(join(APP_DATA_DIR, PROBE), { recursive: true, force: true });
    mkdirSync(join(APP_DATA_DIR, PROBE), { recursive: true });
    writeFileSync(overridePath, yaml.dump(OVERRIDE));
    db.update(schema.installedApps).set({ overrideComposePath: overridePath }).where(eq(schema.installedApps.appId, PROBE)).run();
    m.captureServiceImages.mockReset();
    m.captureServiceImages.mockResolvedValueOnce(baseline).mockResolvedValue(recreatedSameImage);
    m.verifyAppHealth.mockResolvedValue({ healthy: true, verdict: "healthy", reason: "ok", containers: [], checks: 3, elapsedMs: 5 });
    m.probeHttp.mockResolvedValue({ port: 0, ok: false });
    m.restoreServiceImages.mockResolvedValue([{ service: "web", restored: true }]);
  });

  function overrideWeb(): Record<string, unknown> {
    return (yaml.load(readFileSync(overridePath, "utf-8")) as typeof OVERRIDE).services.web as unknown as Record<string, unknown>;
  }

  it("applies catalog changes nobody edited, keeps Talome's and the user's edits, and reports 'updated'", async () => {
    recordCatalogBase(overridePath, yaml.dump(CATALOG_V1));

    const result = await updateApp(PROBE);

    expect(result).toMatchObject({ success: true, outcome: "updated" });
    const web = overrideWeb();
    expect(web.environment).toEqual({ A: "2", B: "mine", PROBE: "v2" });
    expect(web.healthcheck).toEqual(CATALOG_V2.services.web.healthcheck);
    expect(web.ports).toEqual(["18080:80"]); // Talome's remap, never synced
    expect(web.networks).toEqual(["talome"]);
    expect(result.warning).toContain("web.environment.B");
    expect(installedRow(PROBE)!.version).toBe("1.5.0");
    expect(readCatalogBase(overridePath)).toBe(yaml.dump(CATALOG_V2));
    expect(commands().some((c) => c.includes(`-f "${overridePath}" up -d`))).toBe(true);
  });

  it("a manual rollback puts the previous catalog base back", async () => {
    recordCatalogBase(overridePath, yaml.dump(CATALOG_V1));
    await updateApp(PROBE);
    const rolled = await rollbackUpdate(PROBE);
    expect(rolled.success).toBe(true);
    expect(overrideWeb().environment).toEqual({ A: "1", B: "mine" });
    expect(readCatalogBase(overridePath)).toBe(yaml.dump(CATALOG_V1));
  });

  it("an app installed before bases were recorded gets additive changes only", async () => {
    expect(existsSync(join(APP_DATA_DIR, PROBE, ".talome-catalog-base.yml"))).toBe(false);

    const result = await updateApp(PROBE);

    expect(result.outcome).toBe("updated");
    const web = overrideWeb();
    expect(web.environment).toEqual({ A: "1", B: "mine", PROBE: "v2" });
    expect(web.healthcheck).toEqual(OVERRIDE.services.web.healthcheck);
    expect(installedRow(PROBE)!.version).toBe("1.5.0");
    // Recorded now: the next update merges three-way — except the values that
    // differed without a base, which stay marked unknown.
    const base = yaml.load(readCatalogBase(overridePath)!) as Record<string, unknown>;
    expect(base.services).toEqual(CATALOG_V2.services);
    expect(base["x-talome-unknown"]).toEqual({ web: ["environment.A", "environment.B", "healthcheck"] });
  });

  it("values kept without a base keep being reported by later updates instead of turning into silent edits", async () => {
    await updateApp(PROBE);
    m.captureServiceImages.mockReset();
    m.captureServiceImages.mockResolvedValue(baseline);

    const again = await updateApp(PROBE);

    expect(again.outcome).toBe("no_change");
    expect(again.warning).toContain("web.environment.B");
    expect(again.warning).toContain("web.healthcheck");
    expect(again.warning).toContain("no record of whether it was edited");
    expect(overrideWeb().healthcheck).toEqual(OVERRIDE.services.web.healthcheck);
  });

  it("rolling back a legacy app's first update removes the base, so re-updating adds the catalog's additions again", async () => {
    await updateApp(PROBE);
    expect(overrideWeb().environment).toEqual({ A: "1", B: "mine", PROBE: "v2" });

    const rolled = await rollbackUpdate(PROBE);
    expect(rolled.success).toBe(true);
    expect(overrideWeb().environment).toEqual({ A: "1", B: "mine" });
    expect(readCatalogBase(overridePath)).toBeNull();

    m.captureServiceImages.mockReset();
    m.captureServiceImages.mockResolvedValueOnce(baseline).mockResolvedValue(recreatedSameImage);
    const again = await updateApp(PROBE);
    expect(again.outcome).toBe("updated");
    expect(overrideWeb().environment).toEqual({ A: "1", B: "mine", PROBE: "v2" });
  });

  it("two consecutive rollbacks restore the base each update replaced", async () => {
    recordCatalogBase(overridePath, yaml.dump(CATALOG_V1));
    await updateApp(PROBE);
    expect(readCatalogBase(overridePath)).toBe(yaml.dump(CATALOG_V2));

    const CATALOG_V3 = { services: { web: { ...CATALOG_V2.services.web, healthcheck: { test: ["CMD", "curl", "-f", "localhost"], interval: "5s" } } } };
    writeFileSync(catalogPath, yaml.dump(CATALOG_V3));
    db.update(schema.appCatalog).set({ version: "1.6.0" }).where(eq(schema.appCatalog.appId, PROBE)).run();
    const second = await updateApp(PROBE);
    expect(second.outcome).toBe("updated");
    expect(readCatalogBase(overridePath)).toBe(yaml.dump(CATALOG_V3));

    expect((await rollbackUpdate(PROBE)).success).toBe(true);
    expect(readCatalogBase(overridePath)).toBe(yaml.dump(CATALOG_V2));
    expect((await rollbackUpdate(PROBE)).success).toBe(true);
    expect(readCatalogBase(overridePath)).toBe(yaml.dump(CATALOG_V1));
    expect(overrideWeb().healthcheck).toEqual(CATALOG_V1.services.web.healthcheck);
  });

  it("fills a generated secret the catalog's env newly references, so it is not interpolated as empty", async () => {
    recordCatalogBase(overridePath, yaml.dump(CATALOG_V1));
    writeFileSync(join(catalogPath, "..", "manifest.json"), JSON.stringify({
      id: PROBE,
      env: [
        { key: "NEW_SECRET", secret: true, generate: "alnum32" },
        // Referenced before the update without a value: an old install that runs as it is.
        { key: "OLD_SECRET", secret: true, generate: "hex64" },
      ],
    }));
    writeFileSync(overridePath, yaml.dump({
      ...OVERRIDE,
      services: { web: { ...OVERRIDE.services.web, environment: { A: "1", B: "mine", OLD: "${OLD_SECRET}" } } },
    }));
    writeFileSync(catalogPath, yaml.dump({
      services: { web: { ...CATALOG_V2.services.web, environment: { ...CATALOG_V2.services.web.environment, OLD: "${OLD_SECRET}", JWT: "${NEW_SECRET}" } } },
    }));

    const result = await updateApp(PROBE);

    expect(result.outcome).toBe("updated");
    expect(overrideWeb().environment).toMatchObject({ JWT: "${NEW_SECRET}" });
    const up = m.run.mock.calls.find((c) => String(c[0]).includes(" up -d"))!;
    const upEnv = (up[1] as { env: Record<string, string> }).env;
    expect(upEnv.NEW_SECRET).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(upEnv.OLD_SECRET).toBeUndefined();
    const stored = JSON.parse(installedRow(PROBE)!.envConfig) as Record<string, string>;
    expect(stored.NEW_SECRET).toBe(upEnv.NEW_SECRET);
    expect(stored.OLD_SECRET).toBeUndefined();
    rmSync(join(catalogPath, "..", "manifest.json"));
  });

  it("merges list-style environments in their own format", () => {
    const override = { services: { web: { environment: ["A=1", "KEEP=me", "FLAG"] } } };
    const result = mergeCatalogConfig(
      override,
      yaml.dump({ services: { web: { environment: ["A=2", "KEEP=orig", "FLAG", "NEW=x"] } } }),
      yaml.dump({ services: { web: { environment: ["A=1", "KEEP=orig", "FLAG"] } } }),
    );
    expect(override.services.web.environment).toEqual(["A=2", "KEEP=me", "FLAG", "NEW=x"]);
    expect(result.kept).toEqual([]);
    expect(result.changes.map((c) => c.variable).sort()).toEqual(["A", "NEW"]);
  });

  describe("a no_change update records the catalog version only when the app provably follows it", () => {
    beforeEach(() => {
      // Nothing is recreated in these cases.
      m.captureServiceImages.mockReset();
      m.captureServiceImages.mockResolvedValue(baseline);
    });

    function expectNotRecorded(result: Awaited<ReturnType<typeof updateApp>>, reason: string): void {
      expect(result).toMatchObject({ success: true, outcome: "no_change" });
      expect(installedRow(PROBE)!.version).toBe("1.3.0");
      expect(result.warning).toContain("1.5.0 was not applied");
      expect(result.warning).toContain(reason);
      expect(result.warning).not.toContain("is recorded");
    }

    it("not when the catalog renamed (or added) the service carrying the change", async () => {
      const renamed = { services: { frontend: { ...OVERRIDE.services.web, environment: { A: "1", B: "mine", PROBE: "v2" } } } };
      writeFileSync(catalogPath, yaml.dump(renamed));
      recordCatalogBase(overridePath, yaml.dump(OVERRIDE));

      const result = await updateApp(PROBE);

      expectNotRecorded(result, "frontend");
      expect(readCatalogBase(overridePath)).toBe(yaml.dump(OVERRIDE));
    });

    it("not for a source whose configuration is never merged (an env-only Umbrel release)", async () => {
      db.update(schema.appCatalog).set({ source: "umbrel" }).where(eq(schema.appCatalog.appId, PROBE)).run();
      writeFileSync(catalogPath, yaml.dump({ services: { web: { ...OVERRIDE.services.web, environment: { A: "1", B: "mine", NEW: "x" } } } }));

      const result = await updateApp(PROBE);

      expectNotRecorded(result, "not applied to umbrel apps");
      expect(overrideWeb().environment).toEqual({ A: "1", B: "mine" });
    });

    it("not when the app's compose cannot be merged, and the catalog base is left alone", async () => {
      writeFileSync(catalogPath, yaml.dump(OVERRIDE));
      writeFileSync(overridePath, "services: [unclosed\n");

      const result = await updateApp(PROBE);

      expectNotRecorded(result, "could not be merged");
      expect(existsSync(join(APP_DATA_DIR, PROBE, ".talome-catalog-base.yml"))).toBe(false);
    });

    it("not when a catalog change was kept because the app's compose has its own value", async () => {
      recordCatalogBase(overridePath, yaml.dump({ services: { web: { ...OVERRIDE.services.web, environment: { A: "1", B: "orig" } } } }));
      writeFileSync(catalogPath, yaml.dump({ services: { web: { ...OVERRIDE.services.web, environment: { A: "1", B: "catalog" } } } }));

      const result = await updateApp(PROBE);

      expect(result).toMatchObject({ success: true, outcome: "no_change" });
      expect(installedRow(PROBE)!.version).toBe("1.3.0");
      expect(result.warning).toContain("web.environment.B");
    });
  });

  it("the REST route returns the outcome, so no_change is not shown as an update", async () => {
    // Same catalog as the override, same container: nothing to do.
    writeFileSync(catalogPath, yaml.dump(OVERRIDE));
    m.captureServiceImages.mockReset();
    m.captureServiceImages.mockResolvedValue(baseline);
    const app = new Hono().route("/api/apps", apps);

    const res = await app.request(`/api/apps/${STORE}/${PROBE}/update`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.outcome).toBe("no_change");
    expect(String(body.warning)).toContain("version 1.5.0 is recorded");
  });
});

describe("store detection of containers Talome does not track", () => {
  it("detects an app's orphaned containers by compose project label", async () => {
    db.delete(schema.installedApps).run();
    live = [container("db0000000001", "bkrs-db", projectLabels(APP, composePath))];
    const app = new Hono().route("/api/apps", apps);

    const res = await app.request(`/api/apps/${STORE}/${APP}`);
    expect(res.status).toBe(200);
    expect((await res.json() as { detectedRunning?: boolean }).detectedRunning).toBe(true);
  });
});
