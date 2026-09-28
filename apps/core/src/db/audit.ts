import { db, schema } from "./index.js";

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

/**
 * Append an audit entry. Never throws: auditing must not break the action it
 * records. If the trust columns are missing (a process started before
 * migrations ran), the entry is retried without them.
 */
export function writeAuditEntry(
  action: string,
  tier: AuditTier,
  details = "",
  approved = true,
  extras?: AuditExtras,
) {
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
