import { describe, it, expect } from "vitest";
import {
  applyUmbrelV2Plan,
  findRequiredComposeVars,
  GPU_UNAVAILABLE_WARNING,
  mapUmbrelRootSource,
  normalizeBackupIgnore,
  planUmbrelV2Install,
  resolveUmbrelDependencies,
  splitVolumeSpec,
  stripUmbrelProxy,
  validateHostFolder,
  validateTransformedCompose,
  type UmbrelV2Context,
  type UmbrelV2Meta,
} from "../stores/umbrel-v2.js";

function ctx(overrides: Partial<UmbrelV2Context> = {}, paths: Partial<UmbrelV2Context["paths"]> = {}): UmbrelV2Context {
  return {
    appId: "demo",
    paths: {
      appDataDir: "/talome/app-data/demo",
      appDataParent: "/talome/app-data",
      mediaRoot: "/mnt/media",
      downloadsRoot: "/mnt/downloads",
      ...paths,
    },
    installedApps: [],
    hasDri: true,
    ...overrides,
  };
}

const compose = () => ({
  services: {
    app_proxy: { environment: { APP_HOST: "demo_web_1", APP_PORT: 80 } },
    web: {
      image: "demo/web:1.0",
      environment: { LOG_LEVEL: "info" },
      volumes: ["${APP_DATA_DIR}/data/config:/config", "${UMBREL_ROOT}/home/Photos:/photos"],
    },
    db: { image: "postgres:16", volumes: ["${APP_DATA_DIR}/data/db:/var/lib/postgresql/data"] },
  },
});

type Svc = { volumes?: unknown[]; environment?: unknown; devices?: string[] };
const svc = (doc: Record<string, unknown>, name: string) => (doc.services as Record<string, Svc>)[name];

describe("splitVolumeSpec", () => {
  it("splits on colons outside ${…}", () => {
    expect(splitVolumeSpec("${APP_DATA_DIR:-/x}/data:/data:ro")).toEqual(["${APP_DATA_DIR:-/x}/data", "/data", "ro"]);
    expect(splitVolumeSpec("/a:/b")).toEqual(["/a", "/b"]);
    expect(splitVolumeSpec("named")).toEqual(["named"]);
  });
});

describe("mapUmbrelRootSource", () => {
  const paths = ctx().paths;

  it("maps Umbrel downloads (legacy and new) to downloads_root", () => {
    expect(mapUmbrelRootSource("${UMBREL_ROOT}/data/storage/downloads", paths)?.hostPath).toBe("/mnt/downloads");
    expect(mapUmbrelRootSource("${UMBREL_ROOT}/home/Downloads/tv", paths)?.hostPath).toBe("/mnt/downloads/tv");
    expect(mapUmbrelRootSource("$UMBREL_ROOT/home/Downloads", paths)?.kind).toBe("downloads");
  });

  it("maps the Umbrel home folder to media_root", () => {
    expect(mapUmbrelRootSource("${UMBREL_ROOT}/home", paths)?.hostPath).toBe("/mnt/media");
    expect(mapUmbrelRootSource("${UMBREL_ROOT}/home/Photos", paths)?.hostPath).toBe("/mnt/media/Photos");
  });

  it("falls back inside the app data dir when no folder is configured", () => {
    const bare = ctx({}, { mediaRoot: undefined, downloadsRoot: undefined }).paths;
    expect(mapUmbrelRootSource("${UMBREL_ROOT}/home/Downloads", bare)).toEqual({
      hostPath: "/talome/app-data/demo/downloads",
      kind: "downloads",
      fallback: true,
    });
    expect(mapUmbrelRootSource("${UMBREL_ROOT}/home", bare)?.hostPath).toBe("/talome/app-data/demo/home");
  });

  it("maps another app's data dir and never escapes via ..", () => {
    expect(mapUmbrelRootSource("${UMBREL_ROOT}/app-data/bitcoin/data", paths)?.hostPath).toBe("/talome/app-data/bitcoin/data");
    expect(mapUmbrelRootSource("${UMBREL_ROOT}/../../etc", paths)?.hostPath).toBe("/talome/app-data/demo/umbrel-root/etc");
    expect(mapUmbrelRootSource("${UMBREL_ROOT}/home/../../../etc", paths)?.hostPath).toBe("/talome/app-data/demo/umbrel-root/etc");
  });

  it("ignores non-Umbrel sources", () => {
    expect(mapUmbrelRootSource("${APP_DATA_DIR}/data", paths)).toBeNull();
    expect(mapUmbrelRootSource("${UMBREL_ROOT_X}/data", paths)).toBeNull();
  });
});

