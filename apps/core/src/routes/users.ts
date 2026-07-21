import { Hono } from "hono";
import { z } from "zod";
import { hash as bcryptHash } from "bcryptjs";
import { generateRecoveryCode } from "./auth.js";
import { db, schema } from "../db/index.js";
import { desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { UserPermissions } from "@talome/types";
import { getDefaultPermissions } from "@talome/types";
import { writeAuditEntry } from "../db/audit.js";
import { generateInvitationToken, hashInvitationToken } from "../auth/invitations.js";

const createUserSchema = z.object({
  username: z.string().min(2).max(100),
  password: z.string().min(8).max(500),
  email: z.string().email().max(200).optional(),
  role: z.enum(["admin", "member"]).optional(),
  permissions: z.record(z.string(), z.unknown()).optional(),
});

const updateUserSchema = z.object({
  email: z.string().email().max(200).optional(),
  role: z.enum(["admin", "member"]).optional(),
  username: z.string().min(2).max(100).optional(),
});

const resetPasswordSchema = z.object({
  password: z.string().min(8).max(500),
});

const createInvitationSchema = z.object({
  email: z.string().trim().email().max(200),
  role: z.enum(["admin", "member"]).optional(),
  permissions: z.record(z.string(), z.unknown()).optional(),
});

const BCRYPT_ROUNDS = 12;

function parsePermissions(raw: string | null): UserPermissions | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserPermissions;
  } catch {
    return null;
  }
}

const users = new Hono();

/** GET / — list all users (admin only) */
users.get("/", (c) => {
  const rows = db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      email: schema.users.email,
      role: schema.users.role,
      permissions: schema.users.permissions,
      createdAt: schema.users.createdAt,
      lastLoginAt: schema.users.lastLoginAt,
    })
    .from(schema.users)
    .all();

  return c.json(
    rows.map((r) => ({
      ...r,
      permissions: parsePermissions(r.permissions) ?? getDefaultPermissions(),
    })),
  );
});

/** POST / — create user */
users.post("/", async (c) => {
  const parsed = createUserSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const body = parsed.data;
  const { username, email, password, role } = body;

  // Check uniqueness
  const existing = db.select().from(schema.users).where(eq(schema.users.username, username)).get();
  if (existing) {
    return c.json({ error: "Username already exists" }, 409);
  }

  const id = randomUUID();
  const passwordHash = await bcryptHash(password, BCRYPT_ROUNDS);
  const recoveryCode = generateRecoveryCode();
  const recoveryCodeHash = await bcryptHash(recoveryCode, BCRYPT_ROUNDS);
  const now = new Date().toISOString();
  const userRole = role ?? "member";
  const permissions = userRole === "admin" ? null : JSON.stringify(body.permissions ?? getDefaultPermissions());

  db.insert(schema.users)
    .values({
      id,
      username,
      email: email ?? null,
      passwordHash,
      role: userRole,
      permissions,
      recoveryCodeHash,
      createdAt: now,
    })
    .run();

  return c.json(
    {
      id,
      username,
      email: email ?? null,
      role: userRole,
      permissions: userRole === "admin" ? getDefaultPermissions() : (body.permissions ?? getDefaultPermissions()),
      recoveryCode,
      createdAt: now,
    },
    201,
  );
});

/** GET /invitations — list invitations for access management. */
users.get("/invitations", (c) => {
  const rows = db
    .select()
    .from(schema.userInvitations)
    .orderBy(desc(schema.userInvitations.createdAt))
    .all();

  const now = Date.now();
  return c.json(rows.map((invitation) => ({
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    permissions: parsePermissions(invitation.permissions) ?? getDefaultPermissions(),
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    acceptedAt: invitation.acceptedAt,
    revokedAt: invitation.revokedAt,
    status: invitation.acceptedAt
      ? "accepted"
      : invitation.revokedAt
        ? "revoked"
        : Date.parse(invitation.expiresAt) <= now
          ? "expired"
          : "pending",
  })));
});

/** POST /invitations — create a seven-day, single-use family invitation. */
users.post("/invitations", async (c) => {
  const parsed = createInvitationSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const email = parsed.data.email.toLowerCase();
  const existingUser = db.get(sql`SELECT id FROM users WHERE lower(email) = ${email} LIMIT 1`) as
    | { id: string }
    | undefined;
  if (existingUser) return c.json({ error: "A user with this email already exists" }, 409);

  const now = new Date();
  const nowIso = now.toISOString();
  const existingInvitation = db.get(sql`
    SELECT id FROM user_invitations
    WHERE lower(email) = ${email}
      AND accepted_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > ${nowIso}
    LIMIT 1
  `) as { id: string } | undefined;
  if (existingInvitation) {
    return c.json({ error: "An active invitation already exists for this email" }, 409);
  }

  const role = parsed.data.role ?? "member";
  const permissions = role === "admin"
    ? null
    : JSON.stringify(parsed.data.permissions ?? getDefaultPermissions());
  const token = generateInvitationToken();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString();
  const id = randomUUID();
  const createdBy = c.get("sessionUser" as never) as string;

  db.insert(schema.userInvitations).values({
    id,
    tokenHash: hashInvitationToken(token),
    email,
    role,
    permissions,
    createdBy,
    expiresAt,
    createdAt: nowIso,
  }).run();

  writeAuditEntry("family_invitation_created", "modify", `email=${email} role=${role}`);
  return c.json({
    id,
    token,
    email,
    role,
    permissions: role === "admin" ? getDefaultPermissions() : (parsed.data.permissions ?? getDefaultPermissions()),
    createdAt: nowIso,
    expiresAt,
    status: "pending",
  }, 201);
});

