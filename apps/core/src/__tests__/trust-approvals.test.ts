import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  const dir = process.env.TMPDIR || "/tmp";
  process.env.DATABASE_PATH = `${dir}/talome-trust-approvals-${process.pid}-${Date.now()}/talome.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
});

const { writeNotification } = vi.hoisted(() => ({ writeNotification: vi.fn() }));
vi.mock("../db/notifications.js", () => ({ writeNotification }));

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { setSetting } from "../utils/settings.js";
import { executeTool, type Actor } from "../ai/execution.js";
import { gateToolExecution } from "../ai/tool-gateway.js";
import { approvals } from "../routes/approvals.js";
import { canonicalizeArgs, consumeApproval, decideApproval, hashArgs } from "../approval/approvals.js";
import { FULL_ACCESS_SCOPES } from "../approval/grants.js";
import { fakeTools, registerFakeDomains, toolCalls } from "./helpers/trust-fixtures.js";

const tokenA: Actor = { kind: "mcp_token", id: "tok-a", label: "Token A", scopes: FULL_ACCESS_SCOPES };
const tokenB: Actor = { kind: "mcp_token", id: "tok-b", label: "Token B", scopes: FULL_ACCESS_SCOPES };

beforeAll(() => {
  runMigrations();
  registerFakeDomains();
});

beforeEach(() => {
  setSetting("security_mode", "cautious");
  toolCalls.length = 0;
  writeNotification.mockClear();
});

function adminApp() {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("sessionRole" as never, "admin" as never);
    c.set("sessionUser" as never, "user-1" as never);
    c.set("sessionUsername" as never, "owner" as never);
    await next();
  });
  a.route("/approvals", approvals);
  return a;
}

async function requestUninstall(actor: Actor, appId = "sonarr") {
  const r = await executeTool({ actor, source: "mcp", toolName: "uninstall_app", args: { appId } });
  expect(r.outcome).toBe("approval_required");
  return r.approval!;
}

async function approve(id: string) {
  const res = await adminApp().request(`/approvals/${id}/approve`, { method: "POST" });
  expect(res.status).toBe(200);
}

function uninstallCount() {
  return toolCalls.filter((c) => c.tool === "uninstall_app").length;
}

describe("canonical args hashing", () => {
  it("is key-order independent and ignores approval_id / confirmed", () => {
    expect(canonicalizeArgs({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalizeArgs({ a: { c: 3, d: 2 }, b: 1 }));
    expect(hashArgs({ appId: "x", confirmed: true, approval_id: "apr_1" })).toBe(hashArgs({ appId: "x" }));
    expect(hashArgs({ appId: "x" })).not.toBe(hashArgs({ appId: "y" }));
  });
});

describe("server-issued approvals", () => {
  it("creates a pending approval + notification instead of executing", async () => {
    const approval = await requestUninstall(tokenA);
    expect(approval.approvalStatus).toBe("pending");
    expect(approval.approveUrl).toBe(`/dashboard/settings/approvals?id=${approval.approvalId}`);
    expect(approval.instructions).toContain("approval_id");
    expect(uninstallCount()).toBe(0);
    expect(writeNotification).toHaveBeenCalledTimes(1);
    expect(writeNotification.mock.calls[0]?.[3]).toBe(`approval:${approval.approvalId}`);

    // Retrying without approval_id reuses the open request (no spam)
    const again = await requestUninstall(tokenA);
    expect(again.approvalId).toBe(approval.approvalId);
    expect(writeNotification).toHaveBeenCalledTimes(1);
  });

  it("a model-supplied confirmed:true is not approval", async () => {
    const r = await executeTool({ actor: tokenA, source: "mcp", toolName: "uninstall_app", args: { appId: "radarr", confirmed: true } });
    expect(r.outcome).toBe("approval_required");
    expect(uninstallCount()).toBe(0);
  });

  it("pending (not yet approved) approvals are rejected", async () => {
    const approval = await requestUninstall(tokenA, "lidarr");
    const r = await executeTool({ actor: tokenA, source: "mcp", toolName: "uninstall_app", args: { appId: "lidarr", approval_id: approval.approvalId } });
    expect(r.outcome).toBe("blocked");
    expect(r.error?.code).toBe("approval_invalid");
    expect(r.error?.message).toContain("not been approved");
    expect(uninstallCount()).toBe(0);
  });

  it("executes exactly once after approval; replay is rejected", async () => {
    const approval = await requestUninstall(tokenA, "bazarr");
    await approve(approval.approvalId);

    const ok = await executeTool({ actor: tokenA, source: "mcp", toolName: "uninstall_app", args: { appId: "bazarr", approval_id: approval.approvalId } });
    expect(ok.outcome).toBe("success");
    expect(uninstallCount()).toBe(1);
    // approval_id is stripped; the tool's legacy confirmed flag is satisfied by the server approval
    expect(toolCalls[0]?.args).toEqual({ appId: "bazarr", confirmed: true });

    const replay = await executeTool({ actor: tokenA, source: "mcp", toolName: "uninstall_app", args: { appId: "bazarr", approval_id: approval.approvalId } });
    expect(replay.outcome).toBe("blocked");
    expect(replay.error?.message).toContain("single-use");
    expect(uninstallCount()).toBe(1);

    const row = db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.approvalId)).get();
    expect(row?.status).toBe("consumed");
    expect(row?.decidedBy).toBe("owner");
  });

  it("concurrent retries with one approval execute once", async () => {
    const approval = await requestUninstall(tokenA, "readarr");
    await approve(approval.approvalId);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        executeTool({ actor: tokenA, source: "mcp", toolName: "uninstall_app", args: { appId: "readarr", approval_id: approval.approvalId } }),
      ),
    );
    expect(results.filter((r) => r.outcome === "success")).toHaveLength(1);
    expect(uninstallCount()).toBe(1);
  });

  it("rejects mismatched args", async () => {
    const approval = await requestUninstall(tokenA, "plex");
    await approve(approval.approvalId);
    const r = await executeTool({ actor: tokenA, source: "mcp", toolName: "uninstall_app", args: { appId: "jellyfin", approval_id: approval.approvalId } });
    expect(r.outcome).toBe("blocked");
    expect(r.error?.message).toContain("arguments differ");
    expect(uninstallCount()).toBe(0);
  });

  it("rejects an approval presented by another actor", async () => {
    const approval = await requestUninstall(tokenA, "overseerr");
    await approve(approval.approvalId);
    const r = await executeTool({ actor: tokenB, source: "mcp", toolName: "uninstall_app", args: { appId: "overseerr", approval_id: approval.approvalId } });
    expect(r.outcome).toBe("blocked");
    expect(r.error?.message).toContain("different agent");
    expect(uninstallCount()).toBe(0);
    // ...and the rightful actor can still use it
    const ok = await executeTool({ actor: tokenA, source: "mcp", toolName: "uninstall_app", args: { appId: "overseerr", approval_id: approval.approvalId } });
    expect(ok.outcome).toBe("success");
  });

  it("rejects an approval for a different tool", async () => {
    const approval = await requestUninstall(tokenA, "tautulli");
    await approve(approval.approvalId);
    const r = consumeApproval({ approvalId: approval.approvalId, actor: tokenA, tool: "restart_app", argsHash: hashArgs({ appId: "tautulli" }) });
    expect(r).toEqual({ ok: false, reason: "tool_mismatch" });
  });

  it("rejects expired approvals and refuses to approve them", async () => {
    const approval = await requestUninstall(tokenA, "prowlarr");
    await approve(approval.approvalId);
    db.update(schema.approvals)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(schema.approvals.id, approval.approvalId))
      .run();
    const r = await executeTool({ actor: tokenA, source: "mcp", toolName: "uninstall_app", args: { appId: "prowlarr", approval_id: approval.approvalId } });
    expect(r.outcome).toBe("blocked");
    expect(r.error?.message).toContain("expired");
    expect(uninstallCount()).toBe(0);

    const pending = await requestUninstall(tokenA, "sabnzbd");
    db.update(schema.approvals)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(schema.approvals.id, pending.approvalId))
      .run();
    const res = await adminApp().request(`/approvals/${pending.approvalId}/approve`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("denied approvals cannot be used", async () => {
    const approval = await requestUninstall(tokenA, "nzbget");
    const res = await adminApp().request(`/approvals/${approval.approvalId}/deny`, { method: "POST" });
    expect(res.status).toBe(200);
    const r = await executeTool({ actor: tokenA, source: "mcp", toolName: "uninstall_app", args: { appId: "nzbget", approval_id: approval.approvalId } });
    expect(r.error?.message).toContain("denied");
    expect(decideApproval(approval.approvalId, "approved", "x")).toEqual({ ok: false, reason: "not_pending" });
  });

  it("approval routes are admin-only and list pending requests", async () => {
    const approval = await requestUninstall(tokenA, "immich");
    const member = new Hono();
    member.use("*", async (c, next) => {
      c.set("sessionRole" as never, "member" as never);
      await next();
    });
    member.route("/approvals", approvals);
    expect((await member.request(`/approvals/${approval.approvalId}/approve`, { method: "POST" })).status).toBe(403);
    expect((await member.request("/approvals")).status).toBe(403);

    const list = (await (await adminApp().request("/approvals?status=pending")).json()) as Array<{ id: string; actor: { id: string } }>;
    const item = list.find((a) => a.id === approval.approvalId);
    expect(item?.actor.id).toBe("tok-a");
  });

  it("permissive mode executes destructive calls directly", async () => {
    setSetting("security_mode", "permissive");
    const r = await executeTool({ actor: tokenA, source: "mcp", toolName: "uninstall_app", args: { appId: "freshrss" } });
    expect(r.outcome).toBe("success");
    expect(uninstallCount()).toBe(1);
  });

  it("locked mode blocks destructive calls even with an approval", async () => {
    const approval = await requestUninstall(tokenA, "paperless");
    await approve(approval.approvalId);
    setSetting("security_mode", "locked");
    const r = await executeTool({ actor: tokenA, source: "mcp", toolName: "uninstall_app", args: { appId: "paperless", approval_id: approval.approvalId } });
    expect(r.outcome).toBe("blocked");
    expect(r.error?.code).toBe("locked");
    expect(uninstallCount()).toBe(0);
  });

  it("protected settings require approval in cautious mode", async () => {
    const r = await executeTool({ actor: tokenA, source: "mcp", toolName: "set_setting", args: { key: "security_mode", value: "permissive" } });
    expect(r.outcome).toBe("approval_required");
    const normal = await executeTool({ actor: tokenA, source: "mcp", toolName: "set_setting", args: { key: "media_root", value: "/m" } });
    expect(normal.outcome).toBe("success");
  });
});

describe("chat gateway goes through the same service", () => {
  it("returns a structured approval request to the model and accepts approval_id", async () => {
    const gated = gateToolExecution(fakeTools.uninstall_app, "uninstall_app", "destructive", "cautious") as unknown as {
      execute: (args: unknown, opts: unknown) => Promise<Record<string, unknown>>;
      inputSchema: { safeParse: (v: unknown) => { success: boolean; data?: Record<string, unknown> } };
    };
    // approval_id survives schema validation
    expect(gated.inputSchema.safeParse({ appId: "x", approval_id: "apr_1" }).data?.approval_id).toBe("apr_1");

    const first = await gated.execute({ appId: "gitea", confirmed: true }, { toolCallId: "t1", messages: [] });
    expect(first.status).toBe("approval_required");
    expect(typeof first.error).toBe("string");
    expect(uninstallCount()).toBe(0);

    await approve(String(first.approvalId));
    const second = await gated.execute({ appId: "gitea", approval_id: first.approvalId }, { toolCallId: "t2", messages: [] });
    expect(second).toEqual({ success: true, appId: "gitea" });
    expect(uninstallCount()).toBe(1);

    const audit = db.select().from(schema.auditLog).where(eq(schema.auditLog.source, "chat")).all();
    expect(audit.some((e) => e.outcome === "approval_required" && e.actorKind === "user")).toBe(true);
    expect(audit.some((e) => e.outcome === "success" && e.toolName === "uninstall_app")).toBe(true);
  });

  it("keeps chat semantics: raw results, {error} for locked blocks, rethrow on throw", async () => {
    const read = gateToolExecution(fakeTools.list_things, "list_things", "read", "locked") as unknown as {
      execute: (a: unknown, o: unknown) => Promise<unknown>;
    };
    expect(await read.execute({}, {})).toEqual({ items: ["a", "b"] });

    const modify = gateToolExecution(fakeTools.restart_app, "restart_app", "modify", "locked") as unknown as {
      execute: (a: unknown, o: unknown) => Promise<{ error?: string }>;
    };
    expect((await modify.execute({ appId: "x" }, {})).error).toContain('"locked"');

    const thrower = gateToolExecution(fakeTools.throwing_tool, "throwing_tool", "read", "permissive") as unknown as {
      execute: (a: unknown, o: unknown) => Promise<unknown>;
    };
    await expect(thrower.execute({}, {})).rejects.toThrow("exploded");
  });
});
