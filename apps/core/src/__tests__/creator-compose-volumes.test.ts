import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

vi.mock("../db/index.js", () => ({ db: {}, schema: {} }));
vi.mock("../stores/lifecycle.js", () => ({ uninstallApp: vi.fn() }));
vi.mock("../stores/adapters/talome-adapter.js", () => ({ talomeAdapter: {} }));
vi.mock("../app-specs/service.js", () => ({ saveAppSpec: vi.fn(), deleteAppSpec: vi.fn(), getStoredAppSpec: vi.fn() }));

import { buildUserAppComposeYaml, createUserApp, isNamedVolumeSource, type CreateAppInput } from "../stores/creator.js";

type Service = CreateAppInput["services"][number];

const svc = (name: string, volumes: Service["volumes"], image = "postgres:16-alpine"): Service => ({
  name,
  image,
  ports: [],
  volumes,
  environment: {},
});

/** `docker compose config` parses locally (no engine needed); null when the compose plugin is missing. */
function composeConfig(yaml: string): { ok: boolean; output: string } | null {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
  } catch {
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "talome-creator-compose-"));
  try {
    const file = join(dir, "docker-compose.yml");
    writeFileSync(file, yaml);
    const output = execFileSync("docker", ["compose", "-f", file, "-p", "creatorcheck", "config"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: String((err as { stderr?: unknown }).stderr ?? err) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("user-app compose volumes", () => {
  it("declares named volumes at the top level", () => {
    const yaml = buildUserAppComposeYaml([
      svc("bkrs-db", [{ hostPath: "bkrspgdata", containerPath: "/var/lib/postgresql/data" }]),
      svc("bkrs-web", [{ hostPath: "./config", containerPath: "/config" }], "nginx:1.27-alpine"),
    ]);
    const doc = parseYaml(yaml) as { services: Record<string, { volumes: string[] }>; volumes?: Record<string, unknown> };
    expect(doc.services["bkrs-db"].volumes).toEqual(["bkrspgdata:/var/lib/postgresql/data"]);
    expect(doc.volumes).toEqual({ bkrspgdata: {} });
    // bind mounts are not volumes
    expect(Object.keys(doc.volumes ?? {})).not.toContain("./config");
  });

  it("declares a named volume shared by two services once", () => {
    const yaml = buildUserAppComposeYaml([
      svc("a", [{ hostPath: "shared", containerPath: "/a" }]),
      svc("b", [{ hostPath: "shared", containerPath: "/b" }, { hostPath: "other", containerPath: "/o" }]),
    ]);
    expect((parseYaml(yaml) as { volumes: Record<string, unknown> }).volumes).toEqual({ shared: {}, other: {} });
  });

  it("writes no top-level volumes block when every volume is a bind mount", () => {
    const yaml = buildUserAppComposeYaml([svc("db", [{ hostPath: "./data", containerPath: "/var/lib/postgresql/data" }])]);
    expect((parseYaml(yaml) as Record<string, unknown>).volumes).toBeUndefined();
  });

  it("produces a compose file docker compose accepts", (ctx) => {
    const yaml = buildUserAppComposeYaml([
      svc("bkrs-db", [{ hostPath: "bkrspgdata", containerPath: "/var/lib/postgresql/data" }]),
      svc("bkrs-web", [{ hostPath: "./config", containerPath: "/config" }], "nginx:1.27-alpine"),
    ]);
    const result = composeConfig(yaml);
    if (!result) return ctx.skip();
    expect(result.output).not.toMatch(/undefined volume/);
    expect(result.ok).toBe(true);
  });

  it("classifies volume sources the way compose does", () => {
    expect(isNamedVolumeSource("pgdata")).toBe(true);
    expect(isNamedVolumeSource("pg_data.v1")).toBe(true);
    expect(isNamedVolumeSource("./data")).toBe(false);
    expect(isNamedVolumeSource("../shared")).toBe(false);
    expect(isNamedVolumeSource(".hidden")).toBe(false);
    expect(isNamedVolumeSource("data/db")).toBe(false);
  });

  it.each([
    ["data/db", /Use "\.\/data\/db"/],
    ["bad name", /Volume names may contain only/],
    ["-leading", /Volume names may contain only/],
  ])("rejects the volume source %j before writing anything", (hostPath, message) => {
    const input: CreateAppInput = {
      id: "volume-check",
      name: "Volume check",
      description: "",
      category: "other",
      env: [],
      services: [svc("db", [{ hostPath, containerPath: "/data" }])],
    };
    const result = createUserApp(input);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(message);
  });
});
