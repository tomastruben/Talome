import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// Per-file SQLite database and HOME (compose backups go to $HOME/.talome) —
// must be set before the modules are imported.
vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? "/tmp").replace(/\/$/, "");
  process.env.DATABASE_PATH = `${tmp}/talome-compose-tools-lock-${process.pid}-${Date.now()}.db`;
  process.env.HOME = `${tmp}/talome-compose-tools-home-${process.pid}-${Date.now()}`;
});

const m = vi.hoisted(() => ({
  run: vi.fn(),
  captureServiceImages: vi.fn(),
  verifyAppHealth: vi.fn(),
  restoreServiceImages: vi.fn(),
}));

vi.mock("../stores/compose-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stores/compose-exec.js")>();
  return {
    ...actual,
    run: m.run,
    buildEnv: (_appId: string, env: Record<string, string> = {}) => ({ ...env }),
    writeAppDotEnv: vi.fn(),
    discoverContainers: vi.fn(async () => ["c0ffee000002"]),
    pinImageDigest: vi.fn(),
  };
});
vi.mock("../ops/docker-probe.js", () => ({
  captureServiceImages: m.captureServiceImages,
  verifyAppHealth: m.verifyAppHealth,
  restoreServiceImages: m.restoreServiceImages,
  probeHttp: vi.fn(async () => ({ port: 8989, ok: true, status: 200 })),
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
vi.mock("../docker/client.js", () => ({
  listContainers: vi.fn(async () => []),
  listNetworks: vi.fn(async () => []),
  removeNetwork: vi.fn(),
  connectContainerToNetwork: vi.fn(),
  docker: {},
}));
vi.mock("../docker/talome-network.js", () => ({ ensureTalomeNetwork: vi.fn(async () => {}), injectTalomeNetwork: vi.fn() }));
vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));
vi.mock("../stores/compose-errors.js", () => ({ recordInstallError: vi.fn() }));
vi.mock("../stores/lifecycle-hooks.js", () => ({ executeHook: vi.fn(async () => {}) }));
vi.mock("../automation/engine.js", () => ({ fireTrigger: vi.fn(async () => []) }));
vi.mock("../proxy/caddy.js", () => ({ autoRegisterProxyRoute: vi.fn(), removeProxyRoutesForApp: vi.fn() }));
vi.mock("../app-registry/auto-configure.js", () => ({ autoConfigureApp: vi.fn() }));
vi.mock("../app-registry/index.js", () => ({ getAppCapabilities: vi.fn(() => null) }));

import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { updateApp, rollbackUpdate } from "../stores/lifecycle.js";
import { listAppOperations, withAppOperation, __resetActiveOperationsForTests } from "../ops/operations.js";
import { setAppEnvTool, changePortMappingTool, upgradeAppImageTool } from "../ai/tools/compose-tools.js";
import { apps as appsRoute } from "../routes/apps.js";
import type { ServiceImageState } from "../ops/docker-probe.js";

const APP_ID = "sonarr";
const STORE_ID = "test-store";
const OLD_COMPOSE = "services:\n  sonarr:\n    image: linuxserver/sonarr:4.0.0\n    ports:\n      - 8989:8989\n    environment:\n      - TZ=UTC\n";
const CATALOG_COMPOSE = "services:\n  sonarr:\n    image: linuxserver/sonarr:4.1.0\n    ports:\n      - 8989:8989\n";

const BASELINE: ServiceImageState[] = [{
  service: "sonarr",
  containerId: "c0ffee000001",
  containerName: "sonarr",
  imageRef: "linuxserver/sonarr:4.0.0",
  imageId: "sha256:" + "a".repeat(64),
  repoDigest: null,
  status: "running",
}];
const AFTER: ServiceImageState[] = [{ ...BASELINE[0], containerId: "c0ffee000002", imageRef: "linuxserver/sonarr:4.1.0", imageId: "sha256:" + "e".repeat(64) }];
const healthy = { healthy: true, verdict: "healthy", reason: "ok", containers: [], checks: 3, elapsedMs: 10 };

let overridePath = "";

type ToolResult = { success: boolean; error?: string; conflict?: boolean; message?: string };
const callOpts = { toolCallId: "t1", messages: [] };

function sonarrService(): { image: string; environment: string[]; ports: string[] } {
  const doc = parseYaml(readFileSync(overridePath, "utf-8")) as { services: Record<string, { image: string; environment: string[]; ports: string[] }> };
  return doc.services.sonarr;
}

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetActiveOperationsForTests();
  const dir = mkdtempSync(join(tmpdir(), "talome-compose-tools-lock-"));
  overridePath = join(dir, "docker-compose.yml");
  const catalogPath = join(dir, "catalog.yml");
  writeFileSync(overridePath, OLD_COMPOSE);
  writeFileSync(catalogPath, CATALOG_COMPOSE);

  db.delete(schema.appOperationEvents).run();
  db.delete(schema.appOperations).run();
  db.delete(schema.updateSnapshots).run();
  db.delete(schema.installedApps).run();
  db.delete(schema.appCatalog).run();
  db.delete(schema.storeSources).run();
  db.insert(schema.storeSources).values({ id: STORE_ID, name: "Test", type: "talome" }).run();
  db.insert(schema.appCatalog).values({
    appId: APP_ID, storeSourceId: STORE_ID, name: "Sonarr", version: "4.1.0", source: "talome", composePath: catalogPath, webPort: 8989,
  }).run();
  const now = new Date().toISOString();
  db.insert(schema.installedApps).values({
    appId: APP_ID, storeSourceId: STORE_ID, status: "running", envConfig: "{}", containerIds: "[]",
    version: "4.0.0", overrideComposePath: overridePath, installedAt: now, updatedAt: now,
  }).run();

  m.run.mockResolvedValue({ stdout: "", stderr: "" });
  m.captureServiceImages.mockReset();
  m.captureServiceImages.mockResolvedValueOnce(BASELINE).mockResolvedValue(AFTER);
  m.verifyAppHealth.mockResolvedValue(healthy);
  m.restoreServiceImages.mockResolvedValue([{ service: "sonarr", restored: true, method: "tag" }]);
});

