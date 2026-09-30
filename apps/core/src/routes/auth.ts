import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { setCookie, deleteCookie } from "hono/cookie";
import { hash as bcryptHash, compare as bcryptCompare } from "bcryptjs";
import { db, schema } from "../db/index.js";
import { eq, sql } from "drizzle-orm";
import {
  createSessionToken,
  revokeSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  verifySessionToken,
} from "../middleware/session.js";
import { getCookie } from "hono/cookie";
import { randomUUID, randomBytes } from "node:crypto";
import type { UserPermissions } from "@talome/types";
import { getDefaultPermissions } from "@talome/types";
import { hashInvitationToken } from "../auth/invitations.js";
import { writeAuditEntry } from "../db/audit.js";

/**
 * Produce session-cookie options that flip `secure` on automatically when
 * the request was served over HTTPS. CLAUDE.md gotcha #4: we cannot set
 * `secure: true` unconditionally because self-hosted Talome is often
 * served over HTTP on the LAN, and browsers silently drop secure cookies
 * on plain HTTP. Detecting the actual request protocol is the safe middle
 * ground — HTTPS deployments get the flag, HTTP LAN deployments don't.
 */
function sessionCookieOptions(c: Context) {
  const forwardedProto = c.req.header("x-forwarded-proto");
  const url = new URL(c.req.url);
  const isSecure =
    forwardedProto === "https" ||
    (!forwardedProto && url.protocol === "https:");
  return {
    httpOnly: true,
    secure: isSecure,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

const auth = new Hono();

const loginSchema = z.object({
  username: z.string().max(100).optional(),
  password: z.string().min(1).max(500),
});

const setupSchema = z.object({
  username: z.string().max(100).optional(),
  password: z.string().max(500).optional(),
});

const recoverSchema = z.object({
  username: z.string().min(1).max(100),
  recoveryCode: z.string().min(1).max(100),
  newPassword: z.string().min(8).max(500),
});

const acceptInvitationSchema = z.object({
  username: z.string().trim().min(2).max(100),
  password: z.string().min(8).max(500),
});

const wallpaperAttributionSchema = z.object({
  photoUrl: z.string().max(2048),
  photographerName: z.string().max(200),
  photographerUrl: z.string().max(2048),
  providerName: z.string().max(100).optional(),
});

const desktopWallpaperPreferenceSchema = z.object({
  mode: z.enum(["classic", "desktop"]).optional(),
  wallpaperUrl: z.string().max(3_000_000).refine(
    (value) => value.startsWith("/") || value.startsWith("data:image/") || value.startsWith("https://"),
    "Unsupported wallpaper URL",
  ).nullable().optional(),
  attribution: wallpaperAttributionSchema.nullable().optional(),
});

/**
 * Recovery codes (v2): 24 Crockford base32 characters (120 bits) shown as
 * six groups of four, "7K3M-Q9TD-…". Crockford's alphabet leaves out I, L,
 * O and U, so a code read aloud or copied by hand can't be mistyped into a
 * look-alike. Input is normalised (case, hyphens, spaces, I/L → 1, O → 0)
 * before it is compared, and the hash is of the normalised form.
 */
export const RECOVERY_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const RECOVERY_CODE_LENGTH = 24;
export const RECOVERY_CODE_GROUP = 4;

/** Generate a recovery code, grouped for display: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX". */
export function generateRecoveryCode(): string {
  // 256 is a multiple of 32, so `byte & 31` is uniform over the alphabet.
  const bytes = randomBytes(RECOVERY_CODE_LENGTH);
  let raw = "";
  for (const byte of bytes) raw += RECOVERY_CODE_ALPHABET[byte & 31];
  return formatRecoveryCode(raw);
}

/** Group a normalised code into blocks of four joined by hyphens. */
export function formatRecoveryCode(normalised: string): string {
  const groups: string[] = [];
  for (let i = 0; i < normalised.length; i += RECOVERY_CODE_GROUP) {
    groups.push(normalised.slice(i, i + RECOVERY_CODE_GROUP));
  }
  return groups.join("-");
}

/**
 * Normalise typed input to the canonical, ungrouped form: upper case, no
 * hyphens or whitespace, and Crockford's look-alikes folded (I and L to 1,
 * O to 0).
 */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

/** Hash a recovery code for storage (always of the normalised form). */
export async function hashRecoveryCode(code: string): Promise<string> {
  return bcryptHash(normalizeRecoveryCode(code), BCRYPT_ROUNDS);
}

/**
 * Check typed input against a stored hash. v2 hashes are of the normalised
 * code; codes issued before v2 (24 case-sensitive base64url characters) were
 * hashed as issued, so the trimmed input is tried as well.
 */
export async function verifyRecoveryCode(input: string, storedHash: string): Promise<boolean> {
  const normalised = normalizeRecoveryCode(input);
  if (normalised && await bcryptCompare(normalised, storedHash)) return true;
  const legacy = input.trim();
  if (legacy && legacy !== normalised) return bcryptCompare(legacy, storedHash);
  return false;
}

const BCRYPT_ROUNDS = 12;

/** Whether any account exists. Throws when the database can't be read. */
function usersExist(): boolean {
  const row = db.select({ id: schema.users.id }).from(schema.users).limit(1).get();
  return !!row;
}

function parsePreferences(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * POST /api/auth/setup — create the first (admin) account. Only works while
 * no account exists; afterwards it refuses, so a failed status probe on the
 * sign-in screen can never turn a login attempt into account creation.
 */
auth.post("/setup", async (c) => {
  const parsed = setupSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Enter a username and a password." }, 400);
  const name = parsed.data.username?.trim() ?? "";
  const password = parsed.data.password ?? "";
  if (name.length < 2) {
    return c.json({ error: "Choose a username with at least 2 characters.", field: "username" }, 400);
  }
  if (password.length < 8) {
    return c.json({ error: "Choose a password with at least 8 characters.", field: "password" }, 400);
  }

  const newHash = await bcryptHash(password, BCRYPT_ROUNDS);
  const recoveryCode = generateRecoveryCode();
  const recoveryHash = await hashRecoveryCode(recoveryCode);
  const userId = randomUUID();
  const now = new Date().toISOString();

  try {
    // One transaction: two setup requests racing can't both create an admin.
    db.transaction((tx) => {
      const existing = tx.select({ id: schema.users.id }).from(schema.users).limit(1).get();
      if (existing) throw new Error("ALREADY_SET_UP");
      tx.insert(schema.users)
        .values({ id: userId, username: name, passwordHash: newHash, role: "admin", recoveryCodeHash: recoveryHash, createdAt: now, lastLoginAt: now })
        .run();
      // Also store in settings for backward compatibility
      tx.insert(schema.settings)
        .values({ key: "admin_password_hash", value: newHash })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value: newHash } })
        .run();
    });
  } catch (error) {
    if (error instanceof Error && error.message === "ALREADY_SET_UP") {
      return c.json({ error: "Talome already has an account. Sign in instead.", code: "already_set_up" }, 409);
    }
    throw error;
  }

  const token = await createSessionToken(userId, "admin", name);
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c));
  writeAuditEntry("account_created", "modify", `user=${name} role=admin (first-run setup)`);

  return c.json({ ok: true, username: name, recoveryCode });
});

