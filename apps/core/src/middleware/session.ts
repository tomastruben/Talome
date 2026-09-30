import { SignJWT, jwtVerify, decodeJwt } from "jose";
import type { Context, MiddlewareHandler } from "hono";
import type { AuditExtras } from "../db/audit.js";
import { getCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import { db, schema } from "../db/index.js";
import { eq, sql } from "drizzle-orm";

const SESSION_COOKIE = "talome_session";
const JWT_ALG = "HS256";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

function getJwtSecret(): Uint8Array {
  const secret = process.env.TALOME_SECRET;
  if (!secret) {
    throw new Error(
      "TALOME_SECRET environment variable is required. " +
      "Set it to a random string (64+ hex chars recommended) before starting the server."
    );
  }
  return new TextEncoder().encode(secret);
}

// ── In-memory revocation set (hot cache) ─────────────────────────────────────
const revokedJtis = new Set<string>();

/** Load persisted revocations into memory on first import. */
try {
  const rows = db.select({ jti: schema.revokedSessions.jti }).from(schema.revokedSessions).all();
  for (const row of rows) revokedJtis.add(row.jti);
} catch {
  // Table may not exist yet on first boot before migrations run
}

/** Revoke a session token so it can no longer be used. */
export function revokeSession(token: string): void {
  try {
    const payload = decodeJwt(token);
    const jti = payload.jti;
    if (!jti) return;
    revokedJtis.add(jti);
    db.insert(schema.revokedSessions)
      .values({ jti, revokedAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  } catch {
    // Invalid token — nothing to revoke
  }
}

function isRevoked(jti: string | undefined): boolean {
  if (!jti) return false;
  return revokedJtis.has(jti);
}

export interface SessionPayload {
  sub: string; // userId
  /** Current role from the users table — never the (possibly stale) JWT claim. */
  role: "admin" | "member";
  /** Current username from the users table. */
  username: string;
  /** Session version the token was issued under (users.session_version). */
  sv?: number;
  iat: number;
  exp: number;
}

interface SessionUserRow {
  id: string;
  username: string;
  role: string;
  sessionVersion: number;
}

/**
 * The user a session belongs to, read fresh on every request (a primary-key
 * lookup). Null when the user no longer exists or the lookup fails — a
 * session is only as good as its user row (fail closed).
 */
function loadSessionUser(userId: string): SessionUserRow | null {
  try {
    const row = db
      .select({
        id: schema.users.id,
        username: schema.users.username,
        role: schema.users.role,
        sessionVersion: schema.users.sessionVersion,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .get();
    return row ? { ...row, sessionVersion: row.sessionVersion ?? 0 } : null;
  } catch {
    return null;
  }
}

/** Anything but an explicit "admin" row is a member (least privilege). */
function normalizeRole(role: unknown): "admin" | "member" {
  return role === "admin" ? "admin" : "member";
}

/**
 * End every session of a user: bump users.session_version so tokens issued
 * under the old version stop verifying. Call on role change, password change
 * and anything else that must take effect on already signed-in browsers.
 * (Deleting the user ends its sessions by itself: the row is gone.)
 */
export function bumpSessionVersion(userId: string): void {
  db.update(schema.users)
    .set({ sessionVersion: sql`${schema.users.sessionVersion} + 1` })
    .where(eq(schema.users.id, userId))
    .run();
}

/**
 * Issue a session JWT stored in an httpOnly cookie.
 * TTL: 7 days. The token carries the user's current session version (`sv`),
 * so bumpSessionVersion() invalidates it. The role/username claims are
 * informational only: verification always takes them from the users table.
 */
export async function createSessionToken(userId: string, role: "admin" | "member", username: string): Promise<string> {
  const secret = getJwtSecret();
  const sv = loadSessionUser(userId)?.sessionVersion ?? 0;
  return new SignJWT({ sub: userId, role, username, sv })
    .setProtectedHeader({ alg: JWT_ALG })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret);
}

/**
 * Verify a session token. Returns the payload — with the user's CURRENT role
 * and username from the database — or null when the token is invalid,
 * expired or revoked, the user no longer exists, or the user's sessions were
 * ended (session version bumped by a role change, password change, ...).
 * Tokens issued before session versions existed count as version 0.
 */
export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const secret = getJwtSecret();
    const { payload } = await jwtVerify(token, secret, { algorithms: [JWT_ALG] });
    // Check if the token's JTI has been revoked
    if (isRevoked(payload.jti)) return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;

    const user = loadSessionUser(payload.sub);
    if (!user) return null;
    const tokenVersion = typeof payload.sv === "number" ? payload.sv : 0;
    if (tokenVersion !== user.sessionVersion) return null;

    return {
      ...(payload as unknown as SessionPayload),
      sub: user.id,
      role: normalizeRole(user.role),
      username: user.username,
    };
  } catch {
    return null;
  }
}

/**
 * Hono middleware: verify session cookie. Passes 401 if missing/invalid.
 * Skips public routes (/api/health, /api/auth/*, /api/webhooks/*, …).
 */
export const requireSession: MiddlewareHandler = async (c, next) => {
  const path = c.req.path;

  // Public routes — no auth required
  if (
    path === "/api/health" ||
    path.startsWith("/api/auth/") ||
    // Public previews expose only metadata or a sanitized portable manifest.
    path.startsWith("/api/stacks/public/") ||
    // MCP uses its own Bearer token auth
    path.startsWith("/api/mcp") ||
    // Only the daemon port lookup is public; /api/terminal/* mints PTY
    // tokens and needs a logged-in admin (routes/terminal.ts)
    path === "/api/terminal-daemon-port" ||
    // Webhook triggers are externally callable
    path.startsWith("/api/webhooks/") ||
    // Network setup scripts, guide page + CA cert are fetched from client devices
    path === "/api/network/setup" ||
    path === "/api/network/setup.sh" ||
    path === "/api/network/setup.ps1" ||
    path === "/api/network/ca.pem" ||
    path === "/api/network/setup.mobileconfig" ||
    // Internal loopback from detached worker processes — localhost only, not proxied
    path === "/api/evolution/internal-event"
  ) {
    return next();
  }

  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    return c.json({ error: "Unauthorized — please log in" }, 401);
  }

  const payload = await verifySessionToken(token);
  if (!payload) {
    return c.json({ error: "Session expired — please log in again" }, 401);
  }

  // Role and username come from the users table (verifySessionToken), so a
  // demotion applies at once and a deleted user's session is already gone.
  c.set("sessionUser" as never, payload.sub);
  c.set("sessionRole" as never, payload.role);
  c.set("sessionUsername" as never, payload.username);
  return next();
};

/**
 * Audit attribution for an action a signed-in user took through the REST API
 * (settings, users, ...). Use after requireSession.
 */
export function sessionAuditActor(c: Context): Pick<AuditExtras, "actorKind" | "actorId" | "actorLabel" | "source"> {
  const userId = c.get("sessionUser" as never) as string | undefined;
  const username = c.get("sessionUsername" as never) as string | undefined;
  return {
    actorKind: "user",
    actorId: userId ?? "unknown",
    actorLabel: username ?? userId ?? "unknown",
    source: "dashboard",
  };
}

export { SESSION_COOKIE, SESSION_TTL_SECONDS };
