import { describe, it, expect } from "vitest";
import { parseUmbrelManifest, buildUmbrelApp } from "../stores/adapters/umbrel-adapter.js";

const base = {
  manifestVersion: 1,
  id: "demo",
  name: "Demo",
  tagline: "A demo",
  category: "Developer",
  version: "1.0.0",
  port: 3000,
  description: "Demo app",
  website: "https://example.com",
  support: "https://example.com/support",
  gallery: ["1.jpg"],
};

describe("parseUmbrelManifest — lenient Umbrel 1.x/2.0 parsing", () => {
  it("parses a plain 1.x manifest without warnings", () => {
    const result = parseUmbrelManifest(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    expect(result.manifest.id).toBe("demo");
    expect(result.manifest.port).toBe(3000);
    expect(result.meta.manifestVersion).toBe("1");
  });

  it("fails only when the id is missing or invalid", () => {
    expect(parseUmbrelManifest({ ...base, id: undefined }).ok).toBe(false);
    expect(parseUmbrelManifest({ ...base, id: "  " }).ok).toBe(false);
    expect(parseUmbrelManifest(null).ok).toBe(false);
    expect(parseUmbrelManifest(["not", "a", "map"]).ok).toBe(false);
  });

  it("coerces YAML scalars (numeric version/developer/port strings)", () => {
    const result = parseUmbrelManifest({ ...base, version: 2.1, developer: 42, port: "8080", manifestVersion: 1.1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.version).toBe("2.1");
    expect(result.manifest.developer).toBe("42");
    expect(result.manifest.port).toBe(8080);
    expect(result.meta.manifestVersion).toBe("1.1");
  });

  it("drops invalid optional fields with a warning instead of failing", () => {
    const result = parseUmbrelManifest({ ...base, port: "not-a-port", installSize: "big", torOnly: "yes" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.port).toBeUndefined();
    expect(result.meta.installSize).toBeUndefined();
    expect(result.meta.torOnly).toBeUndefined();
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.join(" ")).toMatch(/port ignored/);
    expect(result.meta.warnings).toEqual(result.warnings);
  });

  it("treats null values as absent (no warning)", () => {
    const result = parseUmbrelManifest({ ...base, releaseNotes: null, path: null, defaultPassword: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
  });

  it("preserves unknown fields verbatim", () => {
    const result = parseUmbrelManifest({ ...base, "x-future": { nested: [1, 2] }, somethingNew: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.unknownFields).toEqual({ "x-future": { nested: [1, 2] }, somethingNew: true });
  });

  it("parses every Umbrel 2.0 field", () => {
    const result = parseUmbrelManifest({
      ...base,
      disabled: false,
      submitter: "Someone",
      submission: "https://github.com/getumbrel/umbrel-apps/pull/1",
      path: "/admin",
      defaultUsername: "admin",
      defaultPassword: 1234,
      deterministicPassword: true,
      optimizedForUmbrelHome: true,
      torOnly: false,
      requiresHttps: true,
      nativeTlsHostnameSuffixes: ["example.com"],
      installSize: 1024,
      widgets: [{ id: "stats" }],
      defaultShell: "bash",
      implements: ["bitcoin"],
      backupIgnore: ["data/cache/*"],
      dependencies: ["bitcoin"],
      permissions: ["GPU", "STORAGE_DOWNLOADS"],
      storage: { dataRoot: "data" },
      folderAccess: [{ id: "media", name: "Media", note: "  Your media  ", mounts: [{ service: "web", targetPath: "/media", readOnly: true }] }],
      environment: [{ name: "WORKERS", services: ["web"], default: 2, options: [1, 2, 4] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    expect(result.manifest.defaultPassword).toBe("1234");
    expect(result.meta).toMatchObject({
      disabled: false,
      submitter: "Someone",
      submission: "https://github.com/getumbrel/umbrel-apps/pull/1",
      path: "/admin",
      deterministicPassword: true,
      optimizedForUmbrelHome: true,
      torOnly: false,
      requiresHttps: true,
      nativeTlsHostnameSuffixes: ["example.com"],
      installSize: 1024,
      widgets: [{ id: "stats" }],
      defaultShell: "bash",
      implements: ["bitcoin"],
      backupIgnore: ["data/cache/*"],
      dependencies: ["bitcoin"],
      permissions: ["GPU", "STORAGE_DOWNLOADS"],
      storage: { dataRoot: "data" },
    });
    expect(result.meta.folderAccess).toEqual([
      { id: "media", name: "Media", note: "Your media", mounts: [{ service: "web", targetPath: "/media", readOnly: true }] },
    ]);
    expect(result.meta.environment).toEqual([{ name: "WORKERS", services: ["web"], default: "2", options: ["1", "2", "4"] }]);
  });

  it("keeps valid folderAccess/environment items and warns about invalid ones", () => {
    const result = parseUmbrelManifest({
      ...base,
      folderAccess: [
        { id: "ok", name: "OK", mounts: [{ targetPath: "/data" }] },
        { id: "no-mounts", name: "Nope", mounts: [] },
        "garbage",
      ],
      environment: [
        { name: "GOOD", services: ["web"] },
        { name: "1BAD", services: ["web"] },
        { name: "DUP", services: ["web"], options: ["a", "a"] },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.folderAccess?.map((f) => f.id)).toEqual(["ok"]);
    expect(result.meta.environment?.map((e) => e.name)).toEqual(["GOOD"]);
    expect(result.warnings).toHaveLength(4);
  });

  it("truncates long notes to 300 characters", () => {
    const note = "x".repeat(400);
    const result = parseUmbrelManifest({
      ...base,
      environment: [{ name: "A", services: ["web"], note }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.environment?.[0].note).toHaveLength(300);
    expect(result.meta.environment?.[0].note?.endsWith("…")).toBe(true);
  });

  it("rejects a storage block other than { dataRoot: data }", () => {
    const result = parseUmbrelManifest({ ...base, storage: { dataRoot: "elsewhere" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.storage).toBeUndefined();
    expect(result.warnings[0]).toMatch(/storage ignored/);
  });
});

describe("buildUmbrelApp", () => {
  const input = {
    entry: "demo",
    appDir: "/store/demo",
    files: new Set(["umbrel-app.yml", "docker-compose.yml", "icon.svg", "1.jpg"]),
    storeId: "s1",
    isOfficial: false,
  };

  it("builds a manifest and carries the Umbrel 2.0 metadata", () => {
    const result = buildUmbrelApp({
      ...input,
      manifestText: "id: demo\nname: Demo\nversion: 1.0.0\nport: 3000\ngallery: [1.jpg, missing.jpg]\nrequiresHttps: true\n",
      composeText: "services:\n  web:\n    image: demo:1.0\n    ports: ['3000:80']\n",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.webPort).toBe(3000);
    expect(result.manifest.image).toBe("demo:1.0");
    expect(result.manifest.screenshots).toHaveLength(1);
    expect(result.manifest.iconUrl).toContain(encodeURIComponent("/store/demo/icon.svg"));
    expect(result.manifest.umbrelMeta?.requiresHttps).toBe(true);
  });

  it("reports invalid YAML as a failure reason", () => {
    const result = buildUmbrelApp({ ...input, manifestText: "id: [unclosed", composeText: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not valid YAML/);
  });

  it("treats a broken compose file as non-fatal", () => {
    const result = buildUmbrelApp({ ...input, manifestText: "id: demo\n", composeText: "services: [unclosed" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toContain("docker-compose.yml is not valid YAML");
    expect(result.manifest.ports).toEqual([]);
  });
});
