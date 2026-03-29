import { createHash } from "node:crypto";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function verifyBearerToken(
  authHeader: string | null | undefined,
): { ok: true; tokenId: string } | { ok: false } {
  if (!authHeader?.startsWith("Bearer ")) return { ok: false };
  const raw = authHeader.slice(7).trim();
  if (!raw) return { ok: false };

  const hash = hashToken(raw);
  const row = db.select().from(schema.mcpTokens).where(eq(schema.mcpTokens.tokenHash, hash)).get();
  if (!row) return { ok: false };

  try {
    db.update(schema.mcpTokens)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(schema.mcpTokens.id, row.id))
      .run();
  } catch {
    // Non-critical
  }

  return { ok: true, tokenId: row.id };
}

export const bearerAuth: MiddlewareHandler = async (c, next) => {
  const result = verifyBearerToken(c.req.header("Authorization"));
  if (!result.ok) {
    c.header("WWW-Authenticate", 'Bearer realm="Talome"');
    return c.json({ error: "Unauthorized — provide a valid Bearer token" }, 401);
  }
  await next();
};
