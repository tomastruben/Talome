/**
 * User management and password recovery leave an attributed audit trail,
 * and a recovery-code reset ends the user's other sessions while keeping the
 * one it signs in.
 *
 * Before: creating a user (possibly an admin), regenerating a recovery code
 * (which /api/auth/recover accepts to reset the password and sign in),
 * changing permissions, renaming a user and recovering a password wrote no
 * audit row; nothing tested /api/auth/recover's session-version bump.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

vi.hoisted(() => {
  const dir = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  process.env.DATABASE_PATH = `${dir}/talome-users-audit-${process.pid}-${Date.now()}.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
});

vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { hash as bcryptHash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { requireSession, createSessionToken, SESSION_COOKIE } from "../middleware/session.js";
import { requireRole } from "../middleware/role-guard.js";
import { users } from "../routes/users.js";
import { auth } from "../routes/auth.js";

function buildApp(): Hono {
  const app = new Hono();
  app.use("/api/*", requireSession);
  app.use("/api/users/*", requireRole("admin"));
  app.route("/api/auth", auth);
  app.route("/api/users", users);
  return app;
}

function insertUser(role: "admin" | "member", recoveryCodeHash: string | null = null): { id: string; username: string } {
  const id = randomUUID();
  const username = `${role}-${id.slice(0, 8)}`;
  db.insert(schema.users)
    .values({ id, username, passwordHash: "x", role, recoveryCodeHash, createdAt: new Date().toISOString() })
    .run();
  return { id, username };
}

async function cookieFor(user: { id: string; username: string }, role: "admin" | "member"): Promise<string> {
  return `${SESSION_COOKIE}=${await createSessionToken(user.id, role, user.username)}`;
}

const JSON_HEADERS = { "content-type": "application/json" };

function auditRows(action: string) {
  return db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action)).all();
}

async function authenticated(app: Hono, cookie: string): Promise<boolean> {
  const res = await app.request("/api/auth/me", { headers: { cookie } });
  return ((await res.json()) as { authenticated: boolean }).authenticated;
}

beforeAll(() => {
  runMigrations();
});

describe("user management writes attributed audit rows", () => {
  it("create, rename, recovery code, permissions and bulk permissions are audited as the acting admin", async () => {
    const app = buildApp();
    const owner = insertUser("admin");
    const cookie = await cookieFor(owner, "admin");

    const created = await app.request("/api/users", {
      method: "POST",
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ username: "second-admin", password: "a-long-password", role: "admin" }),
    });
    expect(created.status).toBe(201);
    const { id: newId, recoveryCode } = (await created.json()) as { id: string; recoveryCode: string };

    const member = insertUser("member");
    expect(
      (
        await app.request(`/api/users/${member.id}`, {
          method: "PUT",
          headers: { ...JSON_HEADERS, cookie },
          body: JSON.stringify({ username: "renamed-member" }),
        })
      ).status,
    ).toBe(200);

    const regenerated = await app.request(`/api/users/${newId}/recovery-code`, { method: "POST", headers: { ...JSON_HEADERS, cookie } });
    expect(regenerated.status).toBe(200);
    const newCode = ((await regenerated.json()) as { recoveryCode: string }).recoveryCode;

    expect(
      (
        await app.request(`/api/users/${member.id}/permissions`, {
          method: "PUT",
          headers: { ...JSON_HEADERS, cookie },
          body: JSON.stringify({ permissions: { apps: [] } }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/api/users/bulk-permissions", {
          method: "POST",
          headers: { ...JSON_HEADERS, cookie },
          body: JSON.stringify({ userIds: [member.id, newId], permissions: { apps: [] } }),
        })
      ).status,
    ).toBe(200);

    const expectActor = (row: typeof schema.auditLog.$inferSelect | undefined) => {
      expect(row).toBeDefined();
      expect(row).toMatchObject({ actorKind: "user", actorId: owner.id, actorLabel: owner.username, source: "dashboard", outcome: "success" });
    };

    const createdRow = auditRows("user_created").find((r) => r.details.includes(newId));
    expectActor(createdRow);
    expect(createdRow?.details).toContain("role=admin");

    const renamed = auditRows("user_updated").find((r) => r.details.includes(member.id));
    expectActor(renamed);
    expect(renamed?.details).toContain(`username ${member.username} -> renamed-member`);

    const codeRow = auditRows("user_recovery_code_regenerated").find((r) => r.details.includes(newId));
    expectActor(codeRow);
    // Never the code itself.
    for (const code of [recoveryCode, newCode]) {
      expect(db.select().from(schema.auditLog).all().some((r) => r.details.includes(code) || r.action.includes(code))).toBe(false);
    }

    const perms = auditRows("user_permissions_changed");
    expectActor(perms.find((r) => r.details.includes(member.id)));
    // Bulk: only the member was changed (admins always have full access).
    const bulk = perms.find((r) => r.details.includes("(bulk)"));
    expectActor(bulk);
    expect(bulk?.details).toContain("renamed-member");
    expect(bulk?.details).not.toContain("second-admin");
  });
});

describe("POST /api/auth/recover", () => {
  it("ends the user's other sessions, keeps the new one, and writes an audit row", async () => {
    const app = buildApp();
    const code = "RECOVERYCODE1234567890AB";
    const lena = insertUser("member", await bcryptHash(code, 4));
    const oldCookie = await cookieFor(lena, "member");
    expect(await authenticated(app, oldCookie)).toBe(true);

    const res = await app.request("/api/auth/recover", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ username: lena.username, recoveryCode: code, newPassword: "brand-new-password" }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    const newToken = setCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
    expect(newToken).toBeTruthy();

    // The session from before the reset is over; the one /recover issued works.
    expect(await authenticated(app, oldCookie)).toBe(false);
    expect(await authenticated(app, `${SESSION_COOKIE}=${newToken}`)).toBe(true);

    const row = auditRows("user_password_recovered").find((r) => r.details.includes(lena.id));
    expect(row).toMatchObject({ actorKind: "user", actorId: lena.id, actorLabel: lena.username, source: "recovery", outcome: "success" });
    expect(row?.details).not.toContain(code);
  });
});
