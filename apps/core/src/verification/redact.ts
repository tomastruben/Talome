/**
 * Secret scrubbing for verification evidence.
 *
 * Evidence and remediation strings are persisted, shown in the dashboard and
 * handed to the AI — they must never carry API keys, tokens or passwords.
 * The runner passes every string through `redactSecrets` using both the exact
 * secret values the probe touched and generic key=value patterns.
 */

const REDACTED = "[redacted]";

/** Minimum length for exact-value redaction — avoids mangling text with trivially short values. */
const MIN_SECRET_LENGTH = 4;

const KEY_VALUE_PATTERN =
  /\b((?:api[_-]?key|apikey|x-api-key|access[_-]?token|token|password|passwd|secret|sid)["']?\s*[:=]\s*["']?)([^\s"'&,;}]+)/gi;
const AUTH_HEADER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g;
const MEDIABROWSER_PATTERN = /(MediaBrowser\s+Token=")[^"]*(")/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactSecrets(text: string, secrets: Iterable<string>): string {
  if (!text) return text;
  let out = text;

  const values = [...new Set([...secrets].filter((s) => typeof s === "string" && s.length >= MIN_SECRET_LENGTH))]
    // Longest first so a secret containing another secret is removed whole.
    .sort((a, b) => b.length - a.length);

  for (const secret of values) {
    const variants = new Set([secret, encodeURIComponent(secret)]);
    for (const variant of variants) {
      out = out.replace(new RegExp(escapeRegExp(variant), "g"), REDACTED);
    }
  }

  out = out.replace(KEY_VALUE_PATTERN, (_m, prefix: string) => `${prefix}${REDACTED}`);
  out = out.replace(AUTH_HEADER_PATTERN, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(MEDIABROWSER_PATTERN, (_m, open: string, close: string) => `${open}${REDACTED}${close}`);
  return out;
}

/** Trim long evidence (e.g. upstream error bodies) to keep results compact. */
export function clip(text: string, max = 300): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
