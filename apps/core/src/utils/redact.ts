/**
 * Redaction for values that end up in logs and the audit trail.
 *
 * Tool arguments can carry API keys, passwords and tokens (e.g. set_setting,
 * app configuration tools). Anything written to the audit log must pass
 * through here first.
 */

const SECRET_KEY_PATTERN = /(passw(or)?d|passphrase|secret|token|api[-_]?key|apikey|authorization|credential|cookie|private[-_]?key|_key$|^key$)/i;
const MAX_DEPTH = 6;

export const REDACTED = "[redacted]";

/** True when a field name looks like it holds a credential. */
export function isSecretFieldName(name: string): boolean {
  return SECRET_KEY_PATTERN.test(name);
}

/**
 * Deep-copy a value, replacing the contents of credential-looking fields.
 * A `{ key, value }` pair whose key names a secret setting has its value redacted too.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const keyNamesSecret = typeof record.key === "string" && isSecretFieldName(record.key);
  const out: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(record)) {
    if (field !== "key" && isSecretFieldName(field)) {
      out[field] = REDACTED;
    } else if (field === "value" && keyNamesSecret) {
      out[field] = REDACTED;
    } else {
      out[field] = redactSecrets(fieldValue, depth + 1);
    }
  }
  return out;
}

/** Redact and serialise a value for an audit entry, capped at `maxLength` characters. */
export function summarizeForAudit(value: unknown, maxLength = 300): string {
  const serialized = JSON.stringify(redactSecrets(value)) ?? "";
  return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}…` : serialized;
}
