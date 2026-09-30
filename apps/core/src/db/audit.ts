import { db, schema } from "./index.js";
import { redactText } from "../approval/redact.js";

type AuditTier = "read" | "modify" | "destructive";

export type AuditOutcome = "success" | "error" | "blocked" | "approval_required";

/** Optional actor-aware fields (columns added by db/migrations/trust.ts). */
export interface AuditExtras {
  actorKind?: string;
  actorId?: string;
  actorLabel?: string;
  source?: string;
  toolName?: string;
  outcome?: AuditOutcome;
  durationMs?: number;
}

function safeRedact(text: string): string {
  try {
    return redactText(text);
  } catch {
    return text;
  }
}

/**
 * Append an audit entry. Never throws: auditing must not break the action it
 * records. If the trust columns are missing (a process started before
 * migrations ran), the entry is retried without them.
 *
 * `action` and `details` are redacted here (known secret values, secret-looking
 * `KEY=value` pairs, bearer tokens), so tool-internal and legacy callers that
 * log raw commands or env assignments cannot write secrets to the log.
 */
export function writeAuditEntry(
  rawAction: string,
  tier: AuditTier,
  rawDetails = "",
  approved = true,
  extras?: AuditExtras,
) {
  const action = safeRedact(rawAction);
  const details = safeRedact(rawDetails);
  try {
    db.insert(schema.auditLog)
      .values({ action, tier, details, approved, ...(extras ?? {}) })
      .run();
  } catch (err) {
    if (!extras) {
      console.error("[audit] failed to write entry:", err instanceof Error ? err.message : err);
      return;
    }
    try {
      db.insert(schema.auditLog)
        .values({ action, tier, details, approved })
        .run();
    } catch (fallbackErr) {
      console.error("[audit] failed to write entry:", fallbackErr instanceof Error ? fallbackErr.message : fallbackErr);
    }
  }
}
