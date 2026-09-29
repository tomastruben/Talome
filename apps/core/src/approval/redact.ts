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
 *
 * What the owner approves is different: an approval must show exactly what
 * will run. Executable arguments (a shell command, code, a coding agent's
 * task) are never pattern-redacted or truncated there — `API_TOKEN=$(curl …|sh)`
 * would otherwise read as `API_TOKEN=[REDACTED]`. Only known secret values are
 * masked, and the full preview is stored encrypted (see approvalArgsPreview /
 * sealApprovalDetail). Pattern redaction stays for audit rows and notifications.
 */

import { db, schema } from "../db/index.js";
import { isSecretSettingKey, decryptSetting, encrypt, decrypt } from "../utils/crypto.js";

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
/** `scheme://user:password@host` — a password embedded in a URL (e.g. echoed by a fetch error). */
const URL_USERINFO_PATTERN = /(\/\/)[^\s/@"'<>]+:[^\s"'<>]*@/g;

function redactAssignments(text: string): string {
  return text
    .replace(URL_USERINFO_PATTERN, (_m, slashes: string) => `${slashes}${REDACTED}@`)
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

// ── Approval display ─────────────────────────────────────────────────────────

/**
 * Arguments that are executed as given: shell commands, container exec argv,
 * code the server will load, and tasks handed to Claude Code (which runs with
 * --dangerously-skip-permissions). The owner must see them exactly.
 */
const EXECUTABLE_ARG_KEYS: Readonly<Record<string, readonly string[]>> = {
  run_shell: ["command"],
  exec_container: ["command"],
  apply_change: ["task"],
  plan_change: ["task"],
  create_tool: ["code"],
};

/** The argument names of `toolName` that are executed as given (empty for most tools). */
export function executableArgKeys(toolName: string): readonly string[] {
  return Object.hasOwn(EXECUTABLE_ARG_KEYS, toolName) ? EXECUTABLE_ARG_KEYS[toolName] : [];
}

/**
 * Mask known secret values only — substring matches of long secrets, never a
 * pattern and never a whole-string match of a short value (a short "secret"
 * equal to a command such as `reboot` must not hide that command).
 */
function maskKnownSecretValues(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 8) return value;
  if (typeof value === "string") {
    let out = value;
    for (const secret of secrets) {
      if (secret.length >= MIN_SUBSTRING_SECRET_LENGTH && out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => maskKnownSecretValues(v, secrets, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskKnownSecretValues(v, secrets, depth + 1)]),
    );
  }
  return value;
}

function redactAssignmentsDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (typeof value === "string") return redactAssignments(value);
  if (Array.isArray(value)) return value.map((v) => redactAssignmentsDeep(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactAssignmentsDeep(v, depth + 1)]),
    );
  }
  return value;
}

/**
 * The full argument preview the owner decides on. Never truncated. Executable
 * arguments appear exactly as they will run, with only known secret values
 * masked; every other argument is redacted like an audit preview (secret keys,
 * known values, KEY=value / Bearer patterns). Store it with sealApprovalDetail.
 */
export function approvalArgsPreview(toolName: string, args: Record<string, unknown>): string {
  const secrets = getKnownSecretValues();
  const exec = new Set(executableArgKeys(toolName));
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (!exec.has(k)) rest[k] = v;
  const redactedRest = redactAssignmentsDeep(redactValue(rest, secrets)) as Record<string, unknown>;

  const out: Record<string, unknown> = {};
  for (const k of Object.keys(args)) {
    out[k] = exec.has(k) ? maskKnownSecretValues(args[k], secrets) : redactedRest[k];
  }
  try {
    return JSON.stringify(out) ?? "{}";
  } catch {
    return "[unserializable]";
  }
}

/**
 * The executable part of a call for a one-line approval summary, or null when
 * it cannot be shown there faithfully: it is long, spans lines, or contains a
 * secret-looking value the summary (which also reaches notifications) must
 * hide. A null means "review the full request" — never a shortened command.
 */
export function approvalSummaryCommand(toolName: string, args: Record<string, unknown>, maxLength = 160): string | null {
  const parts: string[] = [];
  for (const key of executableArgKeys(toolName)) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    if (typeof v === "string") parts.push(v.trim());
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) parts.push(JSON.stringify(v));
    else return null;
  }
  if (parts.length === 0) return null;
  const text = maskKnownSecretValues(parts.join(" "), getKnownSecretValues()) as string;
  if (text.length > maxLength || /[\r\n\u2028\u2029]/.test(text)) return null;
  if (redactAssignments(text) !== text) return null;
  return text;
}

const SEALED_PREFIX = "sealed:v1:";

/**
 * Encrypt an approval's full argument preview for storage: it can hold a new
 * secret typed into a command, which the approvals table must not keep in
 * plain text. Only the admin approvals API opens it (openApprovalDetail).
 */
export function sealApprovalDetail(text: string): string {
  // Without TALOME_SECRET nothing is encrypted at rest (see encryptSetting);
  // an approval must still be requestable.
  if (!process.env.TALOME_SECRET) return text;
  return `${SEALED_PREFIX}${encrypt(text)}`;
}

/** The stored preview for an admin. Legacy rows (already redacted) pass through. */
export function openApprovalDetail(stored: string): string {
  if (!stored.startsWith(SEALED_PREFIX)) return stored;
  try {
    return decrypt(stored.slice(SEALED_PREFIX.length));
  } catch {
    return "[The full request could not be decrypted. Deny it and ask for a new approval.]";
  }
}
