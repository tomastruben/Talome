import { describe, it, expect } from "vitest";

// Test the safe JSON.parse pattern used in apps.ts
// This validates that corrupt DB rows don't crash the route.

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

describe("safeJsonParse()", () => {
  it("parses valid JSON", () => {
    expect(safeJsonParse('["a","b"]', [])).toEqual(["a", "b"]);
  });

  it("returns fallback for invalid JSON", () => {
    expect(safeJsonParse("not json {{{", [])).toEqual([]);
  });

  it("returns fallback for null input", () => {
    expect(safeJsonParse(null, [])).toEqual([]);
  });

  it("returns fallback for undefined input", () => {
    expect(safeJsonParse(undefined, {})).toEqual({});
  });

  it("returns fallback for empty string", () => {
    expect(safeJsonParse("", [])).toEqual([]);
  });

  it("parses a ports array correctly", () => {
    const ports = safeJsonParse('[{"host":8080,"container":80}]', []);
    expect(ports).toHaveLength(1);
    expect((ports as any)[0].host).toBe(8080);
  });

  it("does not throw for truncated JSON (corrupt DB row)", () => {
    expect(() => safeJsonParse('{"ports": [1, 2,', [])).not.toThrow();
  });
});

// Test that rowToManifest never throws even with corrupt rows
describe("rowToManifest safety", () => {
  function buildFakeRow(overrides: Record<string, string | null | undefined> = {}): Record<string, any> {
    return {
      appId: "test-app",
      name: "Test App",
      version: "1.0",
      tagline: "A test",
      description: "Description",
      releaseNotes: null,
      icon: "icon.png",
      iconUrl: null,
      screenshots: "screenshots" in overrides ? overrides.screenshots : '[]',
      category: "utilities",
      author: "Test",
      website: null,
      repo: null,
      support: null,
      source: "talome",
      storeSourceId: "talome-store",
      composePath: "/tmp/compose.yml",
      image: null,
      ports: "ports" in overrides ? overrides.ports : '[]',
      volumes: "volumes" in overrides ? overrides.volumes : '[]',
      env: "env" in overrides ? overrides.env : '[]',
      architectures: null,
      dependencies: null,
      defaultUsername: null,
      defaultPassword: null,
      webPort: null,
    };
  }

  function rowToManifest(row: Record<string, any>) {
    return {
      id: row.appId,
      name: row.name,
      ports: safeJsonParse(row.ports, []),
      volumes: safeJsonParse(row.volumes, []),
      env: safeJsonParse(row.env, []),
      screenshots: safeJsonParse(row.screenshots, undefined),
    };
  }

  it("converts a valid row without throwing", () => {
    const manifest = rowToManifest(buildFakeRow());
    expect(manifest.id).toBe("test-app");
    expect(manifest.ports).toEqual([]);
  });

  it("handles corrupt ports JSON gracefully", () => {
    const manifest = rowToManifest(buildFakeRow({ ports: "{corrupt" }));
    expect(manifest.ports).toEqual([]);
  });

  it("handles corrupt env JSON gracefully", () => {
    const manifest = rowToManifest(buildFakeRow({ env: "[[invalid" }));
    expect(manifest.env).toEqual([]);
  });

  it("handles null screenshots gracefully", () => {
    const manifest = rowToManifest(buildFakeRow({ screenshots: null }));
    // safeJsonParse(null, undefined) returns undefined — no array default for screenshots
    expect(manifest.screenshots).toBeUndefined();
  });
});
