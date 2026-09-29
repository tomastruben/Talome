/**
 * The app-store Immich app (what install_app installs from a Talome store)
 * follows the official Immich v3.2.4 layout: server + machine-learning +
 * valkey + VectorChord postgres, pinned tags, library at /data, DB on a local
 * relative path and a per-install DB password (never a fixed default).
 */
import { describe, it, expect, vi, afterAll } from "vitest";

const tmp = vi.hoisted(() => ({
  home: `${process.env.TMPDIR ?? "/tmp"}/talome-wire-compat-immich-${process.pid}-${Date.now()}`.replace(/\/+/g, "/"),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedir = () => tmp.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

import { readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { findComposeVars, applyVolumeMounts } from "../stores/compose-pipeline.js";
import { talomeAdapter } from "../stores/adapters/talome-adapter.js";
import { photoManagementStack } from "../stacks/photo-management.js";

const APP_STORE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "app-store");
const COMPOSE_PATH = join(APP_STORE, "apps", "immich", "docker-compose.yml");
const MANIFEST_PATH = join(APP_STORE, "apps", "immich", "manifest.json");

interface Service {
  image: string;
  container_name?: string;
  restart?: string;
  ports?: string[];
  volumes?: string[];
  environment?: string[];
  depends_on?: string[];
  healthcheck?: { disable?: boolean; test?: unknown };
  shm_size?: string;
}

const raw = readFileSync(COMPOSE_PATH, "utf-8");
const compose = yaml.load(raw) as { services: Record<string, Service>; volumes?: Record<string, unknown> };
const services = compose.services;
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as {
  version: string;
  image: string;
  category: string;
  ports: Array<{ host: number; container: number }>;
  env: Array<{ key: string; required?: boolean; secret?: boolean; default?: string }>;
  volumes: Array<{ name: string; containerPath: string; mediaVolume?: boolean }>;
};

function envOf(svc: Service): Record<string, string> {
  return Object.fromEntries((svc.environment ?? []).map((e) => {
    const i = e.indexOf("=");
    return [e.slice(0, i), e.slice(i + 1)];
  }));
}

const server = services["immich-server"];
const ml = services["immich-machine-learning"];
const redis = services["immich-redis"];
const database = services["immich-postgres"];

afterAll(() => {
  rmSync(tmp.home, { recursive: true, force: true });
});

describe("app-store Immich compose", () => {
  it("ships the four official services with pinned v3.2.4 images", () => {
    expect(Object.keys(services).sort()).toEqual(["immich-machine-learning", "immich-postgres", "immich-redis", "immich-server"]);
    expect(server.image).toBe("ghcr.io/immich-app/immich-server:v3.2.4");
    expect(ml.image).toBe("ghcr.io/immich-app/immich-machine-learning:v3.2.4");
    expect(redis.image).toMatch(/(^|\/)valkey\/valkey:9$/);
    expect(database.image).toBe("ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0");
  });

  it("never uses latest/release tags", () => {
    for (const svc of Object.values(services)) {
      expect(svc.image).toMatch(/:[\w.-]+$/);
      expect(svc.image).not.toMatch(/:(latest|release)$/);
    }
    expect(raw).not.toMatch(/:latest\b/);
  });

  it("restarts always and has healthchecks everywhere", () => {
    for (const svc of Object.values(services)) {
      expect(svc.restart).toBe("always");
      expect(svc.healthcheck).toBeTruthy();
      expect(svc.healthcheck?.disable ?? false).toBe(false);
    }
    expect(JSON.stringify(redis.healthcheck?.test)).toMatch(/ping/);
    expect(JSON.stringify(database.healthcheck?.test)).toMatch(/pg_isready/);
  });

  it("serves the web UI on 2283 from the container named after the app", () => {
    expect(server.ports).toEqual(["2283:2283"]);
    expect(server.container_name).toBe("immich");
  });

  it("mounts the upload library at /data and keeps the DB on a local relative path", () => {
    expect(server.volumes).toEqual(["./library:/data"]);
    expect(raw).not.toContain("/usr/src/app/upload");
    expect(database.volumes).toEqual(["./postgres:/var/lib/postgresql/data"]);
    expect(ml.volumes).toEqual(["model-cache:/cache"]);
    expect(compose.volumes).toHaveProperty("model-cache");
  });

  it("configures postgres like upstream (shm, checksums, credentials)", () => {
    expect(database.shm_size).toBe("128mb");
    const db = envOf(database);
    expect(db.POSTGRES_INITDB_ARGS).toBe("--data-checksums");
    expect(db.POSTGRES_USER).toBe("postgres");
    expect(db.POSTGRES_DB).toBe("immich");
  });

  it("wires the server to its own database and valkey by unique container names", () => {
    const env = envOf(server);
    expect(env.DB_HOSTNAME).toBe(database.container_name);
    expect(env.REDIS_HOSTNAME).toBe(redis.container_name);
    expect(env.DB_USERNAME).toBe(envOf(database).POSTGRES_USER);
    expect(env.DB_DATABASE_NAME).toBe(envOf(database).POSTGRES_DB);
    expect(server.depends_on?.sort()).toEqual(["immich-postgres", "immich-redis"]);
  });

  it("takes the DB password from a per-install value — no fixed default", () => {
    expect(envOf(server).DB_PASSWORD).toBe("${DB_PASSWORD}");
    expect(envOf(database).POSTGRES_PASSWORD).toBe("${DB_PASSWORD}");
    expect(raw).not.toMatch(/DB_PASSWORD:-/);
    expect(raw).not.toMatch(/PASSWORD=(?!\$\{DB_PASSWORD\})/);
    // The install pre-validation refuses to start without it.
    expect(findComposeVars(COMPOSE_PATH)).toEqual(["DB_PASSWORD"]);
  });

  it("lets the user put the library on another drive", () => {
    const override = applyVolumeMounts(COMPOSE_PATH, "immich", { library: "/Volumes/Photos/immich" }, manifest.volumes);
    expect(override).toBeTruthy();
    const doc = yaml.load(readFileSync(override!, "utf-8")) as { services: Record<string, Service> };
    expect(doc.services["immich-server"].volumes).toEqual(["/Volumes/Photos/immich:/data"]);
    expect(doc.services["immich-postgres"].volumes).toEqual(["./postgres:/var/lib/postgresql/data"]);
  });
});

describe("app-store Immich manifest", () => {
  it("matches the compose (version, image, port, category)", () => {
    expect(manifest.version).toBe("3.2.4");
    expect(manifest.image).toBe(server.image);
    expect(manifest.ports).toEqual([{ host: 2283, container: 2283 }]);
    expect(manifest.category).toBe("media");
    expect(manifest.volumes.find((v) => v.containerPath === "/data")).toMatchObject({ name: "library", mediaVolume: true });
  });

  it("requires a secret DB password with no default", () => {
    const pw = manifest.env.find((e) => e.key === "DB_PASSWORD");
    expect(pw).toMatchObject({ required: true, secret: true });
    expect(pw?.default).toBeUndefined();
  });

  it("is parsed by the Talome store adapter", () => {
    const apps = talomeAdapter.parse(APP_STORE, "talome-test");
    const immich = apps.find((a) => a.id === "immich");
    expect(immich).toMatchObject({ version: "3.2.4", webPort: 2283, source: "talome", category: "media" });
    expect(immich?.env.find((e) => e.key === "DB_PASSWORD")).toMatchObject({ required: true, secret: true });
    expect(immich?.installNotes).toMatch(/random/);
  });
});

describe("photo-management stack stays in step with the app store", () => {
  const stackImmich = photoManagementStack.apps.find((a) => a.appId === "immich")!;

  it("uses the same Immich, valkey and postgres versions", () => {
    expect(stackImmich.compose).toContain("immich-server:${IMMICH_VERSION:-v3.2.4}");
    expect(stackImmich.compose).toContain("immich-machine-learning:${IMMICH_VERSION:-v3.2.4}");
    expect(stackImmich.compose).toContain(redis.image);
    expect(stackImmich.compose).toContain(database.image);
    expect(stackImmich.configSchema.envVars.find((e) => e.key === "IMMICH_VERSION")?.defaultValue).toBe("v3.2.4");
  });
});
