import { describe, it, expect, vi, afterAll } from "vitest";
import { Hono } from "hono";
import { prepareBackupEnv, installFakeApp, resetDocker } from "./helpers/backups-fixture.js";

vi.mock("../backup/docker-ops.js", async () => (await import("./helpers/backups-fixture.js")).dockerOpsMock());
vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

const env = prepareBackupEnv("backups-routes");
const { runMigrations } = await import("../db/migrate.js");
runMigrations();
const { backups } = await import("../routes/backups.js");
const { createAppBackup } = await import("../backup/engine.js");

afterAll(() => env.cleanup());

function makeApp(role: "admin" | "member") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionRole" as never, role as never);
    await next();
  });
  app.route("/api/backups", backups);
  return app;
}
const admin = makeApp("admin");
const member = makeApp("member");

const COMPOSE = `services:
  web:
    image: example/web:1
    volumes:
      - ./config:/config
  db:
    image: postgres:16
    volumes:
      - ./pgdata:/var/lib/postgresql/data
`;

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("backups routes", () => {
  it("lists apps with method, databases and last backup", async () => {
    await installFakeApp(env.root, "routeapp", COMPOSE, { "config/a.txt": "a", "pgdata/PG_VERSION": "16" });
    resetDocker([
      { id: "rw", name: "routeapp-web", service: "web", image: "example/web:1" },
      { id: "rd", name: "routeapp-db", service: "db", image: "postgres:16" },
    ]);
    const backup = await createAppBackup("routeapp");
    expect(backup.success).toBe(true);

    const res = await admin.request("/api/backups/apps");
    expect(res.status).toBe(200);
    const apps = (await res.json()) as Array<Record<string, any>>;
    const entry = apps.find((a) => a.appId === "routeapp")!;
    expect(entry.effectiveMethod).toBe("dump");
    expect(entry.databases).toEqual([{ service: "db", engine: "postgres" }]);
    expect(entry.lastSuccessfulBackup.method).toBe("dump");
    expect(entry.lastSuccessfulBackup.hasManifest).toBe(true);
    expect(entry.config.method).toBe("auto");

    const detail = await (await admin.request("/api/backups/apps/routeapp")).json();
    expect(detail.backups[0].id).toBe(backup.success ? backup.backupId : "");
    expect(detail.volumes.length).toBe(2);
  });

  it("validates and saves per-app config", async () => {
    const bad = await admin.request("/api/backups/apps/routeapp/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "yolo" }) });
    expect(bad.status).toBe(400);
    const ok = await admin.request("/api/backups/apps/routeapp/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "stop", excludePatterns: ["cache/"] }),
    });
    expect(ok.status).toBe(200);
    const cfg = await (await admin.request("/api/backups/apps/routeapp/config")).json();
    expect(cfg).toMatchObject({ method: "stop", excludePatterns: ["cache/"], includeVolumes: null });
  });

  it("requires explicit confirmation and admin role for restores", async () => {
    const backupId = (await (await admin.request("/api/backups/apps/routeapp")).json()).backups[0].id as string;
    expect((await admin.request(`/api/backups/${backupId}/restore`, json({}))).status).toBe(400);
    expect((await member.request(`/api/backups/${backupId}/restore`, json({ confirm: true }))).status).toBe(403);
    expect((await admin.request(`/api/backups/nope/restore`, json({ confirm: true }))).status).toBe(404);
  });

  it("verifies synchronously with ?wait=true and exposes the result", async () => {
    const id = (await (await admin.request("/api/backups/apps/routeapp")).json()).backups[0].id;
    const res = await admin.request(`/api/backups/${id}/verify?wait=true`, { method: "POST" });
    const body = await res.json();
    expect(body.status).toBe("verified");
    const status = await (await admin.request(`/api/backups/${id}/verification`)).json();
    expect(status.verifyStatus).toBe("verified");
    expect(status.detail.checks.length).toBeGreaterThan(0);
    const manifest = await (await admin.request(`/api/backups/${id}/manifest`)).json();
    expect(manifest.method).toBe("dump");
    expect(manifest.fileCount).toBeGreaterThan(0);
    expect(manifest.files).toBeUndefined();
  });

  it("validates schedules and keeps the existing response shape", async () => {
    expect((await admin.request("/api/backups/schedules", json({ cron: "not a cron" }))).status).toBe(400);
    const res = await admin.request("/api/backups/schedules", json({ cron: "0 2 * * *", appId: "routeapp", keepLast: 5, keepDaily: 7 }));
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).toMatchObject({ cron: "0 2 * * *", retentionDays: 30 });
    const patched = await admin.request(`/api/backups/schedules/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false, keepWeekly: 4 }),
    });
    expect(await patched.json()).toMatchObject({ enabled: 0, keep_last: 5, keep_daily: 7, keep_weekly: 4 });
  });

  it("deletes backups through the engine", async () => {
    const id = (await (await admin.request("/api/backups/apps/routeapp")).json()).backups[0].id;
    expect((await admin.request(`/api/backups/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await admin.request(`/api/backups/${id}`, { method: "DELETE" })).status).toBe(404);
  });
});