/** DELETE /invitations/:id — revoke a pending invitation. */
users.delete("/invitations/:id", (c) => {
  const id = c.req.param("id");
  const invitation = db.select().from(schema.userInvitations)
    .where(eq(schema.userInvitations.id, id)).get();
  if (!invitation) return c.json({ error: "Invitation not found" }, 404);
  if (invitation.acceptedAt) return c.json({ error: "Accepted invitations cannot be revoked" }, 409);
  if (invitation.revokedAt) return c.json({ ok: true });

  db.update(schema.userInvitations)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(schema.userInvitations.id, id))
    .run();
  writeAuditEntry("family_invitation_revoked", "modify", `email=${invitation.email}`);
  return c.json({ ok: true });
});

/** PUT /:id — update user (role, email, username) */
users.put("/:id", async (c) => {
  const userId = c.req.param("id");
  const parsed = updateUserSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const body = parsed.data;

  const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  const updates: Record<string, string | null> = {};
  if (body.email !== undefined) updates.email = body.email;
  if (body.role !== undefined) updates.role = body.role;
  if (body.username !== undefined) {
    if (body.username.length < 2) {
      return c.json({ error: "Username must be at least 2 characters" }, 400);
    }
    const existing = db.select().from(schema.users).where(eq(schema.users.username, body.username)).get();
    if (existing && existing.id !== userId) {
      return c.json({ error: "Username already exists" }, 409);
    }
    updates.username = body.username;
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "Nothing to update" }, 400);
  }

  // If promoting to admin, clear permissions (admins have all access)
  if (body.role === "admin") {
    updates.permissions = null;
  }
  // If demoting to member, set default permissions if none exist
  if (body.role === "member" && user.role === "admin") {
    updates.permissions = JSON.stringify(getDefaultPermissions());
  }

  db.update(schema.users)
    .set(updates)
    .where(eq(schema.users.id, userId))
    .run();

  return c.json({ ok: true });
});

/** DELETE /:id — delete user (cannot delete self) */
users.delete("/:id", (c) => {
  const userId = c.req.param("id");
  const sessionUserId = c.get("sessionUser" as never) as string;

  if (userId === sessionUserId) {
    return c.json({ error: "Cannot delete your own account" }, 400);
  }

  const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  writeAuditEntry("user_deleted", "destructive", `user=${user.username} id=${userId}`);
  db.delete(schema.users).where(eq(schema.users.id, userId)).run();
  return c.json({ ok: true });
});

/** POST /:id/reset-password — admin resets a user's password */
users.post("/:id/reset-password", async (c) => {
  const userId = c.req.param("id");
  const parsed = resetPasswordSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const body = parsed.data;

  const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  const passwordHash = await bcryptHash(body.password, BCRYPT_ROUNDS);
  db.update(schema.users)
    .set({ passwordHash })
    .where(eq(schema.users.id, userId))
    .run();

  return c.json({ ok: true });
});

/** POST /:id/recovery-code — regenerate recovery code (admin only) */
users.post("/:id/recovery-code", async (c) => {
  const userId = c.req.param("id");
  const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) return c.json({ error: "User not found" }, 404);

  const recoveryCode = generateRecoveryCode();
  const recoveryCodeHash = await bcryptHash(recoveryCode, BCRYPT_ROUNDS);

  db.update(schema.users)
    .set({ recoveryCodeHash })
    .where(eq(schema.users.id, userId))
    .run();

  return c.json({ ok: true, recoveryCode });
});

/** PUT /:id/permissions — update user permissions */
users.put("/:id/permissions", async (c) => {
  const userId = c.req.param("id");
  const body = await c.req.json() as { permissions: UserPermissions };

  if (!body.permissions || typeof body.permissions !== "object") {
    return c.json({ error: "Permissions object is required" }, 400);
  }

  const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  if (user.role === "admin") {
    return c.json({ error: "Admins always have full access — permissions cannot be restricted" }, 400);
  }

  db.update(schema.users)
    .set({ permissions: JSON.stringify(body.permissions) })
    .where(eq(schema.users.id, userId))
    .run();

  return c.json({ ok: true });
});

/** POST /bulk-permissions — bulk-assign permissions to multiple users */
users.post("/bulk-permissions", async (c) => {
  const body = await c.req.json() as { userIds: string[]; permissions: UserPermissions };

  if (!Array.isArray(body.userIds) || body.userIds.length === 0) {
    return c.json({ error: "userIds array is required" }, 400);
  }
  if (!body.permissions || typeof body.permissions !== "object") {
    return c.json({ error: "Permissions object is required" }, 400);
  }

  const serialized = JSON.stringify(body.permissions);
  let updated = 0;

  for (const uid of body.userIds) {
    const user = db.select().from(schema.users).where(eq(schema.users.id, uid)).get();
    if (user && user.role !== "admin") {
      db.update(schema.users)
        .set({ permissions: serialized })
        .where(eq(schema.users.id, uid))
        .run();
      updated++;
    }
  }

  return c.json({ ok: true, updated });
});

export { users };
