import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { hash as bcryptHash } from "bcryptjs";
import { eq } from "drizzle-orm";

// A throwaway database: these tests need a users table that starts empty.
const { tempDir } = vi.hoisted(() => {
  const dir = `${process.cwd()}/data/test-auth-setup-${process.pid}-${Date.now()}`;
  process.env.DATABASE_PATH = `${dir}/talome.db`;
  return { tempDir: dir };
});

import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import {
  auth,
  formatRecoveryCode,
  generateRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_ALPHABET,
  verifyRecoveryCode,
  hashRecoveryCode,
} from "../routes/auth.js";

function post(path: string, body: unknown) {
  return auth.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(() => runMigrations());

afterAll(() => {
  delete process.env.DATABASE_PATH;
  try {
    db.$client.close();
  } catch {
    // already closed
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("recovery code v2", () => {
  it("is 24 Crockford base32 characters in six groups of four", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRecoveryCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
      for (const ch of code.replace(/-/g, "")) expect(RECOVERY_CODE_ALPHABET).toContain(ch);
    }
    expect(new Set(Array.from({ length: 20 }, generateRecoveryCode)).size).toBe(20);
  });

  it("normalises case, hyphens, spaces and look-alike letters", () => {
    expect(normalizeRecoveryCode(" ab1k-o9il \n0zz ")).toBe("AB1K0911" + "0ZZ");
    expect(formatRecoveryCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });

  it("accepts the code typed in lower case, without hyphens, or with O/I/L look-alikes", async () => {
    const code = "7K3M-Q9TD-0A1B-C2D3-E4F5-G6H7";
    const hash = await hashRecoveryCode(code);
    expect(await verifyRecoveryCode(code, hash)).toBe(true);
    expect(await verifyRecoveryCode(code.toLowerCase(), hash)).toBe(true);
    expect(await verifyRecoveryCode(code.replace(/-/g, ""), hash)).toBe(true);
    expect(await verifyRecoveryCode("7k3m q9td oa1b c2d3 e4f5 g6h7", hash)).toBe(true);
    expect(await verifyRecoveryCode("7K3M-Q9TD-0AlB-C2D3-E4F5-G6H7", hash)).toBe(true);
    expect(await verifyRecoveryCode("7K3M-Q9TD-0A1B-C2D3-E4F5-G6H8", hash)).toBe(false);
  });

  it("still accepts a legacy (pre-v2) case-sensitive code exactly as issued", async () => {
    const legacy = "aB3_x-Yz09QwErTy12-_AbCd";
    const hash = await bcryptHash(legacy, 4);
    expect(await verifyRecoveryCode(legacy, hash)).toBe(true);
    expect(await verifyRecoveryCode(`  ${legacy} `, hash)).toBe(true);
    expect(await verifyRecoveryCode(legacy.toLowerCase(), hash)).toBe(false);
  });
});

describe("first-run setup and sign-in", () => {
  it("login never creates an account when none exists", async () => {
    expect(db.select().from(schema.users).all()).toHaveLength(0);
    const res = await post("/login", { username: "someone", password: "a-long-password" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({ code: "setup_required" }));
    expect(db.select().from(schema.users).all()).toHaveLength(0);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("status reports no account yet", async () => {
    const res = await auth.request("/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ passwordConfigured: false });
  });

  it("setup requires an explicit username and an 8-character password", async () => {
    const blank = await post("/setup", { username: "  ", password: "a-long-password" });
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual(expect.objectContaining({ field: "username" }));
    const short = await post("/setup", { username: "owner", password: "short" });
    expect(short.status).toBe(400);
    expect(db.select().from(schema.users).all()).toHaveLength(0);
  });

  let recoveryCode = "";

  it("setup creates the admin once, signs in, and returns a grouped recovery code", async () => {
    const res = await post("/setup", { username: " owner ", password: "a-long-password" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("talome_session=");
    const body = await res.json() as { username: string; recoveryCode: string };
    expect(body.username).toBe("owner");
    expect(body.recoveryCode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);
    recoveryCode = body.recoveryCode;

    const rows = db.select().from(schema.users).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ username: "owner", role: "admin" }));
  });

  it("setup refuses once an account exists", async () => {
    const res = await post("/setup", { username: "intruder", password: "another-password" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({ code: "already_set_up" }));
    expect(db.select().from(schema.users).where(eq(schema.users.username, "intruder")).get()).toBeUndefined();
  });

  it("login requires the username and never falls back to admin", async () => {
    const blank = await post("/login", { password: "a-long-password" });
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual(expect.objectContaining({ field: "username" }));
    const wrong = await post("/login", { username: "admin", password: "a-long-password" });
    expect(wrong.status).toBe(401);
    const ok = await post("/login", { username: "owner", password: "a-long-password" });
    expect(ok.status).toBe(200);
  });

  it("recover accepts the code in lower case without hyphens and rotates it", async () => {
    const typed = recoveryCode.replace(/-/g, "").toLowerCase();
    const res = await post("/recover", { username: "owner", recoveryCode: typed, newPassword: "a-new-password" });
    expect(res.status).toBe(200);
    const body = await res.json() as { newRecoveryCode: string };
    expect(body.newRecoveryCode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);
    expect(body.newRecoveryCode).not.toBe(recoveryCode);

    const reused = await post("/recover", { username: "owner", recoveryCode, newPassword: "yet-another-password" });
    expect(reused.status).toBe(401);
  });
});
