import { SignJWT, jwtVerify, decodeJwt } from "jose";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";

const SESSION_COOKIE = "talome_session";
const JWT_ALG = "HS256";

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
  role: "admin" | "member";
  username: string;
  iat: number;
  exp: number;
}

/**
 * Issue a session JWT stored in an httpOnly cookie.
 * TTL: 7 days.
 */
export async function createSessionToken(userId: string, role: "admin" | "member", username: string): Promise<string> {
  const secret = getJwtSecret();
  return new SignJWT({ sub: userId, role, username })
    .setProtectedHeader({ alg: JWT_ALG })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(secret);
}

/**
 * Verify a session token. Returns the payload or null if invalid/expired.
 */
export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const secret = getJwtSecret();
    const { payload } = await jwtVerify(token, secret, { algorithms: [JWT_ALG] });
    // Check if the token's JTI has been revoked
    if (isRevoked(payload.jti)) return null;
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

/**
 * Hono middleware: verify session cookie. Passes 401 if missing/invalid.
 * Skips public routes (/api/health, /api/auth/*, /api/webhooks/*).
 */
export const requireSession: MiddlewareHandler = async (c, next) => {
  const path = c.req.path;

  // Public routes — no auth required
  if (
    path === "/api/health" ||
    path.startsWith("/api/auth/") ||
    // MCP and terminal use their own Bearer token auth
    path.startsWith("/api/mcp") ||
    path.startsWith("/api/terminal") ||
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

  c.set("sessionUser" as never, payload.sub);
  c.set("sessionRole" as never, payload.role ?? "admin");
  c.set("sessionUsername" as never, payload.username ?? "admin");
  return next();
};

export { SESSION_COOKIE };
