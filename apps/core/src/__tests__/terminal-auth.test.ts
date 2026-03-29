import { describe, it, expect, beforeEach } from "vitest";
import { createHash, randomUUID } from "node:crypto";

// ── Helpers (inline mirrors of auth.ts) ───────────────────────────────────────

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(name: string): { id: string; plaintext: string; hash: string } {
  const id = randomUUID();
  const plaintext = `talome_${randomUUID().replace(/-/g, "")}`;
  const hash = hashToken(plaintext);
  return { id, plaintext, hash };
}

// ── In-memory token store (mirrors DB layer) ──────────────────────────────────

interface TokenRow {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function createStore() {
  const rows: TokenRow[] = [];

  function insert(id: string, name: string, tokenHash: string) {
    rows.push({ id, name, tokenHash, createdAt: new Date().toISOString(), lastUsedAt: null });
  }

  function verifyBearerToken(authHeader: string | null | undefined): { ok: true; tokenId: string } | { ok: false } {
    if (!authHeader?.startsWith("Bearer ")) return { ok: false };
    const raw = authHeader.slice(7).trim();
    if (!raw) return { ok: false };
    const hash = hashToken(raw);
    const row = rows.find((r) => r.tokenHash === hash);
    if (!row) return { ok: false };
    row.lastUsedAt = new Date().toISOString();
    return { ok: true, tokenId: row.id };
  }

  function revoke(id: string) {
    const idx = rows.findIndex((r) => r.id === id);
    if (idx !== -1) rows.splice(idx, 1);
  }

  function getById(id: string) { return rows.find((r) => r.id === id); }
  function count() { return rows.length; }

  return { insert, verifyBearerToken, revoke, getById, count };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("hashToken (auth.ts)", () => {
  it("produces a 64-char hex SHA-256", () => {
    expect(hashToken("secret")).toHaveLength(64);
    expect(hashToken("secret")).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic", () => {
    expect(hashToken("foo")).toBe(hashToken("foo"));
  });

  it("is sensitive to input", () => {
    expect(hashToken("foo")).not.toBe(hashToken("bar"));
  });
});

describe("verifyBearerToken (terminal auth)", () => {
  let store: ReturnType<typeof createStore>;
  let tokenId: string;
  let tokenPlaintext: string;

  beforeEach(() => {
    store = createStore();
    const { id, plaintext, hash } = generateToken("terminal");
    tokenId = id;
    tokenPlaintext = plaintext;
    store.insert(id, "terminal", hash);
  });

  it("returns ok=true for valid Bearer token", () => {
    const result = store.verifyBearerToken(`Bearer ${tokenPlaintext}`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tokenId).toBe(tokenId);
  });

  it("returns ok=false for null header", () => {
    expect(store.verifyBearerToken(null).ok).toBe(false);
  });

  it("returns ok=false for undefined header", () => {
    expect(store.verifyBearerToken(undefined).ok).toBe(false);
  });

  it("returns ok=false for wrong scheme (Basic)", () => {
    expect(store.verifyBearerToken(`Basic ${tokenPlaintext}`).ok).toBe(false);
  });

  it("returns ok=false for unknown token", () => {
    expect(store.verifyBearerToken("Bearer talome_notavalidtoken0000000000000000").ok).toBe(false);
  });

  it("returns ok=false for empty Bearer value", () => {
    expect(store.verifyBearerToken("Bearer ").ok).toBe(false);
  });

  it("updates lastUsedAt on successful verification", () => {
    expect(store.getById(tokenId)?.lastUsedAt).toBeNull();
    store.verifyBearerToken(`Bearer ${tokenPlaintext}`);
    expect(store.getById(tokenId)?.lastUsedAt).not.toBeNull();
  });

  it("revoked token no longer passes", () => {
    expect(store.verifyBearerToken(`Bearer ${tokenPlaintext}`).ok).toBe(true);
    store.revoke(tokenId);
    expect(store.verifyBearerToken(`Bearer ${tokenPlaintext}`).ok).toBe(false);
  });
});
