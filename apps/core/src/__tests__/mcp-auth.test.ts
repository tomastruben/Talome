import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

// ── Helpers under test (inline, mirror mcp.ts logic) ─────────────────────────

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateMcpToken(name: string): { id: string; plaintext: string; hash: string } {
  const id = randomUUID();
  const plaintext = `talome_${randomUUID().replace(/-/g, "")}`;
  const hash = hashToken(plaintext);
  return { id, plaintext, hash };
}

// ── In-memory token store (mirrors DB behaviour) ──────────────────────────────

interface TokenRow {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function createStore() {
  const rows: TokenRow[] = [];

  function insert(id: string, name: string, tokenHash: string): void {
    rows.push({ id, name, tokenHash, createdAt: new Date().toISOString(), lastUsedAt: null });
  }

  function verify(authHeader: string | null | undefined): { ok: true; tokenId: string } | { ok: false } {
    if (!authHeader?.startsWith("Bearer ")) return { ok: false };
    const raw = authHeader.slice(7).trim();
    if (!raw) return { ok: false };
    const hash = hashToken(raw);
    const row = rows.find((r) => r.tokenHash === hash);
    if (!row) return { ok: false };
    row.lastUsedAt = new Date().toISOString();
    return { ok: true, tokenId: row.id };
  }

  function revoke(id: string): void {
    const idx = rows.findIndex((r) => r.id === id);
    if (idx !== -1) rows.splice(idx, 1);
  }

  function getById(id: string): TokenRow | undefined {
    return rows.find((r) => r.id === id);
  }

  function count(): number {
    return rows.length;
  }

  return { insert, verify, revoke, getById, count };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("hashToken", () => {
  it("produces a 64-char hex SHA-256 digest", () => {
    const h = hashToken("hello");
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
  });

  it("is sensitive to input changes", () => {
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });
});

describe("generateMcpToken", () => {
  it("produces a plaintext token with talome_ prefix", () => {
    const { plaintext } = generateMcpToken("test");
    expect(plaintext).toMatch(/^talome_[0-9a-f]{32}$/);
  });

  it("hash matches hashing the plaintext directly", () => {
    const { plaintext, hash } = generateMcpToken("test");
    expect(hash).toBe(hashToken(plaintext));
  });

  it("generates unique tokens each call", () => {
    const a = generateMcpToken("a");
    const b = generateMcpToken("b");
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
    expect(a.id).not.toBe(b.id);
  });
});

describe("verifyBearerToken", () => {
  let store: ReturnType<typeof createStore>;
  let tokenId: string;
  let tokenPlaintext: string;

  beforeEach(() => {
    store = createStore();
    const { id, plaintext, hash } = generateMcpToken("cursor");
    tokenId = id;
    tokenPlaintext = plaintext;
    store.insert(id, "cursor", hash);
  });

  it("returns ok=true for a valid token", () => {
    const result = store.verify(`Bearer ${tokenPlaintext}`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tokenId).toBe(tokenId);
  });

  it("returns ok=false for missing Authorization header", () => {
    expect(store.verify(null).ok).toBe(false);
    expect(store.verify(undefined).ok).toBe(false);
    expect(store.verify("").ok).toBe(false);
  });

  it("returns ok=false for wrong scheme", () => {
    expect(store.verify(`Basic ${tokenPlaintext}`).ok).toBe(false);
  });

  it("returns ok=false for an unknown token", () => {
    expect(store.verify("Bearer talome_unknowntoken00000000000000000000").ok).toBe(false);
  });

  it("returns ok=false for empty Bearer value", () => {
    expect(store.verify("Bearer ").ok).toBe(false);
  });

  it("updates lastUsedAt on successful verification", () => {
    const before = store.getById(tokenId)?.lastUsedAt;
    expect(before).toBeNull();
    store.verify(`Bearer ${tokenPlaintext}`);
    expect(store.getById(tokenId)?.lastUsedAt).not.toBeNull();
  });
});

describe("token revocation", () => {
  it("revoked token no longer verifies", () => {
    const store = createStore();
    const { id, plaintext, hash } = generateMcpToken("claude");
    store.insert(id, "claude", hash);

    expect(store.verify(`Bearer ${plaintext}`).ok).toBe(true);
    store.revoke(id);
    expect(store.verify(`Bearer ${plaintext}`).ok).toBe(false);
  });

  it("revoking removes the row from the store", () => {
    const store = createStore();
    const { id, hash } = generateMcpToken("test");
    store.insert(id, "test", hash);
    expect(store.count()).toBe(1);
    store.revoke(id);
    expect(store.count()).toBe(0);
  });

  it("revoking a non-existent id is a no-op", () => {
    const store = createStore();
    expect(() => store.revoke("non-existent-id")).not.toThrow();
  });
});