describe("validateHostFolder", () => {
  it("accepts ordinary absolute folders", () => {
    expect(validateHostFolder("/mnt/media/Photos")).toBeNull();
  });
  it("rejects relative, traversal and system paths", () => {
    expect(validateHostFolder("media")).toMatch(/absolute/);
    expect(validateHostFolder("/mnt/../etc")).toMatch(/\.\./);
    expect(validateHostFolder("/etc")).toMatch(/protected/);
    expect(validateHostFolder("/")).toMatch(/protected/);
    expect(validateHostFolder("/var/run/docker.sock")).toBeTruthy();
  });
});

describe("planUmbrelV2Install — folderAccess", () => {
  const meta: UmbrelV2Meta = {
    folderAccess: [
      { id: "photos", name: "Photos", mounts: [{ service: "web", targetPath: "/photos" }] },
      { id: "import", name: "Import", mounts: [{ service: "web", targetPath: "/import", readOnly: true }] },
      { id: "movies", name: "Movies", mounts: [{ service: "web", targetPath: "/movies/" }] },
    ],
  };

  it("defaults from the compose mount (mapped) or Talome's media folders", () => {
    const plan = planUmbrelV2Install(meta, compose(), {}, ctx());
    expect(plan.blockers).toEqual([]);
    const byId = Object.fromEntries(plan.folders.map((f) => [f.id, f]));
    expect(byId.photos.source).toBe("/mnt/media/Photos");
    expect(byId.movies.source).toBe("/mnt/media");
    // "import" has no compose mount and no matching media keyword → app-data fallback
    expect(byId.import.source).toBe("/talome/app-data/demo/folders/import");
    expect(plan.ensureDirs).toContain("/talome/app-data/demo/folders/import");
    expect(plan.warnings.some((w) => w.includes('Folder "Import"'))).toBe(true);
  });

  it("honours user overrides and readOnly, and binds them into the compose", () => {
    const plan = planUmbrelV2Install(meta, compose(), { folders: { photos: "/Volumes/Pictures/", import: "/srv/inbox" } }, ctx());
    expect(plan.blockers).toEqual([]);
    const { compose: out, changed } = applyUmbrelV2Plan(compose(), plan);
    expect(changed).toBe(true);
    const volumes = svc(out, "web").volumes;
    expect(volumes).toContain("/Volumes/Pictures:/photos");
    expect(volumes).toContain("/srv/inbox:/import:ro");
    expect(volumes).toContain("/mnt/media:/movies");
    // the untouched config mount stays as it was
    expect(volumes).toContain("${APP_DATA_DIR}/data/config:/config");
  });

  it("blocks unsafe folder choices and warns about unknown ids", () => {
    const plan = planUmbrelV2Install(meta, compose(), { folders: { photos: "/etc", nope: "/x" } }, ctx());
    expect(plan.blockers.join(" ")).toMatch(/protected system folder/);
    expect(plan.warnings.join(" ")).toMatch(/Ignoring folder selection "nope"/);
  });

  it("skips folders pointing at unknown services or ambiguous mounts", () => {
    const plan = planUmbrelV2Install(
      {
        folderAccess: [
          { id: "a", name: "A", mounts: [{ service: "ghost", targetPath: "/x" }] },
          { id: "b", name: "B", mounts: [{ targetPath: "/y" }] },
        ],
      },
      compose(),
      {},
      ctx(),
    );
    expect(plan.folders).toEqual([]);
    expect(plan.warnings.filter((w) => w.includes("skipped"))).toHaveLength(2);
  });

  it("uses the only service when a mount has no service", () => {
    const single = { services: { app: { image: "x:1" } } };
    const plan = planUmbrelV2Install({ folderAccess: [{ id: "dl", name: "Downloads", mounts: [{ targetPath: "/downloads" }] }] }, single, {}, ctx());
    expect(plan.folders[0].mounts[0].service).toBe("app");
    expect(plan.folders[0].source).toBe("/mnt/downloads");
    const { compose: out } = applyUmbrelV2Plan(single, plan);
    expect(svc(out, "app").volumes).toEqual(["/mnt/downloads:/downloads"]);
  });
});

