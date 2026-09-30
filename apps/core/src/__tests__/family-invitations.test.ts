import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { auth } from "../routes/auth.js";
import { users } from "../routes/users.js";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { hashInvitationToken } from "../auth/invitations.js";

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const acceptedEmail = `family-${suffix}@example.test`;
const revokedEmail = `revoked-${suffix}@example.test`;
const username = `family-${suffix}`;
const invitationIds: string[] = [];

const adminUsers = new Hono();
adminUsers.use("*", async (c, next) => {
  c.set("sessionUser" as never, "test-admin");
  await next();
});
adminUsers.route("/", users);

beforeAll(() => runMigrations());

afterAll(() => {
  for (const id of invitationIds) {
    db.delete(schema.userInvitations).where(eq(schema.userInvitations.id, id)).run();
  }
  db.delete(schema.users).where(eq(schema.users.username, username)).run();
});

describe("family invitation journey", () => {
  it("creates a hashed, expiring invitation and accepts it exactly once", async () => {
    const createResponse = await adminUsers.request("/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: acceptedEmail, role: "member" }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      id: string;
      token: string;
      expiresAt: string;
    };
    invitationIds.push(created.id);
    expect(created.token.length).toBeGreaterThan(30);
    expect(Date.parse(created.expiresAt)).toBeGreaterThan(Date.now());

    const stored = db.select().from(schema.userInvitations)
      .where(eq(schema.userInvitations.id, created.id)).get();
    expect(stored?.tokenHash).toBe(hashInvitationToken(created.token));
    expect(stored?.tokenHash).not.toContain(created.token);

    const previewResponse = await auth.request(`/invitations/${created.token}`);
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.json()).toEqual(expect.objectContaining({
      email: acceptedEmail,
      role: "member",
    }));

    const acceptResponse = await auth.request(`/invitations/${created.token}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "family-password-123" }),
    });
    expect(acceptResponse.status).toBe(200);
    expect(acceptResponse.headers.get("set-cookie")).toContain("talome_session=");
    const accepted = await acceptResponse.json() as { recoveryCode: string };
    expect(accepted.recoveryCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);

    const user = db.select().from(schema.users).where(eq(schema.users.username, username)).get();
    expect(user).toEqual(expect.objectContaining({ email: acceptedEmail, role: "member" }));

    const reusedResponse = await auth.request(`/invitations/${created.token}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: `${username}-again`, password: "family-password-123" }),
    });
    expect(reusedResponse.status).toBe(410);
  });

  it("lets an admin revoke a pending invitation", async () => {
    const createResponse = await adminUsers.request("/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: revokedEmail }),
    });
    const created = await createResponse.json() as { id: string; token: string };
    invitationIds.push(created.id);

    const revokeResponse = await adminUsers.request(`/invitations/${created.id}`, { method: "DELETE" });
    expect(revokeResponse.status).toBe(200);

    const previewResponse = await auth.request(`/invitations/${created.token}`);
    expect(previewResponse.status).toBe(410);
    expect(await previewResponse.json()).toEqual(expect.objectContaining({ status: "revoked" }));
  });
});
