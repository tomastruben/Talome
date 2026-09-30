import { db, schema } from "./index.js";
import { redactText } from "../approval/redact.js";
import { EXECUTION_SOURCE_LABELS, getExecutionContext } from "../ai/actor-context.js";

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

/** Legacy prefix tool-internal callers put on actions (`AI: delete_file`). */
const LEGACY_AI_PREFIX = "AI: ";

/**
 * Fill in who acted from the execution context in effect (ai/actor-context.ts)
 * — the MCP token, automation, agent loop or chat user whose tool call is
 * running — for any actor field the caller left out. Explicit extras win.
 * An unapproved entry without an explicit outcome is a blocked one.
 */
function resolveAttribution(
  rawAction: string,
  approved: boolean,
  extras: AuditExtras | undefined,
): { action: string; extras: AuditExtras | undefined } {
  const ctx = getExecutionContext();
  const resolved: AuditExtras = ctx
    ? { actorKind: ctx.actor.kind, actorId: ctx.actor.id, actorLabel: ctx.actor.label, source: ctx.source }
    : {};
  for (const [key, value] of Object.entries(extras ?? {}) as Array<[keyof AuditExtras, never]>) {
    if (value !== undefined) resolved[key] = value;
  }
  if (resolved.outcome === undefined && !approved) resolved.outcome = "blocked";

  // Tool-internal rows were hard-coded "AI: ..." even when an MCP token or
  // an automation made the call: name the real source instead.
  let action = rawAction;
  if (ctx && ctx.source !== "chat" && action.startsWith(LEGACY_AI_PREFIX)) {
    action = `${EXECUTION_SOURCE_LABELS[ctx.source]}: ${action.slice(LEGACY_AI_PREFIX.length)}`;
  }

  return { action, extras: Object.keys(resolved).length > 0 ? resolved : undefined };
}

/**
 * Append an audit entry. Never throws: auditing must not break the action it
 * records. If the trust columns are missing (a process started before
 * migrations ran), the entry is retried without them.
 *
 * Actor columns default to the current execution context (see
 * resolveAttribution), so tool-internal entries are attributed to whoever
 * called the tool. REST routes pass the session user explicitly
 * (middleware/session.ts sessionAuditActor).
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
  explicitExtras?: AuditExtras,
) {
  const attributed = resolveAttribution(rawAction, approved, explicitExtras);
  const extras = attributed.extras;
  const action = safeRedact(attributed.action);
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