/** POST /api/auth/login — { username: string, password: string }. Never creates an account. */
auth.post("/login", async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid credentials" }, 400);
  const { username, password } = parsed.data;

  if (!usersExist()) {
    return c.json({ error: "Talome has no account yet. Set it up first.", code: "setup_required" }, 409);
  }

  const name = username?.trim() ?? "";
  if (!name) {
    return c.json({ error: "Enter your username.", field: "username" }, 400);
  }
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
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c));

  return c.json({ ok: true, setup: false });
});

/** GET /api/auth/invitations/:token — inspect a public, single-use invitation. */
auth.get("/invitations/:token", (c) => {
  const token = c.req.param("token");
  if (token.length < 20 || token.length > 200) {
    return c.json({ error: "Invitation not found", status: "invalid" }, 404);
  }

  const invitation = db.select().from(schema.userInvitations)
    .where(eq(schema.userInvitations.tokenHash, hashInvitationToken(token))).get();
  if (!invitation) return c.json({ error: "Invitation not found", status: "invalid" }, 404);

  if (invitation.acceptedAt) {
    return c.json({ error: "This invitation has already been accepted", status: "accepted" }, 410);
  }
  if (invitation.revokedAt) {
    return c.json({ error: "This invitation was revoked", status: "revoked" }, 410);
  }
  if (Date.parse(invitation.expiresAt) <= Date.now()) {
    return c.json({ error: "This invitation has expired", status: "expired" }, 410);
  }

  return c.json({
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
  });
});

