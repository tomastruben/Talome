import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSessionToken, verifySessionToken } from "../middleware/session.js";

// ── Session token tests ───────────────────────────────────────────────────────
describe("session JWT", () => {
  it("createSessionToken produces a non-empty string", async () => {
    const token = await createSessionToken("test-user-id", "admin", "admin");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(10);
  });

  it("verifySessionToken returns payload for a valid token", async () => {
    const token = await createSessionToken("test-user-id", "admin", "admin");
    const payload = await verifySessionToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.sub).toBe("test-user-id");
  });

  it("verifySessionToken returns null for a garbage token", async () => {
    const payload = await verifySessionToken("not.a.real.token");
    expect(payload).toBeNull();
  });

  it("verifySessionToken returns null for empty string", async () => {
    const payload = await verifySessionToken("");
    expect(payload).toBeNull();
  });

  it("issued token contains iat and exp fields", async () => {
    const token = await createSessionToken("test-user-id", "admin", "admin");
    const payload = await verifySessionToken(token);
    expect(payload?.iat).toBeDefined();
    expect(payload?.exp).toBeDefined();
    // exp should be roughly 24 hours in the future
    const oneDaySec = 24 * 60 * 60;
    expect(payload!.exp - payload!.iat).toBeCloseTo(oneDaySec, -2);
  });
});

// ── Auth route tests (logic-level, no HTTP server needed) ─────────────────────

// Mock DB to avoid real SQLite in tests
vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(null), // no password set
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          run: vi.fn(),
        }),
      }),
    }),
  },
  schema: {
    settings: { key: "key" },
  },
}));

import { db } from "../db/index.js";

describe("auth route — password hashing contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("DB mock is queryable (verifies module resolution in test env)", () => {
    const row = db.select().from({} as any).where({} as any).get();
    expect(row).toBeNull();
  });

  it("bcryptjs compare returns false for wrong password", async () => {
    const { hash, compare } = await import("bcryptjs");
    const hashed = await hash("correctpassword", 10);
    const result = await compare("wrongpassword", hashed);
    expect(result).toBe(false);
  });

  it("bcryptjs compare returns true for correct password", async () => {
    const { hash, compare } = await import("bcryptjs");
    const hashed = await hash("correctpassword", 10);
    const result = await compare("correctpassword", hashed);
    expect(result).toBe(true);
  });
});
