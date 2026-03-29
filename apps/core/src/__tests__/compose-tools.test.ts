import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

// ── Mock DB for installedApps lookup ──────────────────────────────────────────
vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          get: vi.fn(),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({ run: vi.fn() }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: vi.fn() }),
      }),
    }),
  },
  schema: {
    installedApps: { appId: "app_id", overrideComposePath: "override_compose_path" },
    settings: { key: "key" },
  },
}));

vi.mock("../db/audit.js", () => ({
  writeAuditEntry: vi.fn(),
}));

import { safePath } from "../ai/tools/compose-tools.js";

// ── safePath tests ────────────────────────────────────────────────────────────
describe("safePath", () => {
  it("resolves a normal absolute path", () => {
    const result = safePath("/data/talome/apps/sonarr/docker-compose.yml");
    expect(result).toBe("/data/talome/apps/sonarr/docker-compose.yml");
  });

  it("throws on path traversal with ..", () => {
    expect(() => safePath("/data/../etc/passwd")).toThrow(/path traversal/i);
  });

  it("throws on relative path traversal", () => {
    expect(() => safePath("../../etc/passwd")).toThrow(/path traversal/i);
  });
});

// ── YAML round-trip tests ─────────────────────────────────────────────────────
describe("YAML round-trip for docker-compose", () => {
  const TEST_DIR = join(tmpdir(), `talome-test-${Date.now()}`);
  const COMPOSE_PATH = join(TEST_DIR, "docker-compose.yml");

  const SAMPLE_COMPOSE = `
services:
  sonarr:
    image: linuxserver/sonarr:latest
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/London
    ports:
      - "8989:8989"
    volumes:
      - /data/config/sonarr:/config
`;

  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    await writeFile(COMPOSE_PATH, SAMPLE_COMPOSE, "utf-8");
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("parses compose YAML and finds service name", async () => {
    const { readFile } = await import("node:fs/promises");
    const { parse } = await import("yaml");
    const content = await readFile(COMPOSE_PATH, "utf-8");
    const parsed = parse(content) as Record<string, unknown>;
    expect(parsed.services).toBeDefined();
    expect(Object.keys(parsed.services as object)).toContain("sonarr");
  });

  it("reads environment variables from array format", async () => {
    const { readFile } = await import("node:fs/promises");
    const { parse } = await import("yaml");
    const content = await readFile(COMPOSE_PATH, "utf-8");
    const parsed = parse(content) as Record<string, unknown>;
    const services = parsed.services as Record<string, Record<string, unknown>>;
    expect(services.sonarr.environment).toBeInstanceOf(Array);
    expect(services.sonarr.environment).toContain("PUID=1000");
  });

  it("updates an env var and writes valid YAML back", async () => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const { parse, stringify } = await import("yaml");

    const content = await readFile(COMPOSE_PATH, "utf-8");
    const parsed = parse(content) as Record<string, unknown>;
    const services = parsed.services as Record<string, Record<string, unknown>>;
    const env = services.sonarr.environment as string[];

    // Update TZ
    const idx = env.findIndex((e: string) => e.startsWith("TZ="));
    env[idx] = "TZ=America/New_York";

    const newContent = stringify(parsed);
    await writeFile(COMPOSE_PATH, newContent, "utf-8");

    // Re-read and verify
    const updated = parse(await readFile(COMPOSE_PATH, "utf-8")) as Record<string, unknown>;
    const updatedServices = updated.services as Record<string, Record<string, unknown>>;
    const updatedEnv = updatedServices.sonarr.environment as string[];
    expect(updatedEnv).toContain("TZ=America/New_York");
    // Other keys preserved
    expect(updatedEnv).toContain("PUID=1000");
  });

  it("preserves non-env fields after YAML round-trip", async () => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const { parse, stringify } = await import("yaml");

    const content = await readFile(COMPOSE_PATH, "utf-8");
    const parsed = parse(content);
    const newContent = stringify(parsed);
    const reparsed = parse(newContent) as Record<string, unknown>;
    const services = reparsed.services as Record<string, Record<string, unknown>>;

    expect(services.sonarr.image).toBe("linuxserver/sonarr:latest");
    expect(services.sonarr.ports).toContain("8989:8989");
    expect(services.sonarr.volumes).toContain("/data/config/sonarr:/config");
  });
});

// ── app-registry tests ────────────────────────────────────────────────────────
describe("app-registry", () => {
  it("returns capabilities for sonarr", async () => {
    const { getAppCapabilities } = await import("../app-registry/index.js");
    const cap = getAppCapabilities("sonarr");
    expect(cap).toBeDefined();
    expect(cap?.name).toBe("Sonarr");
    expect(cap?.healthEndpoint).toBe("/api/v3/health");
    expect(cap?.commonPorts).toContain(8989);
  });

  it("returns capabilities for jellyfin", async () => {
    const { getAppCapabilities } = await import("../app-registry/index.js");
    const cap = getAppCapabilities("jellyfin");
    expect(cap?.talomeToolPrefix).toBe("jellyfin_");
    expect(cap?.relatesTo).toContain("overseerr");
  });

  it("returns undefined for unknown app", async () => {
    const { getAppCapabilities } = await import("../app-registry/index.js");
    expect(getAppCapabilities("nonexistent-app-xyz")).toBeUndefined();
  });

  it("is case-insensitive", async () => {
    const { getAppCapabilities } = await import("../app-registry/index.js");
    expect(getAppCapabilities("SONARR")).toBeDefined();
    expect(getAppCapabilities("Radarr")).toBeDefined();
  });
});