describe("planUmbrelV2Install — environment", () => {
  const meta: UmbrelV2Meta = {
    environment: [
      { name: "LOG_LEVEL", services: ["web"], default: "info", options: ["debug", "info"] },
      { name: "MODEL_HOST", services: ["web"], default: "http://ollama:11434" },
      { name: "GHOST", services: ["nope"] },
    ],
  };

  it("applies user values to the listed services and validates options", () => {
    const plan = planUmbrelV2Install(meta, compose(), { environment: { LOG_LEVEL: "debug" } }, ctx());
    expect(plan.blockers).toEqual([]);
    expect(plan.serviceEnv.web).toEqual({ LOG_LEVEL: "debug" });
    const { compose: out } = applyUmbrelV2Plan(compose(), plan);
    expect(svc(out, "web").environment).toEqual({ LOG_LEVEL: "debug" });
    expect(plan.warnings.join(" ")).toMatch(/GHOST/);
  });

  it("rejects values outside the allowed options", () => {
    const plan = planUmbrelV2Install(meta, compose(), { environment: { LOG_LEVEL: "verbose" } }, ctx());
    expect(plan.blockers.join(" ")).toMatch(/not an allowed value for LOG_LEVEL/);
  });

  it("keeps defaults as placeholders unless the compose needs the variable", () => {
    const plain = planUmbrelV2Install(meta, compose(), {}, ctx());
    expect(plain.serviceEnv).toEqual({});
    expect(plain.environment.find((e) => e.name === "LOG_LEVEL")).toMatchObject({ default: "info", origin: "none" });

    const interpolating = compose();
    (interpolating.services.web.environment as Record<string, string>).MODEL_URL = "${MODEL_HOST}";
    const plan = planUmbrelV2Install(meta, interpolating, {}, ctx());
    expect(plan.interpolationEnv).toEqual({ MODEL_HOST: "http://ollama:11434" });
    expect(plan.environment.find((e) => e.name === "MODEL_HOST")?.origin).toBe("default");
  });

  it("updates list-style environment entries in place", () => {
    const doc = { services: { web: { image: "x:1", environment: ["LOG_LEVEL=info", "OTHER=1"] } } };
    const plan = planUmbrelV2Install(meta, doc, { environment: { LOG_LEVEL: "debug" } }, ctx());
    const { compose: out } = applyUmbrelV2Plan(doc, plan);
    expect(svc(out, "web").environment).toEqual(["OTHER=1", "LOG_LEVEL=debug"]);
  });
});

