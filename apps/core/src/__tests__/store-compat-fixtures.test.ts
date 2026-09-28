/**
 * Umbrel compatibility suite: every fixture app must parse and, after the
 * Umbrel 2.0 install mapping, produce a structurally valid compose document.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { scanUmbrelStore, umbrelAdapter, type UmbrelStoreScanEntry, type UmbrelAppManifest } from "../stores/adapters/umbrel-adapter.js";
import {
  applyUmbrelV2Plan,
  isTalomeProvidedUmbrelVar,
  planUmbrelV2Install,
  stripUmbrelProxy,
  validateTransformedCompose,
  type UmbrelInstallOptions,
  type UmbrelV2Context,
  type UmbrelV2Plan,
} from "../stores/umbrel-v2.js";
import { buildUmbrelCompatReport } from "../stores/adapters/umbrel-compat-report.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "umbrel-apps");

const context = (appId: string, hasDri = true): UmbrelV2Context => ({
  appId,
  paths: {
    appDataDir: `/talome/app-data/${appId}`,
    appDataParent: "/talome/app-data",
    mediaRoot: "/mnt/media",
    downloadsRoot: "/mnt/downloads",
  },
  installedApps: [],
  hasDri,
});

let scanned: UmbrelStoreScanEntry[] = [];
const byId = new Map<string, UmbrelAppManifest>();

beforeAll(async () => {
  scanned = await scanUmbrelStore(FIXTURES, "fixtures");
  for (const { result } of scanned) if (result.ok) byId.set(result.manifest.id, result.manifest);
});

function transform(appId: string, options: UmbrelInstallOptions = {}, hasDri = true) {
  const manifest = byId.get(appId);
  if (!manifest) throw new Error(`fixture ${appId} did not parse`);
  const raw = yaml.load(readFileSync(join(FIXTURES, appId, "docker-compose.yml"), "utf-8")) as Record<string, unknown>;
  const base = stripUmbrelProxy(raw);
  const plan: UmbrelV2Plan = planUmbrelV2Install(manifest.umbrelMeta, base, options, context(appId, hasDri));
  const { compose } = applyUmbrelV2Plan(base, plan);
  // Round-trip through YAML exactly like the install path writes it.
  const written = yaml.load(yaml.dump(compose, { lineWidth: -1 })) as Record<string, unknown>;
  const issues = validateTransformedCompose(written, (v) => isTalomeProvidedUmbrelVar(v) || v in plan.interpolationEnv);
  return { manifest, plan, compose: written, issues };
}

type Svc = { image?: string; volumes?: string[]; environment?: unknown; devices?: string[]; network_mode?: string };
const services = (doc: Record<string, unknown>) => doc.services as Record<string, Svc>;

const INSTALLABLE = ["immich", "jellyfin", "nextcloud", "home-assistant", "sonarr", "photo-vault", "webui-tuner", "ollama"];

describe("Umbrel compatibility suite (fixtures)", () => {
  it("parses every fixture app", () => {
    expect(scanned.map((s) => s.entry).sort()).toEqual([...INSTALLABLE, "onion-board"].sort());
    expect(scanned.every((s) => s.result.ok)).toBe(true);
  });

  it("sync and async parsers agree", async () => {
    const sync = umbrelAdapter.parse(FIXTURES, "fixtures");
    const asyncResult = await umbrelAdapter.parseAsync!(FIXTURES, "fixtures");
    expect(asyncResult).toEqual(sync);
  });

  it.each(INSTALLABLE)("%s → valid compose after the install mapping", (appId) => {
    const { plan, compose, issues } = transform(appId);
    expect(plan.blockers).toEqual([]);
    expect(issues).toEqual([]);
    expect(Object.keys(services(compose))).not.toContain("app_proxy");
    expect(JSON.stringify(compose)).not.toContain("UMBREL_ROOT");
  });

  it("immich keeps its multi-service stack and exposes backupIgnore", () => {
    const { manifest, compose, plan } = transform("immich");
    expect(Object.keys(services(compose)).sort()).toEqual(["machine-learning", "postgres", "redis", "server"]);
    expect(manifest.image).toBe("ghcr.io/immich-app/immich-server:v1.120.2");
    expect(manifest.webPort).toBe(2283);
    expect(plan.backupIgnore).toEqual(["data/model-cache/*"]);
    expect(manifest.umbrelMeta?.submission).toBe("https://github.com/getumbrel/umbrel-apps/pull/1");
  });

  it("jellyfin maps Umbrel storage paths onto Talome's media folders", () => {
    const { compose } = transform("jellyfin");
    expect(services(compose).server.volumes).toEqual([
      "${APP_DATA_DIR}/data/config:/config",
      "/mnt/downloads:/downloads",
      "/mnt/media:/media",
    ]);
  });

  it("nextcloud keeps its interpolated platform secrets", () => {
    const { manifest, compose } = transform("nextcloud");
    expect(manifest.umbrelMeta?.deterministicPassword).toBe(true);
    expect(JSON.stringify(services(compose).web.environment)).toContain("${APP_PASSWORD}");
  });

  it("home-assistant keeps host networking and privileges", () => {
    const { manifest, compose } = transform("home-assistant");
    expect(services(compose).server.network_mode).toBe("host");
    expect(manifest.permissions).toMatchObject({ privileged: true, networkMode: "host" });
  });

  it("sonarr reports its missing dependency and maps downloads", () => {
    const { plan, compose } = transform("sonarr");
    expect(plan.missingDependencies).toEqual(["transmission"]);
    expect(services(compose).server.volumes).toContain("/mnt/downloads:/downloads");
  });

  it("folderAccess app binds chosen folders (readOnly honoured) and the data root", () => {
    const { manifest, compose, plan, issues } = transform("photo-vault", {
      folders: { photos: "/Volumes/Photos", import: "/srv/inbox" },
      dataRoot: "/mnt/ssd/photo-vault",
    });
    expect(issues).toEqual([]);
    expect(manifest.umbrelMeta?.folderAccess?.map((f) => f.id)).toEqual(["photos", "import"]);
    expect(manifest.umbrelMeta?.unknownFields).toEqual({ "x-future-flag": "shiny" });
    expect(manifest.umbrelMeta?.warnings?.[0]).toMatch(/folderAccess\[2\] ignored/);
    expect(services(compose).web.volumes).toEqual([
      "/mnt/ssd/photo-vault/storage:/photoprism/storage",
      "/Volumes/Photos:/photoprism/originals",
      "/srv/inbox:/photoprism/import:ro",
    ]);
    expect(plan.dataRoot).toEqual({ declared: true, hostPath: "/mnt/ssd/photo-vault" });
  });

  it("folderAccess app defaults to the mapped Umbrel folder", () => {
    const { plan } = transform("photo-vault");
    expect(plan.folders.find((f) => f.id === "photos")?.source).toBe("/mnt/media/Photos");
  });

  it("environment app applies validated choices and resolves required defaults", () => {
    const { manifest, compose, plan } = transform("webui-tuner", { environment: { LOG_LEVEL: "debug", WORKERS: "4" } });
    expect(manifest.umbrelMeta?.environment?.map((e) => e.name)).toEqual(["LOG_LEVEL", "MODEL_HOST", "WORKERS"]);
    expect(manifest.umbrelMeta?.warnings?.join(" ")).toMatch(/installSize ignored/);
    expect(services(compose).web.environment).toMatchObject({ LOG_LEVEL: "debug", WORKERS: "4", MODEL_HOST: "http://ollama_ollama_1:11434" });
    expect(plan.interpolationEnv.MODEL_HOST).toBe("http://ollama_ollama_1:11434");

    const rejected = transform("webui-tuner", { environment: { WORKERS: "3" } });
    expect(rejected.plan.blockers[0]).toMatch(/not an allowed value for WORKERS/);
  });

  it("torOnly app is marked unsupported with a clear reason", () => {
    const { plan } = transform("onion-board");
    expect(plan.supported).toBe(false);
    expect(plan.unsupportedReason).toMatch(/Tor/);
  });

  it("GPU app gets /dev/dri when present, and a warning otherwise", () => {
    const withGpu = transform("ollama");
    expect(services(withGpu.compose).ollama.devices).toEqual(["/dev/dri:/dev/dri"]);
    expect(withGpu.manifest.permissions?.gpu).toBe(true);
    expect(withGpu.manifest.umbrelMeta?.implements).toEqual(["llm-runtime"]);

    const noGpu = transform("ollama", {}, false);
    expect(services(noGpu.compose).ollama.devices).toBeUndefined();
    expect(noGpu.plan.warnings.join(" ")).toMatch(/GPU/);
    expect(noGpu.issues).toEqual([]);
  });

  it("compat report summarises the fixture catalog", async () => {
    const report = await buildUmbrelCompatReport(FIXTURES);
    expect(report).toMatchObject({
      appDirs: 9,
      parsed: 9,
      parseFailures: 0,
      installable: 8,
      unsupported: 1,
      invalidCompose: 0,
    });
    expect(report.features.torOnly).toBe(1);
    expect(report.features.folderAccess).toBe(1);
    expect(report.features.environment).toBe(1);
  });
});
