import { Hono } from "hono";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { serverError } from "../middleware/request-logger.js";
import { generateMcpToken } from "./mcp.js";
import { getAllDomains } from "../ai/tool-registry.js";
import { getToolMeta } from "../ai/execution.js";
import { READ_ONLY_SCOPES, parseTokenScopes, tokenScopesSchema } from "../approval/grants.js";

/**
 * MCP token management (mounted at /api/integrations/mcp/tokens).
 *
 * Tokens carry their own grants (approval/grants.ts). New tokens default to
 * read-only; tokens that predate grants are flagged `legacy` with full access.
 * Revoking is a soft delete (revoked_at) so the audit trail keeps its actor.
 * All routes are admin-only: a token is an owner-level credential.
 */
export const mcpTokens = new Hono();

mcpTokens.use("*", async (c, next) => {
  const role = c.get("sessionRole" as never) as string | undefined;
  if (role !== "admin") return c.json({ error: "Forbidden — admin access required" }, 403);
  await next();
});

const MAX_EXPIRY_DAYS = 3650;

const expirySchema = z.union([z.string().datetime({ offset: true }), z.null()]).optional();

const createTokenSchema = z.object({
  name: z.string().min(1).max(100).transform((s) => s.trim()),
  scopes: tokenScopesSchema.optional(),
  expiresAt: expirySchema,
  expiresInDays: z.number().int().min(1).max(MAX_EXPIRY_DAYS).optional(),
});

const updateTokenSchema = z.object({
  name: z.string().min(1).max(100).transform((s) => s.trim()).optional(),
  scopes: tokenScopesSchema.optional(),
  expiresAt: expirySchema,
});

type TokenRow = typeof schema.mcpTokens.$inferSelect;

function serializeToken(row: TokenRow) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt ?? null,
    revokedAt: row.revokedAt ?? null,
    legacy: !!row.legacy,
    scopes: parseTokenScopes(row.scopes),
  };
}

function resolveExpiry(expiresAt: string | null | undefined, expiresInDays: number | undefined): string | null | undefined {
  if (expiresInDays !== undefined) return new Date(Date.now() + expiresInDays * 86_400_000).toISOString();
  if (expiresAt === undefined) return undefined;
  if (expiresAt === null) return null;
  return new Date(expiresAt).toISOString();
}

// List tokens. Revoked tokens are hidden unless ?includeRevoked=1.
mcpTokens.get("/", (c) => {
  try {
    const includeRevoked = c.req.query("includeRevoked") === "1";
    const rows = db.select().from(schema.mcpTokens).all();
    return c.json(rows.filter((r) => includeRevoked || !r.revokedAt).map(serializeToken));
  } catch (err) {
    return serverError(c, err, { message: "Failed to list MCP tokens" });
  }
});

// Catalog for the grant editor: domains with their tools and effective tiers.
mcpTokens.get("/catalog", (c) => {
  try {
    const domains = getAllDomains().map((d) => ({
      name: d.name,
      tools: Object.keys(d.tools).map((name) => ({ name, tier: getToolMeta(name).tier })),
    }));
    const apps = db
      .select({ appId: schema.installedApps.appId })
      .from(schema.installedApps)
      .all()
      .map((r) => r.appId);
    return c.json({ domains, apps, defaults: READ_ONLY_SCOPES });
  } catch (err) {
    return serverError(c, err, { message: "Failed to load MCP grant catalog" });
  }
});

// Create a token. Returns the plaintext once. Default grants: read-only.
mcpTokens.post("/", async (c) => {
  try {
    const parsed = createTokenSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.flatten() }, 400);
    const { name } = parsed.data;
    const scopes = parsed.data.scopes ?? READ_ONLY_SCOPES;
    const expiresAt = resolveExpiry(parsed.data.expiresAt, parsed.data.expiresInDays) ?? null;
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      return c.json({ ok: false, error: "expiresAt must be in the future" }, 400);
    }

    const { id, plaintext, hash } = generateMcpToken(name);
    db.insert(schema.mcpTokens)
      .values({
        id,
        name,
        tokenHash: hash,
        scopes: JSON.stringify(scopes),
        expiresAt,
        legacy: false,
        // Revoked when this admin is deleted or demoted (routes/users.ts).
        createdBy: (c.get("sessionUser" as never) as string | undefined) ?? null,
      })
      .run();

    return c.json({ ok: true, id, name, token: plaintext, scopes, expiresAt });
  } catch (err) {
    return serverError(c, err, { message: "Failed to create MCP token" });
  }
});

// Update name, grants, or expiry. Editing grants clears the legacy flag.
mcpTokens.patch("/:id", async (c) => {
  try {
    const { id } = c.req.param();
    const parsed = updateTokenSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.flatten() }, 400);

    const row = db.select().from(schema.mcpTokens).where(eq(schema.mcpTokens.id, id)).get();
    if (!row) return c.json({ ok: false, error: "Token not found" }, 404);
    if (row.revokedAt) return c.json({ ok: false, error: "Token is revoked" }, 409);

    const expiresAt = resolveExpiry(parsed.data.expiresAt, undefined);
    const updates: Partial<TokenRow> = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.scopes !== undefined) {
      updates.scopes = JSON.stringify(parsed.data.scopes);
      updates.legacy = false;
    }
    if (expiresAt !== undefined) updates.expiresAt = expiresAt;

    if (Object.keys(updates).length > 0) {
      db.update(schema.mcpTokens).set(updates).where(eq(schema.mcpTokens.id, id)).run();
    }
    const updated = db.select().from(schema.mcpTokens).where(eq(schema.mcpTokens.id, id)).get();
    return c.json({ ok: true, token: updated ? serializeToken(updated) : null });
  } catch (err) {
    return serverError(c, err, { message: "Failed to update MCP token", context: { tokenId: c.req.param("id") } });
  }
});

// Revoke (soft delete). The token stops authenticating immediately.
mcpTokens.delete("/:id", (c) => {
  try {
    const { id } = c.req.param();
    db.update(schema.mcpTokens)
      .set({ revokedAt: new Date().toISOString() })
      .where(and(eq(schema.mcpTokens.id, id), isNull(schema.mcpTokens.revokedAt)))
      .run();
    return c.json({ ok: true });
  } catch (err) {
    return serverError(c, err, { message: "Failed to delete MCP token", context: { tokenId: c.req.param("id") } });
  }
});
