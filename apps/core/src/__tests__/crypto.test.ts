import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  encrypt,
  decrypt,
  isEncrypted,
  isSecretSettingKey,
  decryptSetting,
  encryptSetting,
  migrateSettingsEncryption,
} from "../utils/crypto.js";

// ── Mock DB for migrateSettingsEncryption ─────────────────────────────────────
const mockAll = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockSet = vi.hoisted(() => vi.fn());
const mockWhere = vi.hoisted(() => vi.fn());
const mockRun = vi.hoisted(() => vi.fn());

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        all: mockAll,
      }),
    }),
    update: mockUpdate,
  },
  schema: {
    settings: { key: "key" },
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

describe("AES-256-GCM crypto utils", () => {
  it("encrypt → decrypt round-trips correctly", () => {
    const plaintext = "my-secret-api-key-12345";
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("round-trips an empty string", () => {
    expect(decrypt(encrypt(""))).toBe("");
  });

  it("round-trips a long string", () => {
    const long = "x".repeat(10_000);
    expect(decrypt(encrypt(long))).toBe(long);
  });

  it("round-trips unicode content", () => {
    const unicode = "こんにちは 🦅 talome 🔑";
    expect(decrypt(encrypt(unicode))).toBe(unicode);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const a = encrypt("same");
    const b = encrypt("same");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("same");
    expect(decrypt(b)).toBe("same");
  });

  it("ciphertext has three colon-separated parts", () => {
    const c = encrypt("hello");
    expect(c.split(":")).toHaveLength(3);
  });

  it("throws on tampered ciphertext", () => {
    const parts = encrypt("tamper-me").split(":");
    parts[2] = "deadbeef"; // corrupt the ciphertext
    expect(() => decrypt(parts.join(":"))).toThrow();
  });

  it("throws on malformed ciphertext (wrong number of parts)", () => {
    expect(() => decrypt("not:a:valid:ciphertext:here")).toThrow();
    expect(() => decrypt("only-one-part")).toThrow();
  });

  it("isEncrypted returns true for encrypted values", () => {
    expect(isEncrypted(encrypt("hello"))).toBe(true);
  });

  it("isEncrypted returns false for plaintext", () => {
    expect(isEncrypted("plaintext-api-key")).toBe(false);
    expect(isEncrypted("")).toBe(false);
    expect(isEncrypted("a:b")).toBe(false);
  });
});

describe("isSecretSettingKey", () => {
  it("identifies keys ending in _api_key", () => {
    expect(isSecretSettingKey("sonarr_api_key")).toBe(true);
  });
  it("identifies keys ending in _key", () => {
    expect(isSecretSettingKey("anthropic_key")).toBe(true);
  });
  it("identifies keys ending in _token", () => {
    expect(isSecretSettingKey("telegram_token")).toBe(true);
  });
  it("identifies keys ending in _secret", () => {
    expect(isSecretSettingKey("webhook_secret")).toBe(true);
  });
  it("does NOT flag non-secret keys", () => {
    expect(isSecretSettingKey("sonarr_url")).toBe(false);
    expect(isSecretSettingKey("memory_enabled")).toBe(false);
    expect(isSecretSettingKey("system_prompt")).toBe(false);
  });
});

describe("decryptSetting / encryptSetting", () => {
  it("decryptSetting returns plaintext for unencrypted values", () => {
    expect(decryptSetting("plain-text-value")).toBe("plain-text-value");
  });

  it("decryptSetting decrypts an encrypted value", () => {
    const encrypted = encrypt("secret123");
    expect(decryptSetting(encrypted)).toBe("secret123");
  });

  it("encryptSetting returns plaintext as-is when TALOME_SECRET is not set", () => {
    const original = process.env.TALOME_SECRET;
    delete process.env.TALOME_SECRET;
    expect(encryptSetting("my-key")).toBe("my-key");
    if (original !== undefined) process.env.TALOME_SECRET = original;
  });

  it("encryptSetting encrypts when TALOME_SECRET is set", () => {
    process.env.TALOME_SECRET = process.env.TALOME_SECRET || "test-secret-for-tests";
    const result = encryptSetting("my-api-key");
    expect(isEncrypted(result)).toBe(true);
    expect(decryptSetting(result)).toBe("my-api-key");
  });

  it("encryptSetting is idempotent — does not double-encrypt", () => {
    process.env.TALOME_SECRET = process.env.TALOME_SECRET || "test-secret-for-tests";
    const once = encryptSetting("value");
    const twice = encryptSetting(once);
    expect(twice).toBe(once);
  });
});

describe("migrateSettingsEncryption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TALOME_SECRET = "test-talon-secret";
    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ run: mockRun });
  });

  afterEach(() => {
    delete process.env.TALOME_SECRET;
  });

  it("does nothing when TALOME_SECRET is not set", async () => {
    delete process.env.TALOME_SECRET;
    await migrateSettingsEncryption();
    expect(mockAll).not.toHaveBeenCalled();
  });

  it("skips rows with non-secret keys", async () => {
    mockAll.mockReturnValue([
      { key: "sonarr_url", value: "http://localhost:8989" },
      { key: "memory_enabled", value: "true" },
    ]);
    await migrateSettingsEncryption();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("encrypts plaintext secret rows", async () => {
    mockAll.mockReturnValue([
      { key: "sonarr_api_key", value: "plaintext-key-abc123" },
    ]);
    await migrateSettingsEncryption();
    expect(mockUpdate).toHaveBeenCalled();
    const setArg = mockSet.mock.calls[0][0];
    expect(isEncrypted(setArg.value)).toBe(true);
  });

  it("skips already-encrypted rows", async () => {
    const alreadyEncrypted = encrypt("some-key");
    mockAll.mockReturnValue([
      { key: "sonarr_api_key", value: alreadyEncrypted },
    ]);
    await migrateSettingsEncryption();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("skips empty value rows", async () => {
    mockAll.mockReturnValue([
      { key: "sonarr_api_key", value: "" },
    ]);
    await migrateSettingsEncryption();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
