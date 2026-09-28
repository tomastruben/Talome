import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

const DB_FILE = vi.hoisted(() => {
  const file = `${process.env.TMPDIR ?? "/tmp"}/talome-outcome-probes-routes-${process.pid}-${Date.now()}.db`;
  process.env.DATABASE_PATH = file;
  return file;
});

vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("real network disabled in tests"); }));

import { rmSync } from "node:fs";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { runOutcomeProbesMigrations } from "../db/migrations/outcome-probes.js";
import { verification } from "../routes/verification.js";
import { verifyApp, getLatestVerificationResult, getVerificationHistory } from "../verification/index.js";
import { HISTORY_LIMIT } from "../verification/store.js";
import { verifyAppOutcomeTool } from "../ai/tools/verification-tools.js";
import { SECRETS, allSecretValues, healthyMediaRoutes, healthyMounts, makeDeps, mediaSettings } from "./outcome-probes-fixtures.js";

function appAs(role: "admin" | "member", userId = "u-admin") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionRole" as never, role as never);
    c.set("sessionUser" as never, userId as never);
    await next();
  });
  app.route("/api/verification", verification);
  return app;
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  runMigrations();
  db.run(sql`INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at) VALUES ('u-member', 'member', 'x', 'member', '2026-01-01T00:00:00Z')`);
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB_FILE}${suffix}`, { force: true });
});

describe("outcome-probes migration", () => {
  it("creates verification_results and is idempotent", () => {
    runOutcomeProbesMigrations();
    runOutcomeProbesMigrations();
    const cols = (db.all(sql`PRAGMA table_info(verification_results)`) as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["id", "target_type", "target_id", "status", "result_json", "verified_at", "include_active", "duration_ms", "summary"]));
    const version = db.get(sql`SELECT version FROM schema_versions WHERE version = 22`) as { version: number } | undefined;
    expect(version?.version).toBe(22);
  });
});

describe("persistence", () => {
  it("stores results, returns the latest first and prunes history", async () => {
    const { deps } = makeDeps({ settings: mediaSettings(), routes: healthyMediaRoutes(), mounts: healthyMounts() });
    for (let i = 0; i < HISTORY_LIMIT + 3; i++) {
      const out = await verifyApp("radarr", { deps });
      expect(out.ok).toBe(true);
    }
    const latest = getLatestVerificationResult("app", "radarr");
    expect(latest?.status).toBe("verified");
    expect(getVerificationHistory("app", "radarr", 50)).toHaveLength(HISTORY_LIMIT);
    const count = db.get(sql`SELECT COUNT(*) AS n FROM verification_results WHERE target_id = 'radarr'`) as { n: number };
    expect(count.n).toBe(HISTORY_LIMIT);
    const raw = db.all(sql`SELECT result_json FROM verification_results`) as Array<{ result_json: string }>;
    for (const row of raw) for (const s of allSecretValues()) expect(row.result_json).not.toContain(s);
  });
});

describe("verification routes", () => {
  it("GET /apps/:id returns the last persisted result", async () => {
    const { deps } = makeDeps({ settings: mediaSettings(), routes: healthyMediaRoutes(), mounts: healthyMounts() });
    await verifyApp("sonarr", { deps });
    const res = await appAs("admin").request("/api/verification/apps/sonarr");
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { status: string; checks: unknown[] } | null };
    expect(body.result?.status).toBe("verified");
    expect(body.result?.checks.length).toBeGreaterThan(3);
    expect(JSON.stringify(body)).not.toContain(SECRETS.sonarr);
  });

  it("GET /apps/:id?history=N returns history, null result before any run, 404 for unknown apps", async () => {
    const app = appAs("admin");
    const hist = await (await app.request("/api/verification/apps/radarr?history=3")).json() as { history: unknown[] };
    expect(hist.history).toHaveLength(3);

    const empty = await (await app.request("/api/verification/apps/immich")).json() as { result: unknown };
    expect(empty.result).toBeNull();

    expect((await app.request("/api/verification/apps/not-an-app")).status).toBe(404);
    expect((await app.request("/api/verification/apps/bad%20id")).status).toBe(400);
    expect((await app.request("/api/verification/apps/radarr?history=999")).status).toBe(400);
  });

  it("POST /run verifies an app (unconfigured → unknown) and persists it", async () => {
    const app = appAs("admin");
    const res = await app.request("/api/verification/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: "prowlarr" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { status: string; targetId: string } };
    expect(body.result.targetId).toBe("prowlarr");
    expect(body.result.status).toBe("unknown");
    const get = await (await app.request("/api/verification/apps/prowlarr")).json() as { result: { status: string } };
    expect(get.result.status).toBe("unknown");
  });

  it("POST /run verifies a stack by alias and GET /stacks/:id resolves aliases too", async () => {
    const app = appAs("admin");
    const res = await app.request("/api/verification/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stackId: "photos" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { targetId: string; chain: unknown[] } };
    expect(body.result.targetId).toBe("photo-management");
    expect(body.result.chain).toHaveLength(3);
    const get = await (await app.request("/api/verification/stacks/photos")).json() as { result: { targetId: string } };
    expect(get.result.targetId).toBe("photo-management");
    expect((await app.request("/api/verification/stacks/developer-lab")).status).toBe(404);
  });

  it("validates the run body", async () => {
    const app = appAs("admin");
    const post = (body: unknown) => app.request("/api/verification/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({})).status).toBe(400);
    expect((await post({ appId: "sonarr", stackId: "media-server" })).status).toBe(400);
    expect((await post({ appId: "../etc" })).status).toBe(400);
    expect((await post({ appId: "nope" })).status).toBe(404);
  });

  it("only admins may run active probes", async () => {
    const member = appAs("member", "u-member");
    const denied = await member.request("/api/verification/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: "sonarr", includeActive: true }),
    });
    expect(denied.status).toBe(403);
    const allowed = await member.request("/api/verification/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: "sonarr" }),
    });
    expect(allowed.status).toBe(200);
  });

  it("GET / lists verifiable apps and stacks with their latest status", async () => {
    const body = await (await appAs("admin").request("/api/verification")).json() as { apps: Array<{ id: string; status: string | null }>; stacks: Array<{ id: string }> };
    expect(body.apps.find((a) => a.id === "radarr")?.status).toBe("verified");
    expect(body.apps.map((a) => a.id)).toEqual(expect.arrayContaining(["jellyfin", "immich", "qbittorrent", "jellyseerr"]));
    expect(body.stacks.map((s) => s.id)).toEqual(expect.arrayContaining(["media-server", "photo-management"]));
  });
});

describe("verify_app_outcome tool", () => {
  const exec = verifyAppOutcomeTool.execute as unknown as (input: Record<string, unknown>, opts: unknown) => Promise<Record<string, unknown>>;

  it("lists targets when called without arguments", async () => {
    const out = await exec({}, {});
    expect(out.success).toBe(false);
    expect(out.verifiableApps).toEqual(expect.arrayContaining(["sonarr", "immich"]));
  });

  it("returns a compact result with remediation for non-passing checks", async () => {
    const out = await exec({ appId: "sonarr" }, {});
    expect(out.success).toBe(true);
    expect(out.status).toBe("unknown"); // no settings in the test DB
    const checks = out.checks as Array<{ id: string; remediation?: string }>;
    expect(checks[0].id).toBe("api");
    expect(checks[0].remediation).toBeTruthy();
  });

  it("never exposes an includeActive switch (read tier)", () => {
    const schema = verifyAppOutcomeTool.inputSchema as unknown as { shape: Record<string, unknown> };
    expect(Object.keys(schema.shape)).not.toContain("includeActive");
  });

  it("reports unknown targets", async () => {
    const out = await exec({ stackId: "developer-lab" }, {});
    expect(out.success).toBe(false);
    expect(String(out.error)).toContain("developer-lab");
  });
});
