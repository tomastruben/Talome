/**
 * requiresHttps (Umbrel manifests) → proxy routes are always registered with
 * TLS (Caddy internal CA when the default would be HTTP-only), existing
 * HTTP-only routes are upgraded, and installs without any TLS path carry a
 * clear warning. Real temp SQLite; Docker and Caddy are mocked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const tmp = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/talome-wire-compat-https-${process.pid}-${Date.now()}`.replace(/\/+/g, "/");
  process.env.DATABASE_PATH = `${dir}/db/talome.db`;
  return { dir, home: `${dir}/home` };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedir = () => tmp.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock("../docker/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../docker/client.js")>();
  const fakeDocker = {
    getContainer: () => ({ inspect: async () => { throw new Error("no such container"); } }),
    listContainers: async () => [],
  };
  return { ...actual, docker: fakeDocker, listContainers: vi.fn(async () => []) };
});

vi.mock("../proxy/network.js", () => ({
  ensureProxyNetwork: vi.fn(async () => {}),
  connectContainerToProxyNetwork: vi.fn(async () => {}),
  PROXY_NETWORK: "talome",
}));

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { setSetting } from "../utils/settings.js";
import { autoRegisterProxyRoute } from "../proxy/caddy.js";
import { createProxyRoutesForApps } from "../proxy/local-domains.js";
import { requiresHttpsInstallWarning, resolveAppTlsMode } from "../proxy/https-policy.js";
import { applyUmbrelV2Install, getInstallAccessWarnings } from "../stores/umbrel-v2-install.js";
import { REQUIRES_HTTPS_WARNING } from "../stores/umbrel-v2.js";

const STORE = "https-fx";
const COMPOSE = join(tmp.dir, "compose", "docker-compose.yml");

function addApp(appId: string, opts: { requiresHttps: boolean; webPort: number | null; installed?: boolean }): typeof schema.appCatalog.$inferSelect {
  db.insert(schema.appCatalog)
    .values({
      appId,
      storeSourceId: STORE,
      name: appId === "secure-app" ? "Secure App" : appId,
      source: "umbrel",
      composePath: COMPOSE,
      webPort: opts.webPort,
      umbrelMeta: JSON.stringify({ requiresHttps: opts.requiresHttps }),
    })
    .run();
  if (opts.installed !== false) {
    const now = new Date().toISOString();
    db.insert(schema.installedApps).values({ appId, storeSourceId: STORE, status: "running", installedAt: now, updatedAt: now }).run();
  }
  return db.select().from(schema.appCatalog).all().find((r) => r.appId === appId)!;
}

function routeFor(appId: string): { domain: string; tls_mode: string } | undefined {
  return db.get(sql`SELECT domain, tls_mode FROM proxy_routes WHERE app_id = ${appId}`) as { domain: string; tls_mode: string } | undefined;
}

function caddyfile(): string {
  return readFileSync(join(tmp.home, ".talome", "caddy", "Caddyfile"), "utf-8");
}

function enableProxy(baseDomain: string, defaultTls: string): void {
  setSetting("proxy_enabled", "true");
  setSetting("proxy_base_domain", baseDomain);
  setSetting("proxy_default_tls", defaultTls);
}

beforeAll(() => {
  runMigrations();
  mkdirSync(join(tmp.dir, "compose"), { recursive: true });
  writeFileSync(COMPOSE, "services:\n  web:\n    image: example/web:1.0.0\n    ports:\n      - \"8443:8443\"\n");
  db.insert(schema.storeSources)
    .values({ id: STORE, name: "HTTPS fixtures", type: "umbrel", branch: "main", localPath: tmp.dir, enabled: true, appCount: 0 })
    .run();
  addApp("secure-app", { requiresHttps: true, webPort: 8443 });
  addApp("plain-app", { requiresHttps: false, webPort: 8080 });
  addApp("secure-noport", { requiresHttps: true, webPort: null });
});

afterAll(() => {
  rmSync(tmp.dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.run(sql`DELETE FROM proxy_routes`);
  setSetting("proxy_enabled", "false");
});

describe("resolveAppTlsMode", () => {
  it("never returns off for an app that requires HTTPS", () => {
    expect(resolveAppTlsMode("example.com", "off", true)).toBe("selfsigned");
    expect(resolveAppTlsMode("example.com", "off", false)).toBe("off");
    expect(resolveAppTlsMode("example.com", "auto", true)).toBe("auto");
    expect(resolveAppTlsMode("example.com", undefined, false)).toBe("auto");
    expect(resolveAppTlsMode("example.com", "bogus", true)).toBe("auto");
    expect(resolveAppTlsMode("talome.local", "off", false)).toBe("selfsigned");
  });
});

describe("autoRegisterProxyRoute", () => {
  it("registers a requiresHttps app with Caddy's internal CA when the default TLS is off", async () => {
    enableProxy("example.com", "off");
    const secure = await autoRegisterProxyRoute("secure-app", "Secure App", 8443);
    const plain = await autoRegisterProxyRoute("plain-app", "plain-app", 8080);
    expect(secure).toEqual({ registered: true, domain: "secure-app.example.com", tlsMode: "selfsigned" });
    expect(plain).toMatchObject({ registered: true, tlsMode: "off" });
    expect(routeFor("secure-app")?.tls_mode).toBe("selfsigned");

    const file = caddyfile();
    const secureBlock = file.slice(file.indexOf("secure-app.example.com {"));
    expect(file).not.toContain("http://secure-app.example.com");
    expect(secureBlock.split("}")[0]).toContain("tls internal");
    expect(file).toContain("http://plain-app.example.com {");
  });

  it("upgrades an existing HTTP-only route of a requiresHttps app", async () => {
    enableProxy("example.com", "off");
    db.run(sql`INSERT INTO proxy_routes (id, app_id, domain, upstream, tls_mode, created_at)
      VALUES ('r1', 'secure-app', 'photos.example.com', 'secure-app:8443', 'off', ${new Date().toISOString()})`);
    const result = await autoRegisterProxyRoute("secure-app", "Secure App", 8443);
    expect(result).toMatchObject({ registered: false, upgraded: true, domain: "photos.example.com", tlsMode: "selfsigned" });
    expect(routeFor("secure-app")?.tls_mode).toBe("selfsigned");
  });

  it("leaves other existing routes untouched and reports a disabled proxy", async () => {
    enableProxy("example.com", "off");
    db.run(sql`INSERT INTO proxy_routes (id, app_id, domain, upstream, tls_mode, created_at)
      VALUES ('r2', 'plain-app', 'plain.example.com', 'plain-app:8080', 'off', ${new Date().toISOString()})`);
    expect(await autoRegisterProxyRoute("plain-app", "plain-app", 8080)).toMatchObject({ registered: false, reason: "exists" });
    expect(routeFor("plain-app")?.tls_mode).toBe("off");

    setSetting("proxy_enabled", "false");
    expect(await autoRegisterProxyRoute("secure-app", "Secure App", 8443)).toEqual({ registered: false, reason: "proxy-disabled" });
  });
});

describe("local domains", () => {
  it("never creates HTTP-only routes for requiresHttps apps", async () => {
    await createProxyRoutesForApps("example.com", "off");
    expect(routeFor("secure-app")?.tls_mode).toBe("selfsigned");
    expect(routeFor("plain-app")?.tls_mode).toBe("off");
  });
});

describe("install warnings when no TLS path exists", () => {
  it("warns when the reverse proxy is off", () => {
    const warnings = getInstallAccessWarnings("secure-app");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Secure App requires HTTPS/);
    expect(warnings[0]).toMatch(/plain HTTP \(http:\/\/<server>:8443\)/);
    expect(warnings[0]).toMatch(/Local Domains/);
  });

  it("warns when there is no web port to route", () => {
    enableProxy("example.com", "auto");
    expect(getInstallAccessWarnings("secure-noport")[0]).toMatch(/no web port/);
  });

  it("is silent once a TLS route is available, and for apps that do not need HTTPS", () => {
    enableProxy("example.com", "off");
    expect(getInstallAccessWarnings("secure-app")).toEqual([]);
    setSetting("proxy_enabled", "false");
    expect(getInstallAccessWarnings("plain-app")).toEqual([]);
    expect(requiresHttpsInstallWarning("x", "X", { webPort: 1, requiresHttps: false })).toBeNull();
    db.run(sql`INSERT INTO proxy_routes (id, app_id, domain, upstream, tls_mode, created_at)
      VALUES ('r3', 'secure-app', 'photos.example.com', 'secure-app:8443', 'auto', ${new Date().toISOString()})`);
    expect(getInstallAccessWarnings("secure-app")).toEqual([]);
  });

  it("replaces the generic HTTPS note in the Umbrel install plan", () => {
    const row = addApp("secure-new", { requiresHttps: true, webPort: 9443, installed: false });
    const off = applyUmbrelV2Install(row, "secure-new", COMPOSE, {});
    expect(off.ok).toBe(true);
    if (!off.ok || !off.plan) throw new Error("expected a plan");
    expect(off.plan.warnings).not.toContain(REQUIRES_HTTPS_WARNING);
    expect(off.plan.warnings.some((w) => /reverse proxy is not enabled/.test(w))).toBe(true);

    enableProxy("example.com", "auto");
    const on = applyUmbrelV2Install(row, "secure-new", COMPOSE, {});
    if (!on.ok || !on.plan) throw new Error("expected a plan");
    expect(on.plan.warnings).toContain(REQUIRES_HTTPS_WARNING);
  });
});