describe("planUmbrelV2Install — GPU, torOnly, requiresHttps, dataRoot, backupIgnore", () => {
  it("maps GPU permission to /dev/dri when present", () => {
    const plan = planUmbrelV2Install({ permissions: ["GPU"] }, compose(), {}, ctx({ hasDri: true }));
    expect(plan.gpu).toEqual({ requested: true, devices: ["/dev/dri:/dev/dri"] });
    const { compose: out } = applyUmbrelV2Plan(compose(), plan);
    expect(svc(out, "web").devices).toEqual(["/dev/dri:/dev/dri"]);
    expect(svc(out, "db").devices).toEqual(["/dev/dri:/dev/dri"]);
    expect(svc(out, "app_proxy").devices).toBeUndefined();
  });

  it("does not duplicate an existing /dev/dri mapping", () => {
    const doc = { services: { web: { image: "x:1", devices: ["/dev/dri:/dev/dri"] } } };
    const plan = planUmbrelV2Install({ permissions: ["gpu"] }, doc, {}, ctx());
    expect(svc(applyUmbrelV2Plan(doc, plan).compose, "web").devices).toEqual(["/dev/dri:/dev/dri"]);
  });

  it("skips GPU with a warning when /dev/dri is absent", () => {
    const plan = planUmbrelV2Install({ permissions: ["GPU"] }, compose(), {}, ctx({ hasDri: false }));
    expect(plan.gpu.devices).toEqual([]);
    expect(plan.warnings).toContain(GPU_UNAVAILABLE_WARNING);
    expect(plan.blockers).toEqual([]);
  });

  it("marks torOnly apps unsupported with a clear reason", () => {
    const plan = planUmbrelV2Install({ torOnly: true }, compose(), {}, ctx());
    expect(plan.supported).toBe(false);
    expect(plan.unsupportedReason).toMatch(/Tor-only/);
    expect(plan.blockers).toHaveLength(1);
  });

  it("flags requiresHttps for the proxy layer", () => {
    const plan = planUmbrelV2Install({ requiresHttps: true }, compose(), {}, ctx());
    expect(plan.requiresHttps).toBe(true);
    expect(plan.blockers).toEqual([]);
  });

  it("redirects ${APP_DATA_DIR}/data to a chosen data root when declared", () => {
    const plan = planUmbrelV2Install({ storage: { dataRoot: "data" } }, compose(), { dataRoot: "/mnt/ssd/demo" }, ctx());
    expect(plan.dataRoot).toEqual({ declared: true, hostPath: "/mnt/ssd/demo" });
    const { compose: out } = applyUmbrelV2Plan(compose(), plan);
    expect(svc(out, "web").volumes).toContain("/mnt/ssd/demo/config:/config");
    expect(svc(out, "db").volumes).toEqual(["/mnt/ssd/demo/db:/var/lib/postgresql/data"]);
  });

  it("ignores a data root choice when the manifest does not declare one", () => {
    const plan = planUmbrelV2Install({}, compose(), { dataRoot: "/mnt/ssd/demo" }, ctx());
    expect(plan.dataRoot.hostPath).toBeNull();
    expect(plan.warnings.join(" ")).toMatch(/does not declare a movable data root/);
    expect(svc(applyUmbrelV2Plan(compose(), plan).compose, "db").volumes).toEqual(["${APP_DATA_DIR}/data/db:/var/lib/postgresql/data"]);
  });

  it("normalises backupIgnore patterns", () => {
    expect(normalizeBackupIgnore(["data/cache/*", "./logs", "/etc/passwd", "../x", "data/cache/*", ""])).toEqual(["data/cache/*", "logs"]);
    expect(planUmbrelV2Install({ backupIgnore: ["tmp/*"] }, compose(), {}, ctx()).backupIgnore).toEqual(["tmp/*"]);
  });

  it("rewrites ${UMBREL_ROOT} mounts even without v2 metadata", () => {
    const plan = planUmbrelV2Install(null, compose(), null, ctx());
    const { compose: out } = applyUmbrelV2Plan(compose(), plan);
    expect(svc(out, "web").volumes).toContain("/mnt/media/Photos:/photos");
  });

  it("does not mutate its input", () => {
    const input = compose();
    const snapshot = JSON.stringify(input);
    const plan = planUmbrelV2Install({ permissions: ["GPU"] }, input, {}, ctx());
    applyUmbrelV2Plan(input, plan);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("resolveUmbrelDependencies — implements", () => {
  const installed = [
    { appId: "bitcoin-knots", implements: ["bitcoin"] },
    { appId: "lnd" },
    { appId: "core-lightning", implements: ["lightning"] },
    { appId: "lightning-alt", implements: ["lightning"] },
  ];

  it("uses the same-id app, or an installed alternative that implements the dependency", () => {
    const result = resolveUmbrelDependencies(["lnd", "bitcoin"], installed);
    expect(result.missing).toEqual([]);
    expect(result.resolutions).toEqual([
      { dependency: "lnd", provider: "lnd", viaImplements: false },
      { dependency: "bitcoin", provider: "bitcoin-knots", viaImplements: true },
    ]);
  });

  it("reports missing dependencies", () => {
    const result = resolveUmbrelDependencies(["electrs"], installed);
    expect(result.missing).toEqual(["electrs"]);
  });

  it("picks deterministically among several providers and warns", () => {
    const result = resolveUmbrelDependencies(["lightning"], installed);
    expect(result.resolutions[0].provider).toBe("core-lightning");
    expect(result.warnings[0]).toMatch(/Several installed apps provide "lightning"/);
  });

  it("validates explicit provider selections", () => {
    expect(resolveUmbrelDependencies(["lightning"], installed, { lightning: "lightning-alt" }).resolutions[0].provider).toBe("lightning-alt");
    expect(resolveUmbrelDependencies(["bitcoin"], installed, { bitcoin: "lnd" }).blockers[0]).toMatch(/does not implement/);
    expect(resolveUmbrelDependencies(["bitcoin"], installed, { bitcoin: "ghost" }).blockers[0]).toMatch(/not installed/);
  });
});

describe("compose validation helpers", () => {
  it("finds required braced variables only", () => {
    const vars = findRequiredComposeVars({ a: "${A}", b: "${B:-x}", c: "$C", d: "$${D}", e: "${E:?err}" });
    expect(vars.sort()).toEqual(["A", "E"]);
  });

  it("validates a transformed compose", () => {
    const plan = planUmbrelV2Install(null, stripUmbrelProxy(compose()), null, ctx());
    const { compose: out } = applyUmbrelV2Plan(stripUmbrelProxy(compose()), plan);
    expect(validateTransformedCompose(out)).toEqual([]);
  });

  it("reports leftovers and unresolved variables", () => {
    const issues = validateTransformedCompose({
      services: {
        app_proxy: { image: "proxy" },
        web: { volumes: ["${UMBREL_ROOT}/x:/x", "undeclared:/y"], environment: { X: "${APP_BITCOIN_NODE_IP}" } },
      },
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        "app_proxy sidecar still present",
        'service "web" has no image or build',
        'service "web" still references UMBREL_ROOT',
        'service "web" uses undeclared named volume "undeclared"',
        "unresolved variables: APP_BITCOIN_NODE_IP, UMBREL_ROOT",
      ]),
    );
  });
});
