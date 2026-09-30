/**
 * E2E bug 2: sessions of demoted or deleted users kept their JWT role until
 * the token expired (7 days) — a demoted admin could still list users and
 * mint destructive MCP tokens, and a deleted user's session still worked.
 *
 * requireSession now re-reads the user on every request (role from the DB,
 * missing user -> 401) and checks a per-user session version that role
 * changes and password resets bump. MCP tokens a deleted admin created are
 * revoked; a demotion (one switch in the dashboard, easily undone) never
 * revokes — revocation is permanent — it reports the tokens instead.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

vi.hoisted(() => {
  const dir = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  process.env.DATABASE_PATH = `${dir}/talome-session-revocation-${process.pid}-${Date.now()}.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
});

vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

import { Hono } from "hono";
import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { requireSession, createSessionToken, verifySessionToken, SESSION_COOKIE } from "../middleware/session.js";
import { requireRole } from "../middleware/role-guard.js";
import { users } from "../routes/users.js";
import { auth } from "../routes/auth.js";
import { mcpTokens } from "../routes/mcp-tokens.js";

function buildApp(): Hono {
  const app = new Hono();
  app.use("/api/*", requireSession);
  app.use("/api/users/*", requireRole("admin"));
  app.route("/api/auth", auth);
  app.route("/api/users", users);
  app.route("/api/integrations/mcp/tokens", mcpTokens);
  return app;
}

function insertUser(role: "admin" | "member"): { id: string; username: string } {
  const id = randomUUID();
  const username = `${role}-${id.slice(0, 8)}`;
  db.insert(schema.users)
    .values({ id, username, passwordHash: "x", role, createdAt: new Date().toISOString() })
    .run();
  return { id, username };
}

async function cookieFor(user: { id: string; username: string }, role: "admin" | "member"): Promise<string> {
  return `${SESSION_COOKIE}=${await createSessionToken(user.id, role, user.username)}`;
}

const JSON_HEADERS = { "content-type": "application/json" };

async function createToken(app: Hono, cookie: string, name: string) {
  return app.request("/api/integrations/mcp/tokens", {
    method: "POST",
    headers: { ...JSON_HEADERS, cookie },
    body: JSON.stringify({ name, scopes: { maxTier: "destructive", domains: "all", apps: "all" } }),
  });
}

function tokenRow(name: string) {
  return db.select().from(schema.mcpTokens).where(eq(schema.mcpTokens.name, name)).get();
}

beforeAll(() => {
  runMigrations();
});

describe("session re-validation against the users table", () => {
  it("a demoted admin's session loses admin access immediately (role read from the DB)", async () => {
    const app = buildApp();
    const bob = insertUser("admin");
    const cookie = await cookieFor(bob, "admin");
    expect((await app.request("/api/users", { headers: { cookie } })).status).toBe(200);

    // Demotion written straight to the DB (no session-version bump): the
    // stale "admin" claim in the JWT must not matter.
    db.update(schema.users).set({ role: "member" }).where(eq(schema.users.id, bob.id)).run();

    expect((await app.request("/api/users", { headers: { cookie } })).status).toBe(403);
    const minted = await createToken(app, cookie, "demoted-token");
    expect(minted.status).toBe(403);
    expect(tokenRow("demoted-token")).toBeUndefined();
  });

  it("a deleted user's session is rejected with 401 and /api/auth/me says unauthenticated", async () => {
    const app = buildApp();
    const carol = insertUser("admin");
    const cookie = await cookieFor(carol, "admin");
    expect((await app.request("/api/users", { headers: { cookie } })).status).toBe(200);

    db.delete(schema.users).where(eq(schema.users.id, carol.id)).run();

    expect((await app.request("/api/users", { headers: { cookie } })).status).toBe(401);
    expect((await createToken(app, cookie, "ghost-token")).status).toBe(401);
    expect(tokenRow("ghost-token")).toBeUndefined();
    const me = (await (await app.request("/api/auth/me", { headers: { cookie } })).json()) as { authenticated: boolean };
    expect(me.authenticated).toBe(false);
  });

  it("a token without a role claim gets the user's DB role, never admin by default", async () => {
    const app = buildApp();
    const dave = insertUser("member");
    const token = await new SignJWT({ sub: dave.id, username: dave.username })
      .setProtectedHeader({ alg: "HS256" })
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.TALOME_SECRET));
    const payload = await verifySessionToken(token);
    expect(payload?.role).toBe("member");
    expect((await app.request("/api/users", { headers: { cookie: `${SESSION_COOKIE}=${token}` } })).status).toBe(403);
  });

  it("tokens issued before session versions existed (no sv claim) stay valid at version 0", async () => {
    const erin = insertUser("admin");
    const token = await new SignJWT({ sub: erin.id, role: "admin", username: erin.username })
      .setProtectedHeader({ alg: "HS256" })
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.TALOME_SECRET));
    expect((await verifySessionToken(token))?.role).toBe("admin");
  });
});

describe("users routes end sessions; deleting a user revokes their MCP tokens", () => {
  it("PUT role change ends the target's sessions but keeps (and reports) tokens the demoted admin created", async () => {
    const app = buildApp();
    const owner = insertUser("admin");
    const ownerCookie = await cookieFor(owner, "admin");
    const frank = insertUser("admin");
    const frankCookie = await cookieFor(frank, "admin");

    expect((await createToken(app, frankCookie, "frank-token")).status).toBe(200);
    expect(tokenRow("frank-token")?.createdBy).toBe(frank.id);
    expect((await createToken(app, ownerCookie, "owner-token")).status).toBe(200);

    const res = await app.request(`/api/users/${frank.id}`, {
      method: "PUT",
      headers: { ...JSON_HEADERS, cookie: ownerCookie },
      body: JSON.stringify({ role: "member" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, activeMcpTokens: ["frank-token"] });

    // Frank's existing session is over (even for member-level routes).
    expect((await app.request("/api/auth/me", { headers: { cookie: frankCookie } })).status).toBe(200);
    const me = (await (await app.request("/api/auth/me", { headers: { cookie: frankCookie } })).json()) as {
      authenticated: boolean;
    };
    expect(me.authenticated).toBe(false);
    expect((await app.request("/api/users", { headers: { cookie: frankCookie } })).status).toBe(401);

    // A demotion never revokes (revocation cannot be undone): tokens stay live.
    expect(tokenRow("frank-token")?.revokedAt).toBeNull();
    expect(tokenRow("owner-token")?.revokedAt).toBeNull();

    // A fresh login gets the new role.
    const fresh = await cookieFor(frank, "member");
    expect((await verifySessionToken(fresh.split("=")[1]!))?.role).toBe("member");
    expect((await app.request("/api/users", { headers: { cookie: fresh } })).status).toBe(403);

    const audit = db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "user_role_changed")).all();
    const row = audit.find((r) => r.details.includes(frank.id));
    expect(row?.actorId).toBe(owner.id);
    expect(row?.actorLabel).toBe(owner.username);
    expect(row?.source).toBe("dashboard");
    expect(row?.details).toContain("stay active (frank-token)");
  });

  it("demote then re-promote (a misclick undone) leaves the admin's tokens and automations working", async () => {
    const app = buildApp();
    const owner = insertUser("admin");
    const ownerCookie = await cookieFor(owner, "admin");
    const ivy = insertUser("admin");
    const ivyCookie = await cookieFor(ivy, "admin");
    expect((await createToken(app, ivyCookie, "ivy-token")).status).toBe(200);
    const tokenId = tokenRow("ivy-token")!.id;
    const automationId = randomUUID();
    db.insert(schema.automations)
      .values({
        id: automationId,
        name: "ivy automation",
        trigger: JSON.stringify({ type: "schedule", cron: "0 * * * *" }),
        actions: "[]",
        actorTokenId: tokenId,
        createdAt: new Date().toISOString(),
      })
      .run();

    for (const role of ["member", "admin"]) {
      const res = await app.request(`/api/users/${ivy.id}`, {
        method: "PUT",
        headers: { ...JSON_HEADERS, cookie: ownerCookie },
        body: JSON.stringify({ role }),
      });
      expect(res.status).toBe(200);
    }

    // The token is live, so the automation it wrote keeps running
    // (automation/engine.ts resolveAutomationGrant blocks only on revoked).
    expect(tokenRow("ivy-token")?.revokedAt).toBeNull();
    const auto = db.select().from(schema.automations).where(eq(schema.automations.id, automationId)).get();
    expect(auto?.enabled).toBe(true);
  });

  it("DELETE ends the user's sessions, revokes their tokens and attributes the audit row", async () => {
    const app = buildApp();
    const owner = insertUser("admin");
    const ownerCookie = await cookieFor(owner, "admin");
    const gina = insertUser("admin");
    const ginaCookie = await cookieFor(gina, "admin");
    expect((await createToken(app, ginaCookie, "gina-token")).status).toBe(200);
    for (const enabled of [true, false]) {
      db.insert(schema.automations)
        .values({
          id: randomUUID(),
          name: `gina automation ${enabled}`,
          trigger: JSON.stringify({ type: "schedule", cron: "0 * * * *" }),
          actions: "[]",
          enabled,
          actorTokenId: tokenRow("gina-token")!.id,
          createdAt: new Date().toISOString(),
        })
        .run();
    }

    const res = await app.request(`/api/users/${gina.id}`, {
      method: "DELETE",
      headers: { cookie: ownerCookie, origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(200);
    // The response names what the delete revoked, so the dashboard can say so.
    expect(await res.json()).toEqual({ ok: true, revokedMcpTokens: ["gina-token"], affectedAutomations: 1 });
    expect((await app.request("/api/users", { headers: { cookie: ginaCookie } })).status).toBe(401);
    expect(tokenRow("gina-token")?.revokedAt).toBeTruthy();

    const row = db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "user_deleted"))
      .all()
      .find((r) => r.details.includes(gina.id));
    expect(row?.actorKind).toBe("user");
    expect(row?.actorId).toBe(owner.id);
    expect(row?.outcome).toBe("success");
  });

  it("an admin password reset ends the user's sessions", async () => {
    const app = buildApp();
    const owner = insertUser("admin");
    const ownerCookie = await cookieFor(owner, "admin");
    const hank = insertUser("member");
    const hankCookie = await cookieFor(hank, "member");
    const hankMe = async () =>
      ((await (await app.request("/api/auth/me", { headers: { cookie: hankCookie } })).json()) as { authenticated: boolean })
        .authenticated;
    expect(await hankMe()).toBe(true);

    const res = await app.request(`/api/users/${hank.id}/reset-password`, {
      method: "POST",
      headers: { ...JSON_HEADERS, cookie: ownerCookie },
      body: JSON.stringify({ password: "a-new-password" }),
    });
    expect(res.status).toBe(200);
    expect(await hankMe()).toBe(false);
    // The admin who reset it is still signed in.
    expect((await app.request("/api/users", { headers: { cookie: ownerCookie } })).status).toBe(200);
  });
});

describe("no request can leave Talome without an admin", () => {
  async function putRole(app: Hono, cookie: string, id: string, role: "admin" | "member") {
    return app.request(`/api/users/${id}`, {
      method: "PUT",
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ role }),
    });
  }

  it("an admin cannot demote themselves over the API (the UI hides the switch)", async () => {
    const app = buildApp();
    const kim = insertUser("admin");
    insertUser("admin"); // another admin exists: self-demotion is refused anyway
    const cookie = await cookieFor(kim, "admin");
    const res = await putRole(app, cookie, kim.id, "member");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("your own admin role");
    expect(db.select().from(schema.users).where(eq(schema.users.id, kim.id)).get()?.role).toBe("admin");
    // Still signed in (no session-version bump).
    expect((await app.request("/api/users", { headers: { cookie } })).status).toBe(200);
  });

  it("the last admin can be neither demoted nor deleted", async () => {
    // Isolate: make every existing admin a member, then add exactly one.
    db.update(schema.users).set({ role: "member" }).run();
    const app = buildApp();
    const lone = insertUser("admin");
    const other = insertUser("member");
    // A session for a user who is not an admin in the DB cannot reach the
    // route at all, so drive the guard through the handler with a fake
    // admin session user that is not the target.
    const guardApp = new Hono();
    guardApp.use("*", async (c, next) => {
      c.set("sessionUser" as never, other.id as never);
      c.set("sessionUsername" as never, other.username as never);
      await next();
    });
    guardApp.route("/api/users", users);

    const put = await guardApp.request(`/api/users/${lone.id}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "member" }),
    });
    expect(put.status).toBe(400);
    expect(((await put.json()) as { error: string }).error).toContain("last admin");

    const del = await guardApp.request(`/api/users/${lone.id}`, { method: "DELETE" });
    expect(del.status).toBe(400);
    expect(((await del.json()) as { error: string }).error).toContain("last admin");
    expect(db.select().from(schema.users).where(eq(schema.users.id, lone.id)).get()?.role).toBe("admin");

    // With a second admin, demoting one of them works.
    const second = insertUser("admin");
    const cookie = await cookieFor(second, "admin");
    expect((await putRole(app, cookie, lone.id, "member")).status).toBe(200);
  });
});
