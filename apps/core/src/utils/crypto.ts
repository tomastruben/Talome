import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";

const ALGORITHM = "aes-256-gcm";

/**
 * Keys matching these suffixes are treated as secrets and encrypted at rest.
 * The list intentionally uses suffix matching so any service's key/token/secret
 * is covered without enumerating every possible key name.
 */
const SECRET_KEY_SUFFIXES = ["_api_key", "_key", "_token", "_secret", "_password"];

export function isSecretSettingKey(key: string): boolean {
  return SECRET_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

function getKey(): Buffer {
  const secret = process.env.TALOME_SECRET;
  if (!secret) {
    throw new Error(
      "TALOME_SECRET environment variable is required for encryption. " +
      "Set it to a random string (64+ hex chars recommended) before starting the server."
    );
  }
  if (secret.length >= 64) {
    // Expect a 64-char hex string (32 bytes)
    return Buffer.from(secret.slice(0, 64), "hex");
  }
  // Derive a 32-byte key from the provided secret
  return createHash("sha256").update(secret).digest();
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns a colon-separated string: iv:authTag:ciphertext (all hex-encoded).
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt a string produced by encrypt().
 * Throws if tampered or malformed.
 */
export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("Invalid ciphertext format");
  const [ivHex, authTagHex, encHex] = parts;
  const key = getKey();
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const encrypted = Buffer.from(encHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

/**
 * Returns true if the value looks like it was encrypted by this module.
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split(":");
  return parts.length === 3 && parts[0].length === 24 && parts[1].length === 32;
}

/**
 * Safely decrypt a setting value. If the value is not encrypted (or decryption
 * fails because TALOME_SECRET is not set), returns the value as-is.
 */
export function decryptSetting(value: string): string {
  if (!isEncrypted(value)) return value;
  try {
    return decrypt(value);
  } catch {
    return value;
  }
}

/**
 * Encrypt a setting value if TALOME_SECRET is configured. If not, return as-is
 * so the app still works without a secret (insecure but functional).
 */
export function encryptSetting(value: string): string {
  if (!process.env.TALOME_SECRET) return value;
  if (isEncrypted(value)) return value; // already encrypted
  return encrypt(value);
}

/**
 * One-time migration: encrypt all plaintext secret settings at startup.
 * Idempotent — already-encrypted values are skipped.
 * Only runs when TALOME_SECRET is set.
 */
export async function migrateSettingsEncryption(): Promise<void> {
  if (!process.env.TALOME_SECRET) return;

  // Lazy import to avoid circular dep at module load time
  const { db, schema } = await import("../db/index.js");

  try {
    const rows = db.select().from(schema.settings).all();
    let migrated = 0;
    for (const row of rows) {
      if (!isSecretSettingKey(row.key)) continue;
      if (isEncrypted(row.value)) continue; // already done
      if (!row.value) continue; // skip empty
      const encrypted = encrypt(row.value);
      db.update(schema.settings)
        .set({ value: encrypted })
        .where(eq(schema.settings.key, row.key))
        .run();
      migrated++;
    }
    if (migrated > 0) {
      console.log(`[crypto] Encrypted ${migrated} settings secret(s) at rest.`);
    }
  } catch (err) {
    console.error("[crypto] migrateSettingsEncryption failed:", err);
  }
}
