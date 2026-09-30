/**
 * POST /api/backups/self takes Talome's own DB snapshot through the
 * non-blocking online-backup path (snapshotNowAsync), never the synchronous one.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { Hono } from "hono";
import { prepareBackupEnv } from "./helpers/backups-fixture.js";

const selfBackup = vi.hoisted(() => ({
  snapshotNow: vi.fn(() => {
    throw new Error("synchronous snapshot must not be used by the route");
  }),
  snapshotNowAsync: vi.fn(async (): Promise<{ ok: true; path: string } | { ok: false; error: string }> => ({ ok: true, path: "/backups/talome-db-1.db" })),
}));

vi.mock("../services/self-backup.js", () => selfBackup);
vi.mock("../backup/docker-ops.js", async () => (await import("./helpers/backups-fixture.js")).dockerOpsMock());
vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

const env = prepareBackupEnv("wire-compat-self-backup");
const { runMigrations } = await import("../db/migrate.js");
runMigrations();
const { backups } = await import("../routes/backups.js");

afterAll(() => env.cleanup());

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("sessionRole" as never, "admin" as never);
  await next();
});
app.route("/api/backups", backups);

describe("POST /api/backups/self", () => {
  it("awaits the async snapshot and returns its path", async () => {
    const res = await app.request("/api/backups/self", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, path: "/backups/talome-db-1.db" });
    expect(selfBackup.snapshotNowAsync).toHaveBeenCalledTimes(1);
    expect(selfBackup.snapshotNow).not.toHaveBeenCalled();
  });

  it("reports a failed snapshot as a 500", async () => {
    selfBackup.snapshotNowAsync.mockResolvedValueOnce({ ok: false, error: "disk full" });
    const res = await app.request("/api/backups/self", { method: "POST" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "disk full" });
  });
});
