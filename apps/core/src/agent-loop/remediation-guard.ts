// ── Remediation write calls ↔ app operations ────────────────────────────────
//
// checkRemediationGuard (app-scope.ts) runs once, before remediation starts.
// But the model then works for tens of seconds, and an owner-approved call
// can run hours later (resumeApprovedRemediation): an update, backup or
// restore may have started on the app in between. Every remediation WRITE
// call — on the API path, on the Claude Code path (through the MCP stdio
// server) and when the owner's approval resumes it — is therefore checked
// again right before it runs, against the app it targets:
//
//  - restart_container / rollback_update / jellyfin_scan_library: refused
//    while the target app has a live operation (any process) or is in a
//    maintenance window, or the container is stopped on purpose;
//  - cleanup_docker (a real prune): refused while ANY app is under an
//    operation — pruning removes stopped containers, including ones a
//    stop-method backup or an update is holding;
//  - rollback_update proposed for an event: refused when the app has a newer
//    update snapshot than the one the event was about (the owner already
//    moved it to another version), or it was already rolled back.
//
// A refused call does not run; an approved call stays approved (not consumed)
// so it can run once the operation is over.

import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { writeAuditEntry } from "../db/audit.js";
import type { Actor } from "../ai/actor-context.js";
import { checkRemediationGuard, type EventLike } from "./app-scope.js";
import { appsUnderOperation, isContainerUnderOperation } from "../ops/maintenance.js";
import { installedAppIdsCached, isAppInMaintenance, listAppOperations } from "../backup/state.js";
import { REMEDIATION_ACTOR, REMEDIATION_WRITE_TOOLS } from "./remediation-actor.js";

export interface RemediationCallCheck {
  blocked: boolean;
  reason?: string;
  /** The call no longer fits the situation (a stale rollback): never run it later either. */
  stale?: boolean;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The app/container a remediation write call acts on (null: none known). */
function callTarget(toolName: string, args: Record<string, unknown>): EventLike | null {
  switch (toolName) {
    case "restart_container": {
      const container = str(args.containerId);
      return container ? { source: container, data: { containerName: container, containerId: container } } : null;
    }
    case "rollback_update": {
      const appId = str(args.appId);
      return appId ? { source: appId, data: { appId } } : null;
    }
    case "jellyfin_scan_library":
      return { source: "jellyfin", data: { appId: "jellyfin" } };
    default:
      return null;
  }
}

/** Apps being changed on purpose right now (any process), including held backups and maintenance windows. */
function busyApps(): string[] {
  const busy = new Set(appsUnderOperation());
  for (const op of listAppOperations()) busy.add(op.appId);
  for (const appId of installedAppIdsCached()) if (isAppInMaintenance(appId)) busy.add(appId);
  return [...busy].sort();
}

/**
 * A rollback proposed for an update is stale when the app has a newer update
 * snapshot than the one the event concerned (or, without that id, one taken
 * after `since`), or when that update was already rolled back.
 */
export function staleRollbackReason(appId: string, eventSnapshotId: unknown, since?: string | null): string | null {
  let latest: { id: number; createdAt: string; rolledBack: boolean } | undefined;
  try {
    latest = db
      .select({ id: schema.updateSnapshots.id, createdAt: schema.updateSnapshots.createdAt, rolledBack: schema.updateSnapshots.rolledBack })
      .from(schema.updateSnapshots)
      .where(eq(schema.updateSnapshots.appId, appId))
      .orderBy(desc(schema.updateSnapshots.id))
      .limit(1)
      .get();
  } catch {
    return null;
  }
  if (!latest) return null; // nothing to roll back — the tool reports that itself
  const snapshotId = typeof eventSnapshotId === "number" ? eventSnapshotId : Number.NaN;
  if (Number.isFinite(snapshotId) && latest.id !== snapshotId) {
    return `${appId} was updated again after this rollback was proposed`;
  }
  if (!Number.isFinite(snapshotId) && since && latest.createdAt > since) {
    return `${appId} was updated again after this rollback was proposed`;
  }
  if (latest.rolledBack) return `${appId} was already rolled back`;
  return null;
}

/**
 * May this remediation write call run right now? `event` (when known) is
 * re-checked too: its app may have started an operation since remediation
 * began. Read tools are never refused here.
 */
export function checkRemediationCall(
  toolName: string,
  args: Record<string, unknown>,
  event?: EventLike | null,
  options: { proposedAt?: string | null } = {},
): RemediationCallCheck {
  if (!REMEDIATION_WRITE_TOOLS.has(toolName)) return { blocked: false };

  if (event) {
    const guard = checkRemediationGuard(event);
    if (guard.blocked) return { blocked: true, reason: guard.reason };
  }

  if (toolName === "cleanup_docker") {
    if (args.dryRun !== false) return { blocked: false }; // a dry run changes nothing
    const busy = busyApps();
    return busy.length > 0
      ? { blocked: true, reason: `operations are changing ${busy.join(", ")} — a prune now could remove their stopped containers` }
      : { blocked: false };
  }

  const target = callTarget(toolName, args);
  if (!target) return { blocked: false };
  const guard = checkRemediationGuard(target);
  if (guard.blocked) return { blocked: true, reason: guard.reason };
  const name = str(target.data.containerName);
  const id = str(target.data.containerId);
  if ((name || id) && isContainerUnderOperation(name, id)) {
    return { blocked: true, reason: `${name ?? id} is being changed by an operation` };
  }
  if (guard.appId && appsUnderOperation().has(guard.appId)) {
    return { blocked: true, reason: `an operation is changing ${guard.appId}` };
  }

  if (toolName === "rollback_update" && event) {
    const appId = str(args.appId);
    const stale = appId ? staleRollbackReason(appId, event.data.snapshotId, options.proposedAt) : null;
    if (stale) return { blocked: true, reason: stale, stale: true };
  }
  return { blocked: false };
}

/** What the model is told when a write call was deferred. */
export function deferredCallResult(reason: string): { status: "deferred"; error: string } {
  return {
    status: "deferred",
    error: `Not run: ${reason}. Do not retry it in this run; finish with your diagnosis and say why it did not run.`,
  };
}

/**
 * MCP session options for the stdio server Claude Code launches for
 * remediation (mcp-stdio.ts): every write call is checked right before it
 * runs. Other actors get no extra check.
 */
export function remediationMcpSessionOptions(actor: Actor): {
  beforeCall?: (toolName: string, args: Record<string, unknown>) => string | null;
} {
  if (actor.kind !== REMEDIATION_ACTOR.kind || actor.id !== REMEDIATION_ACTOR.id) return {};
  return {
    beforeCall: (toolName, args) => {
      const check = checkRemediationCall(toolName, args);
      if (!check.blocked) return null;
      writeAuditEntry(`DEFERRED: ${toolName}`, "modify", check.reason ?? "", false, {
        actorKind: actor.kind,
        actorId: actor.id,
        actorLabel: actor.label,
        source: "mcp",
        toolName,
        outcome: "blocked",
      });
      return deferredCallResult(check.reason ?? "an operation is running").error;
    },
  };
}
