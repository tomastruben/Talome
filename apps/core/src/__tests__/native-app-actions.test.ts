import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { Hono } from "hono";
import { desc } from "drizzle-orm";

const { tempDir } = vi.hoisted(() => {
  const dir = `${process.cwd()}/data/test-native-actions-${process.pid}-${Date.now()}`;
  process.env.DATABASE_PATH = `${dir}/talome.db`;
  return { tempDir: dir };
});

import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { createDefaultAppSpec } from "../app-specs/schema.js";
import { saveAppSpec } from "../app-specs/service.js";
import { appSpecs } from "../routes/app-specs.js";

// Never reach a real Talome on this machine: the action's HTTP call is stubbed.
const fetchMock = vi.fn();

const app = new Hono();
app.use("*", async (c, next) => {
  c.set("sessionUser" as never, "user-1" as never);
  c.set("sessionUsername" as never, "owner" as never);
  c.set("sessionRole" as never, "admin" as never);
  await next();
});
app.route("/", appSpecs);

function run(actionId: string, body: Record<string, unknown> = {}) {
  return app.request(`/user-apps/notes/actions/${actionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  runMigrations();
  const spec = createDefaultAppSpec({ appId: "notes", name: "Notes", description: "A notes app." });
  spec.actions.push({
    id: "wipe-cache",
    label: "Clear cache",
    description: "Delete the cache.",
    kind: "talome-api",
    method: "POST",
    path: "/api/apps/user-apps/notes/restart",
    destructive: true,
  });
  saveAppSpec({ storeId: "user-apps", spec, status: "approved" });
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.DATABASE_PATH;
  try { db.$client.close(); } catch { /* already closed */ }
  rmSync(tempDir, { recursive: true, force: true });
});

function lastAudit() {
  return db.select().from(schema.auditLog).orderBy(desc(schema.auditLog.id)).limit(1).get();
}

describe("native app actions", () => {
  it("refuses a destructive action until it is confirmed, even without a declared confirmation", async () => {
    const res = await run("wipe-cache");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, requiresConfirmation: true, tier: "destructive" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs a confirmed action and audits it under the session user with its tier", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const res = await run("wipe-cache", { confirmed: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, tier: "destructive" });
    expect(lastAudit()).toMatchObject({
      action: "app_spec_action:wipe-cache",
      tier: "destructive",
      actorKind: "user",
      actorId: "user-1",
      source: "native_app",
      outcome: "success",
    });
  });

  it("audits a failed action as an error by the same user", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const res = await run("restart-service", { confirmed: true });
    expect(res.status).toBe(500);
    expect(lastAudit()).toMatchObject({
      action: "app_spec_action:restart-service",
      tier: "modify",
      actorId: "user-1",
      outcome: "error",
    });
  });
});

describe("run_native_app_action tier", () => {
  it("is destructive for an action the AppSpec marks destructive", async () => {
    const { getEffectiveTier } = await import("../ai/execution.js");
    expect(getEffectiveTier("run_native_app_action", { appId: "notes", actionId: "wipe-cache" }, "modify")).toBe("destructive");
    expect(getEffectiveTier("run_native_app_action", { appId: "notes", actionId: "restart-service" }, "modify")).toBe("modify");
  });
});