describe("AI compose edits run under the per-app operation lock", () => {
  it("refuses to edit while an update runs on the app, instead of being silently reverted by its rollback", async () => {
    let release!: () => void;
    const update = withAppOperation(APP_ID, "update", "system", () => new Promise<{ success: boolean }>((r) => {
      release = () => r({ success: true });
    }));
    await new Promise((r) => setTimeout(r, 5));

    const result = await setAppEnvTool.execute!({ appId: APP_ID, serviceName: "sonarr", key: "PUID", value: "1000" }, callOpts) as ToolResult;

    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.error).toContain("update operation");
    expect(readFileSync(overridePath, "utf-8")).toBe(OLD_COMPOSE);

    release();
    await update;
  });

  it("journals the edit as a configure operation", async () => {
    const result = await changePortMappingTool.execute!({ appId: APP_ID, serviceName: "sonarr", containerPort: 8989, newHostPort: 18989 }, callOpts) as ToolResult;
    expect(result.success).toBe(true);
    expect(sonarrService().ports).toEqual(["18989:8989"]);
    const ops = listAppOperations(APP_ID);
    expect(ops.map((o) => [o.kind, o.status])).toEqual([["configure", "succeeded"]]);
  });

  it("an env edit made after an update is kept when that update is rolled back", async () => {
    expect((await updateApp(APP_ID)).outcome).toBe("updated");
    expect(sonarrService().image).toBe("linuxserver/sonarr:4.1.0");

    const edit = await setAppEnvTool.execute!({ appId: APP_ID, serviceName: "sonarr", key: "PUID", value: "1000" }, callOpts) as ToolResult;
    expect(edit.success).toBe(true);
    expect(edit.message).not.toContain("would not keep this change");

    const rolled = await rollbackUpdate(APP_ID);
    expect(rolled.success).toBe(true);
    const service = sonarrService();
    expect(service.image).toBe("linuxserver/sonarr:4.0.0");
    expect(service.environment).toEqual(["TZ=UTC", "PUID=1000"]);
  });

  it("an image pin is not carried into the snapshot: rolling the update back restores the previous version", async () => {
    await updateApp(APP_ID);
    const pin = await upgradeAppImageTool.execute!({ appId: APP_ID, serviceName: "sonarr", newImageTag: "4.1.2" }, callOpts) as ToolResult;
    expect(pin.success).toBe(true);
    expect(sonarrService().image).toBe("linuxserver/sonarr:4.1.2");

    await rollbackUpdate(APP_ID);
    expect(sonarrService().image).toBe("linuxserver/sonarr:4.0.0");
  });

  it("says when an earlier version's compose cannot take the edit", async () => {
    await updateApp(APP_ID);
    // The pre-update compose has no port 9898, so a rollback cannot keep this change.
    writeFileSync(overridePath, "services:\n  sonarr:\n    image: linuxserver/sonarr:4.1.0\n    ports:\n      - 8989:8989\n      - 9898:9898\n");

    const edit = await changePortMappingTool.execute!({ appId: APP_ID, serviceName: "sonarr", containerPort: 9898, newHostPort: 19898 }, callOpts) as ToolResult;
    expect(edit.success).toBe(true);
    expect(edit.message).toContain("would not keep this change");
    const installed = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, APP_ID)).get();
    expect(installed?.status).toBe("running");
  });

  it("a port change from the dashboard is also kept when an earlier update is rolled back", async () => {
    await updateApp(APP_ID);
    const res = await appsRoute.request(`/${STORE_ID}/${APP_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ports: { "8989": 18989 } }),
    });
    expect(res.status).toBe(200);
    expect(sonarrService().ports).toEqual(["18989:8989"]);

    await rollbackUpdate(APP_ID);
    expect(sonarrService().image).toBe("linuxserver/sonarr:4.0.0");
    expect(sonarrService().ports).toEqual(["18989:8989"]);
  });
});
