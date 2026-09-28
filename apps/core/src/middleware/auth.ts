import { createHash, timingSafeEqual } from "node:crypto";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { parseTokenScopes, type TokenScopes } from "../approval/grants.js";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Only persist last_used_at when it is older than this (avoids a write per request). */
const LAST_USED_THROTTLE_MS = 60_000;

export interface VerifiedToken {
  id: string;
  name: string;
  scopes: TokenScopes;
  legacy: boolean;
  expiresAt: string | null;
}

export type BearerVerification =
  | { ok: true; tokenId: string; token: VerifiedToken }
  | { ok: false; reason?: "missing" | "invalid" | "revoked" | "expired" };

function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

/**
 * Verify an `Authorization: Bearer <token>` header against mcp_tokens.
 * Only the SHA-256 hash is stored; the lookup is by hash and the match is
 * re-confirmed with a constant-time compare. Revoked and expired tokens fail.
 */
export function verifyBearerToken(authHeader: string | null | undefined): BearerVerification {
  if (!authHeader?.startsWith("Bearer ")) return { ok: false, reason: "missing" };
  const raw = authHeader.slice(7).trim();
  if (!raw) return { ok: false, reason: "missing" };

  const hash = hashToken(raw);
  let row: typeof schema.mcpTokens.$inferSelect | undefined;
  try {
    row = db.select().from(schema.mcpTokens).where(eq(schema.mcpTokens.tokenHash, hash)).get();
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!row || !hashesEqual(row.tokenHash, hash)) return { ok: false, reason: "invalid" };

  const now = Date.now();
  if (row.revokedAt) return { ok: false, reason: "revoked" };
  if (row.expiresAt) {
    const expires = Date.parse(row.expiresAt);
    if (!Number.isFinite(expires) || expires <= now) return { ok: false, reason: "expired" };
  }

  const lastUsed = row.lastUsedAt ? Date.parse(row.lastUsedAt) : 0;
  if (!Number.isFinite(lastUsed) || now - lastUsed > LAST_USED_THROTTLE_MS) {
    try {
      db.update(schema.mcpTokens)
        .set({ lastUsedAt: new Date(now).toISOString() })
        .where(eq(schema.mcpTokens.id, row.id))
        .run();
    } catch {
      // Non-critical
    }
  }

  return {
    ok: true,
    tokenId: row.id,
    token: {
      id: row.id,
      name: row.name,
      scopes: parseTokenScopes(row.scopes),
      legacy: !!row.legacy,
      expiresAt: row.expiresAt ?? null,
    },
  };
}

export const bearerAuth: MiddlewareHandler = async (c, next) => {
  const result = verifyBearerToken(c.req.header("Authorization"));
  if (!result.ok) {
    c.header("WWW-Authenticate", 'Bearer realm="Talome"');
    return c.json({ error: "Unauthorized — provide a valid Bearer token" }, 401);
  }
  await next();
};
