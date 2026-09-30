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

describe("user-app compose — sources compose resolves, and nothing that escapes the app", () => {
  const input = (services: Service[]): CreateAppInput => ({
    id: "volume-check",
    name: "Volume check",
    description: "",
    category: "other",
    env: [],
    services,
  });
  /** Validation result only: a valid input goes on to write files, which this test's mocks do not support */
  const validationError = (services: Service[]) => {
    const r = createUserApp(input(services));
    return r.success ? null : (r.error ?? "");
  };
  /** Past validation, createUserApp reaches the (mocked, empty) database */
  const passedValidation = (e: string | null) => e === null || /db\.select is not a function/.test(e);

  it.each(["${APP_DATA_DIR}/config", "$APP_DATA_DIR/config", "${APP_DATA_DIR}"])("accepts the app data directory source %j", (hostPath) => {
    const error = validationError([svc("db", [{ hostPath, containerPath: "/config" }])]);
    expect(passedValidation(error), String(error)).toBe(true);
  });

  it("does not apply compose-shape checks to the service list of a workspace that brings its own compose file", () => {
    const scaffold = mkdtempSync(join(tmpdir(), "talome-creator-scaffold-"));
    try {
      writeFileSync(join(scaffold, "docker-compose.yml"), "services:\n  web:\n    image: nginx:1.27-alpine\n");
      const services = [svc("web", [{ hostPath: "config/app", containerPath: "/config" }])];
      // generated from the service list: "config/app" is neither a path compose resolves nor a volume name
      expect(validationError(services)).toMatch(/Use "\.\/config\/app"/);
      const r = createUserApp(input(services), { validatedScaffoldPath: scaffold });
      expect(passedValidation(r.success ? null : (r.error ?? "")), String(r.error)).toBe(true);
      // path safety still applies
      const escaped = createUserApp(input([svc("web", [{ hostPath: "../../etc", containerPath: "/etc" }])]), { validatedScaffoldPath: scaffold });
      expect(escaped.error).toMatch(/leaves the app directory/);
    } finally {
      rmSync(scaffold, { recursive: true, force: true });
    }
  });

  it.each([
    ["../../../../../../var/run/docker.sock", /leaves the app directory/],
    ["./data/../../etc", /leaves the app directory/],
    ["${APP_DATA_DIR}/../../etc", /leaves the app directory/],
    ["${HOME}/.ssh", /only \$\{APP_DATA_DIR\}/],
    ["./${SECRET_DIR}", /only \$\{APP_DATA_DIR\}/],
    ["${APP_DATA_DIR}/${X}", /only \$\{APP_DATA_DIR\}/],
    ["./x\n    privileged: true", /control characters/],
  ])("rejects the volume source %j", (hostPath, message) => {
    expect(validationError([svc("db", [{ hostPath, containerPath: "/data" }])])).toMatch(message);
  });

  it("rejects an image, service name or container path that would add compose keys", () => {
    expect(validationError([svc("db", [], "alpine:3\n    network_mode: host")])).toMatch(/invalid image reference/);
    expect(validationError([svc("db\n    privileged: true", [])])).toMatch(/Service name/);
    expect(validationError([svc("db", [{ hostPath: "./d", containerPath: "/d\n    privileged: true" }])])).toMatch(/invalid container path/);
    expect(validationError([{ ...svc("db", []), environment: { "A\nB": "1" } }])).toMatch(/invalid environment variable name/);
  });

  it("serializes values instead of pasting them into YAML", () => {
    const yaml = buildUserAppComposeYaml([
      { ...svc("web", [{ hostPath: "./x #not-a-comment", containerPath: "/x" }]), environment: { NOTE: "a\n    privileged: true" } },
    ]);
    const doc = parseYaml(yaml) as { services: Record<string, Record<string, unknown>> };
    expect(Object.keys(doc.services.web).sort()).toEqual(["container_name", "environment", "image", "restart", "volumes"]);
    expect(doc.services.web.environment).toEqual(["NOTE=a\n    privileged: true"]);
    expect(doc.services.web.volumes).toEqual(["./x #not-a-comment:/x"]);
  });

  it.for(["1", "0x1", "true", "null", "1e3"])("keeps the named volume %j a string key that docker compose accepts", (name, ctx) => {
    const yaml = buildUserAppComposeYaml([svc("db", [{ hostPath: name, containerPath: "/var/lib/postgresql/data" }])]);
    const doc = parseYaml(yaml) as { services: Record<string, { volumes: string[] }>; volumes: Record<string, unknown> };
    expect(Object.keys(doc.volumes)).toEqual([name]);
    expect(doc.services.db.volumes).toEqual([`${name}:/var/lib/postgresql/data`]);
    const result = composeConfig(yaml);
    if (!result) return ctx.skip();
    expect(result.output).not.toMatch(/non-string key/);
    expect(result.ok).toBe(true);
  });
});
