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

/** A name (object key, env var, setting key) that denotes a secret. */
export function isSecretName(name: string): boolean {
  return SECRET_KEY_PATTERN.test(name) || isSecretSettingKey(name.toLowerCase());
}

/**
 * Object fields that carry the *name* of a setting / env var whose value sits
 * in a sibling field — e.g. set_setting / set_app_env take `{ key, value }`.
 */
const NAME_FIELDS = ["key", "name", "envKey", "env_key", "setting", "variable"] as const;
const VALUE_FIELDS = ["value", "newValue", "new_value", "val"] as const;

function describesSecretPair(obj: Record<string, unknown>): boolean {
  return NAME_FIELDS.some((f) => typeof obj[f] === "string" && isSecretName(obj[f] as string));
}

function isPresent(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

/**
 * Free-text patterns: `KEY=value`, `KEY: value` (where KEY looks secret) and
 * `Bearer <token>`. Catches secrets the value layer cannot know yet (a new API
 * key being set, a password typed into a shell command).
 */
const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_.-]*(?:pass(?:word)?|secret|token|api[_-]?key|auth|cookie|credential|private|bearer)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"'&;,]+)/gi;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi;

function redactAssignments(text: string): string {
  return text
    .replace(BEARER_PATTERN, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(SECRET_ASSIGNMENT_PATTERN, (match, key: string, sep: string, value: string) => {
      if (value === REDACTED || value.startsWith("[REDACTED")) return match;
      const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : "";
      return `${key}${sep}${quote}${REDACTED}${quote}`;
    });
}

/** Deep-copy `value` with secret keys and known secret values replaced. */
export function redactValue(value: unknown, secrets: readonly string[] = getKnownSecretValues(), depth = 0): unknown {
  if (depth > 8) return "[…]";
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets, depth + 1));
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const secretPair = describesSecretPair(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const secretField = isSecretName(k) || (secretPair && (VALUE_FIELDS as readonly string[]).includes(k));
      out[k] = secretField && isPresent(v) ? REDACTED : redactValue(v, secrets, depth + 1);
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
  // A final text pass over the serialized form catches secrets that were
  // split across structure (e.g. JSON-escaped) or embedded as KEY=value.
  json = redactText(json);
  return json.length > maxLength ? `${json.slice(0, maxLength)}…` : json;
}

/**
 * Redact free text (an error message, a shell command, a legacy audit detail)
 * without truncating: known secret values, `KEY=value` / `KEY: value` pairs
 * whose key looks secret, and `Bearer <token>`.
 */
export function redactText(text: string, secrets: readonly string[] = getKnownSecretValues()): string {
  if (!text) return text;
  return redactAssignments(redactString(text, secrets));
}
