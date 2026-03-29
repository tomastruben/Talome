import { Hono } from "hono";
import { z } from "zod";
import { setCookie, deleteCookie } from "hono/cookie";
import { hash as bcryptHash, compare as bcryptCompare } from "bcryptjs";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { createSessionToken, SESSION_COOKIE, verifySessionToken, revokeSession } from "../middleware/session.js";
import { getCookie } from "hono/cookie";
import { randomUUID, randomBytes } from "node:crypto";
import type { UserPermissions } from "@talome/types";
import { getDefaultPermissions } from "@talome/types";

const auth = new Hono();

const loginSchema = z.object({
  username: z.string().max(100).optional(),
  password: z.string().min(1).max(500),
});

const recoverSchema = z.object({
  username: z.string().min(1).max(100),
  recoveryCode: z.string().min(1).max(100),
  newPassword: z.string().min(8).max(500),
});

/** Generate a 24-character alphanumeric recovery code (URL-safe, easy to copy). */
export function generateRecoveryCode(): string {
  return randomBytes(18).toString("base64url").slice(0, 24);
}

const BCRYPT_ROUNDS = 12;

function hasAnyUsers(): boolean {
  try {
    const row = db.select().from(schema.users).limit(1).get();
    return !!row;
  } catch {
    return false;
  }
}

/** POST /api/auth/login — { username: string, password: string } */
auth.post("/login", async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid credentials" }, 400);
  const { username, password } = parsed.data;

  const isFirstTime = !hasAnyUsers();

  if (isFirstTime) {
    // First-time setup: create the admin account
    if (password.length < 8) {
      return c.json({ error: "Password must be at least 8 characters" }, 400);
    }
    const name = username?.trim() || "admin";
    if (name.length < 2) {
      return c.json({ error: "Username must be at least 2 characters" }, 400);
    }
    const newHash = await bcryptHash(password, BCRYPT_ROUNDS);
    const userId = randomUUID();
    const now = new Date().toISOString();

    // Generate recovery code for password reset
    const recoveryCode = generateRecoveryCode();
    const recoveryHash = await bcryptHash(recoveryCode, BCRYPT_ROUNDS);

    db.insert(schema.users)
      .values({ id: userId, username: name, passwordHash: newHash, role: "admin", recoveryCodeHash: recoveryHash, createdAt: now })
      .run();

    // Also store in settings for backward compatibility
    db.insert(schema.settings)
      .values({ key: "admin_password_hash", value: newHash })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: newHash } })
      .run();

    const token = await createSessionToken(userId, "admin", name);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Strict",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });

    return c.json({ ok: true, setup: true, recoveryCode });
  }

  // Normal login: look up user by username
  const name = username?.trim() || "admin";
  const user = db.select().from(schema.users).where(eq(schema.users.username, name)).get();

  if (!user) {
    return c.json({ error: "Invalid username or password" }, 401);
  }

  const valid = await bcryptCompare(password, user.passwordHash);
  if (!valid) {
    return c.json({ error: "Invalid username or password" }, 401);
  }

  // Update last login
  db.update(schema.users)
    .set({ lastLoginAt: new Date().toISOString() })
    .where(eq(schema.users.id, user.id))
    .run();

  const token = await createSessionToken(user.id, user.role as "admin" | "member", user.username);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Strict",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });

  return c.json({ ok: true, setup: false });
});

/** POST /api/auth/logout */
auth.post("/logout", (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) revokeSession(token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

/** GET /api/auth/me — returns current user info */
auth.get("/me", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    return c.json({ authenticated: false });
  }

  const payload = await verifySessionToken(token);
  if (!payload) {
    return c.json({ authenticated: false });
  }

  const user = db.select().from(schema.users).where(eq(schema.users.id, payload.sub)).get();
  if (!user) {
    // JWT is valid but user row not found — likely a session from before
    // the users table existed. Fall back to JWT claims.
    return c.json({
      authenticated: true,
      userId: payload.sub,
      username: payload.username ?? "admin",
      role: payload.role ?? "admin",
      permissions: getDefaultPermissions(),
    });
  }

  let permissions: UserPermissions = getDefaultPermissions();
  if (user.role !== "admin" && user.permissions) {
    try {
      permissions = JSON.parse(user.permissions) as UserPermissions;
    } catch {
      // Malformed JSON — use defaults
    }
  }

  return c.json({
    authenticated: true,
    userId: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    permissions,
  });
});

/**
 * GET /api/auth/verify — forward-auth endpoint for Caddy reverse proxy.
 *
 * Caddy sends the original request headers (including cookies) via
 * `forward_auth`. If the session is valid, return 200 with user info
 * headers that Caddy copies to the upstream request. If invalid, return 401
 * and Caddy will block the request.
 */
auth.get("/verify", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    return c.body(null, 401);
  }

  const payload = await verifySessionToken(token);
  if (!payload) {
    return c.body(null, 401);
  }

  // Return user info as headers — Caddy copies these to the upstream request
  c.header("X-Talome-User", payload.username ?? payload.sub);
  c.header("X-Talome-Role", payload.role ?? "admin");
  return c.body(null, 200);
});

/** POST /api/auth/recover — reset password using a recovery code */
auth.post("/recover", async (c) => {
  const parsed = recoverSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
  const { username, recoveryCode, newPassword } = parsed.data;

  const user = db.select().from(schema.users).where(eq(schema.users.username, username)).get();
  if (!user || !user.recoveryCodeHash) {
    // Don't reveal whether the user exists
    return c.json({ error: "Invalid username or recovery code" }, 401);
  }

  const valid = await bcryptCompare(recoveryCode, user.recoveryCodeHash);
  if (!valid) {
    return c.json({ error: "Invalid username or recovery code" }, 401);
  }

  // Recovery code is single-use — set new password and generate a new code
  const newPasswordHash = await bcryptHash(newPassword, BCRYPT_ROUNDS);
  const newRecoveryCode = generateRecoveryCode();
  const newRecoveryHash = await bcryptHash(newRecoveryCode, BCRYPT_ROUNDS);

  db.update(schema.users)
    .set({
      passwordHash: newPasswordHash,
      recoveryCodeHash: newRecoveryHash,
      lastLoginAt: new Date().toISOString(),
    })
    .where(eq(schema.users.id, user.id))
    .run();

  // Log the user in
  const token = await createSessionToken(user.id, user.role as "admin" | "member", user.username);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Strict",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });

  return c.json({ ok: true, newRecoveryCode });
});

/** GET /api/auth/status — unauthenticated probe: is any user configured? */
auth.get("/status", (c) => {
  const configured = hasAnyUsers();
  return c.json({ passwordConfigured: configured });
});

export { auth };
