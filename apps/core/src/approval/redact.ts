/**
 * Redaction for audit previews and approval summaries.
 *
 * Two layers:
 *   1. Key-based: any value whose key looks secret-ish is replaced.
 *   2. Value-based: any string that equals (or contains) a known secret —
 *      decrypted secret settings plus secret-looking env vars — is replaced,
 *      even when it sits under an innocent key like `command` or `body`.
 * Truncation happens only after redaction so a secret can never be split
 * across the cut and leak its prefix.
 */

import { db, schema } from "../db/index.js";
import { isSecretSettingKey, decryptSetting } from "../utils/crypto.js";

export const SECRET_KEY_PATTERN = /(pass(word)?|secret|token|api[_-]?key|auth|cookie|credential|private|bearer)/i;

export const REDACTED = "[REDACTED]";

/** Secrets shorter than this are only redacted on exact match (avoid shredding common words). */
const MIN_SUBSTRING_SECRET_LENGTH = 8;

const SECRET_CACHE_TTL_MS = 30_000;
let secretCache: { values: string[]; at: number } | null = null;

/** Drop the cached secret list (call after secret settings change; tests). */
export function invalidateSecretValueCache(): void {
  secretCache = null;
}

/**
 * Known secret values: decrypted secret settings and secret-looking env vars.
 * Cached briefly — this runs on every audited tool call.
 */
export function getKnownSecretValues(): string[] {
  const now = Date.now();
  if (secretCache && now - secretCache.at < SECRET_CACHE_TTL_MS) return secretCache.values;

  const values = new Set<string>();
  try {
    const rows = db.select().from(schema.settings).all();
    for (const row of rows) {
      if (!row.value || !isSecretSettingKey(row.key)) continue;
      const plain = decryptSetting(row.value);
      if (plain) values.add(plain);
      values.add(row.value); // ciphertext is sensitive too
    }
  } catch {
    // DB unavailable — env-only redaction still applies
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.length >= MIN_SUBSTRING_SECRET_LENGTH && SECRET_KEY_PATTERN.test(key)) {
      values.add(value);
    }
  }

  // Longest first so overlapping secrets are fully masked
  const sorted = [...values].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
  secretCache = { values: sorted, at: now };
  return sorted;
}

function redactString(value: string, secrets: readonly string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (out === secret) return REDACTED;
    if (secret.length >= MIN_SUBSTRING_SECRET_LENGTH && out.includes(secret)) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out;
}

/** Deep-copy `value` with secret keys and known secret values replaced. */
export function redactValue(value: unknown, secrets: readonly string[] = getKnownSecretValues(), depth = 0): unknown {
  if (depth > 8) return "[…]";
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) && v !== undefined && v !== null && v !== "" ? REDACTED : redactValue(v, secrets, depth + 1);
    }
    return out;
  }
  return value;
}

/** Redact, serialize, then truncate. */
export function redactedPreview(args: unknown, maxLength = 500): string {
  let json: string;
  try {
    json = JSON.stringify(redactValue(args)) ?? "";
  } catch {
    json = "[unserializable]";
  }
  // A final value pass over the serialized text catches secrets that were
  // split across structure (e.g. JSON-escaped) in the object walk.
  json = redactString(json, getKnownSecretValues());
  return json.length > maxLength ? `${json.slice(0, maxLength)}…` : json;
}

/** Redact free text (e.g. an error message) without truncating. */
export function redactText(text: string): string {
  return redactString(text, getKnownSecretValues());
}