/** POST /api/auth/invitations/:token/accept — create the invited account and sign in. */
auth.post("/invitations/:token/accept", async (c) => {
  const token = c.req.param("token");
  if (token.length < 20 || token.length > 200) {
    return c.json({ error: "Invitation not found" }, 404);
  }

  const parsed = acceptInvitationSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const tokenHash = hashInvitationToken(token);
  const invitation = db.select().from(schema.userInvitations)
    .where(eq(schema.userInvitations.tokenHash, tokenHash)).get();
  if (!invitation) return c.json({ error: "Invitation not found" }, 404);
  if (invitation.acceptedAt || invitation.revokedAt || Date.parse(invitation.expiresAt) <= Date.now()) {
    return c.json({ error: "This invitation is no longer available" }, 410);
  }

  const existingUsername = db.select().from(schema.users)
    .where(eq(schema.users.username, parsed.data.username)).get();
  if (existingUsername) return c.json({ error: "Username already exists" }, 409);
  const existingEmail = db.get(sql`SELECT id FROM users WHERE lower(email) = ${invitation.email.toLowerCase()} LIMIT 1`) as
    | { id: string }
    | undefined;
  if (existingEmail) return c.json({ error: "An account for this email already exists" }, 409);

  const passwordHash = await bcryptHash(parsed.data.password, BCRYPT_ROUNDS);
  const recoveryCode = generateRecoveryCode();
  const recoveryCodeHash = await hashRecoveryCode(recoveryCode);
  const userId = randomUUID();
  const now = new Date().toISOString();
  const permissions = invitation.role === "admin"
    ? null
    : invitation.permissions ?? JSON.stringify(getDefaultPermissions());

  try {
    db.transaction((tx) => {
      const current = tx.select().from(schema.userInvitations)
        .where(eq(schema.userInvitations.id, invitation.id)).get();
      if (!current || current.acceptedAt || current.revokedAt || Date.parse(current.expiresAt) <= Date.now()) {
        throw new Error("INVITATION_UNAVAILABLE");
      }

      tx.insert(schema.users).values({
        id: userId,
        username: parsed.data.username,
        email: invitation.email,
        passwordHash,
        role: invitation.role,
        permissions,
        recoveryCodeHash,
        createdAt: now,
        lastLoginAt: now,
      }).run();
      tx.update(schema.userInvitations)
        .set({ acceptedAt: now })
        .where(eq(schema.userInvitations.id, invitation.id))
        .run();
    });
  } catch (error) {
    if (error instanceof Error && error.message === "INVITATION_UNAVAILABLE") {
      return c.json({ error: "This invitation is no longer available" }, 410);
    }
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      return c.json({ error: "Username or email already exists" }, 409);
    }
    throw error;
  }

  const sessionToken = await createSessionToken(
    userId,
    invitation.role as "admin" | "member",
    parsed.data.username,
  );
  setCookie(c, SESSION_COOKIE, sessionToken, sessionCookieOptions(c));
  writeAuditEntry("family_invitation_accepted", "modify", `email=${invitation.email} user=${parsed.data.username}`);

  return c.json({
    ok: true,
    username: parsed.data.username,
    recoveryCode,
  });
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
    preferences: parsePreferences(user.preferences),
  });
});

/** PUT /api/auth/preferences/desktop — persist desktop preferences for this account. */
auth.put("/preferences/desktop", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  const payload = token ? await verifySessionToken(token) : null;
  if (!payload) return c.json({ error: "Unauthorized — please log in" }, 401);

  const parsed = desktopWallpaperPreferenceSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const user = db.select().from(schema.users).where(eq(schema.users.id, payload.sub)).get();
  if (!user) return c.json({ error: "User not found" }, 404);

  const preferences = parsePreferences(user.preferences);
  if (parsed.data.mode) preferences.desktopMode = parsed.data.mode;

  if (parsed.data.wallpaperUrl !== undefined || parsed.data.attribution !== undefined) {
    const currentWallpaper = preferences.desktopWallpaper;
    const currentWallpaperRecord = currentWallpaper
      && typeof currentWallpaper === "object"
      && !Array.isArray(currentWallpaper)
      ? currentWallpaper as Record<string, unknown>
      : {};
    preferences.desktopWallpaper = {
      wallpaperUrl: parsed.data.wallpaperUrl !== undefined
        ? parsed.data.wallpaperUrl
        : typeof currentWallpaperRecord.wallpaperUrl === "string"
          ? currentWallpaperRecord.wallpaperUrl
          : null,
      attribution: parsed.data.attribution !== undefined
        ? parsed.data.attribution
        : currentWallpaperRecord.attribution ?? null,
    };
  }

  db.update(schema.users)
    .set({ preferences: JSON.stringify(preferences) })
    .where(eq(schema.users.id, user.id))
    .run();

  return c.json({ ok: true, preferences });
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

  const user = db.select().from(schema.users).where(eq(schema.users.username, username.trim())).get();
  if (!user || !user.recoveryCodeHash) {
    // Don't reveal whether the user exists
    return c.json({ error: "Invalid username or recovery code" }, 401);
  }

  const valid = await verifyRecoveryCode(recoveryCode, user.recoveryCodeHash);
  if (!valid) {
    return c.json({ error: "Invalid username or recovery code" }, 401);
  }

  // Recovery code is single-use — set new password and generate a new code
  const newPasswordHash = await bcryptHash(newPassword, BCRYPT_ROUNDS);
  const newRecoveryCode = generateRecoveryCode();
  const newRecoveryHash = await hashRecoveryCode(newRecoveryCode);

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
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c));

  return c.json({ ok: true, newRecoveryCode });
});

/** GET /api/auth/status — unauthenticated probe: is any user configured? */
auth.get("/status", (c) => {
  try {
    return c.json({ passwordConfigured: usersExist() });
  } catch {
    // Never answer "no account" when we simply couldn't tell: the sign-in
    // screen shows an error with Retry instead of the setup form.
    return c.json({ error: "Couldn't read the account database." }, 503);
  }
});

export { auth };
