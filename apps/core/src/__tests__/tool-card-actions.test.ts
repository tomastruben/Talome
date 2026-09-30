import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { Hono } from "hono";
import { desc } from "drizzle-orm";

const { tempDir, restartCalls, revertCalls } = vi.hoisted(() => {
  const dir = `${process.cwd()}/data/test-tool-actions-${process.pid}-${Date.now()}`;
  process.env.DATABASE_PATH = `${dir}/talome.db`;
  return { tempDir: dir, restartCalls: [] as unknown[], revertCalls: [] as unknown[] };
});

vi.mock("../ai/tool-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai/tool-registry.js")>();
  const { tool: makeTool } = await import("ai");
  const { z: zod } = await import("zod");
  const restart = makeTool({
    description: "restart",
    inputSchema: zod.object({ containerId: zod.string() }),
    execute: async (args: { containerId: string }) => {
      restartCalls.push(args);
      return { success: true, containerId: args.containerId };
    },
  });
  const revert = makeTool({
    description: "revert",
    inputSchema: zod.object({ key: zod.string(), approval_id: zod.string().optional() }),
    execute: async (args: { key: string }) => {
      revertCalls.push(args);
      return { success: true, key: args.key };
    },
  });
  return { ...actual, getActiveRegisteredTools: () => ({ restart_container: restart, revert_setting: revert }) };
});

import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { setSetting } from "../utils/settings.js";
import { toolActions } from "../routes/tool-actions.js";
import { decideApproval } from "../approval/approvals.js";

function appAs(role: "admin" | "member", permissions?: Record<string, boolean>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionUser" as never, role === "admin" ? "admin-id" as never : "member-id" as never);
    c.set("sessionUsername" as never, role === "admin" ? "owner" as never : "kid" as never);
    c.set("sessionRole" as never, role as never);
    await next();
  });
  if (permissions) {
    db.insert(schema.users).values({
      id: "member-id", username: "kid", passwordHash: "x", role: "member",
      permissions: JSON.stringify(permissions), createdAt: new Date().toISOString(),
    }).onConflictDoUpdate({ target: schema.users.id, set: { permissions: JSON.stringify(permissions) } }).run();
  }
  app.route("/", toolActions);
  return app;
}

function post(app: Hono, body: unknown) {
  return app.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

beforeAll(() => runMigrations());
beforeEach(() => {
  restartCalls.length = 0;
  revertCalls.length = 0;
  setSetting("security_mode", "cautious");
});
afterAll(() => {
  delete process.env.DATABASE_PATH;
  try { db.$client.close(); } catch { /* already closed */ }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("POST /api/chat/actions (P0-6)", () => {
  it("runs a card action through executeTool and audits it as the session user", async () => {
    const res = await post(appAs("admin"), { tool: "restart_container", args: { containerId: "sonarr" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { outcome: string; tier: string; result: unknown };
    expect(body).toMatchObject({ outcome: "success", tier: "modify", result: { success: true, containerId: "sonarr" } });
    expect(restartCalls).toEqual([{ containerId: "sonarr" }]);

    const entry = db.select().from(schema.auditLog).orderBy(desc(schema.auditLog.id)).limit(1).get();
    expect(entry).toMatchObject({ actorKind: "user", actorId: "admin-id", toolName: "restart_container", outcome: "success" });
  });

  it("honours the security mode: locked blocks the action instead of running it", async () => {
    setSetting("security_mode", "locked");
    const res = await post(appAs("admin"), { tool: "restart_container", args: { containerId: "sonarr" } });
    const body = await res.json() as { outcome: string; error?: { message: string } };
    expect(body.outcome).toBe("blocked");
    expect(body.error?.message).toBeTruthy();
    expect(restartCalls).toEqual([]);
  });

  it("validates card args against the tool's input schema before anything runs", async () => {
    const res = await post(appAs("admin"), { tool: "restart_container", args: { containerId: { $ne: "" } } });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("containerId");
    expect(restartCalls).toEqual([]);

    // Unknown keys are dropped instead of reaching execute().
    const ok = await post(appAs("admin"), { tool: "restart_container", args: { containerId: "sonarr", extra: 1 } });
    expect(ok.status).toBe(200);
    expect(restartCalls).toEqual([{ containerId: "sonarr" }]);
  });

  it("runs an action held for approval once the owner approves it and the card is pressed again", async () => {
    const app = appAs("admin");
    const first = await post(app, { tool: "revert_setting", args: { key: "security_mode" } });
    const held = await first.json() as { outcome: string; approval: { approvalId: string; approvalStatus: string } };
    expect(held.outcome).toBe("approval_required");
    expect(held.approval.approvalStatus).toBe("pending");
    expect(revertCalls).toEqual([]);

    // Still pending: pressing again keeps waiting, nothing runs.
    const again = await post(app, { tool: "revert_setting", args: { key: "security_mode" } });
    expect((await again.json() as { outcome: string }).outcome).toBe("approval_required");
    expect(revertCalls).toEqual([]);

    expect(decideApproval(held.approval.approvalId, "approved", "admin-id").ok).toBe(true);
    const approved = await post(app, { tool: "revert_setting", args: { key: "security_mode" } });
    expect((await approved.json() as { outcome: string }).outcome).toBe("success");
    expect(revertCalls).toEqual([{ key: "security_mode" }]);

    // The approval is used up: the next press asks again.
    const next = await post(app, { tool: "revert_setting", args: { key: "security_mode" } });
    expect((await next.json() as { outcome: string }).outcome).toBe("approval_required");
    expect(revertCalls).toHaveLength(1);
  });

  it("accepts only the card allow-list", async () => {
    const res = await post(appAs("admin"), { tool: "run_shell", args: { command: "rm -rf /" } });
    expect(res.status).toBe(400);
  });

  it("says so when the tool isn't available instead of failing silently", async () => {
    const res = await post(appAs("admin"), { tool: "request_media", args: { type: "movie", tmdbId: 1, title: "X" } });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toContain("request this title");
  });

  it("checks the member's feature permission and keeps settings undo admin-only", async () => {
    const noApps = await post(appAs("member", { apps: false, chat: true }), { tool: "restart_container", args: { containerId: "sonarr" } });
    expect(noApps.status).toBe(403);
    expect(restartCalls).toEqual([]);

    const withApps = await post(appAs("member", { apps: true, chat: true }), { tool: "restart_container", args: { containerId: "sonarr" } });
    expect(withApps.status).toBe(200);

    const undo = await post(appAs("member", { apps: true, chat: true }), { tool: "revert_setting", args: { key: "theme" } });
    expect(undo.status).toBe(403);
  });
});
