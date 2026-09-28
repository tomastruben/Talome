// ── Boot recovery for the operations journal ──────────────────────────────────
//
// A restart (crash, OOM, host reboot, self-update) can cut an operation short.
// On boot we:
//   1. mark every operation still queued/running as "interrupted" — we never
//      re-execute non-idempotent work automatically;
//   2. run a reconcile pass that inspects the app's real container state and
//      records what it found on the operation, and un-sticks installed_apps rows
//      left in "installing"/"updating" so status polling resumes;
//   3. mark automation runs that were mid-flight as interrupted.

import { eq, inArray, lt, and, isNotNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { InstalledAppStatus } from "@talome/types";
import { writeNotification } from "../db/notifications.js";
import { markInterruptedAutomationRuns } from "../automation/engine.js";
import { createLogger } from "../utils/logger.js";
import { findAppContainers } from "./docker-probe.js";
import {
  ACTIVE_OPERATION_STATUSES,
  HEARTBEAT_STALE_MS,
  OWNER_HOST,
  emitOperationEvent,
  hasLiveOperation,
  isForeignOwnerLive,
  listActiveOperationsInProcess,
  patchOperationDetail,
  rowToOperation,
  type OperationRecord,
} from "./operations.js";

const log = createLogger("ops-recovery");

const INTERRUPTED_MESSAGE = "Talome restarted while this operation was running";
const TRANSIENT_APP_STATUSES = ["installing", "updating"];

type OperationRow = typeof schema.appOperations.$inferSelect;

/**
 * An active row is still genuinely running when it is owned by this process's
 * in-memory lock table, or by another live process (e.g. the MCP stdio server)
 * whose heartbeat is fresh. Across hosts / PID namespaces only the heartbeat
 * counts (see isForeignOwnerLive).
 */
function isStillRunning(row: OperationRow, now: number, staleMs: number): boolean {
  if (listActiveOperationsInProcess().some((op) => op.id === row.id)) return true;
  const ownRow = row.ownerPid === process.pid && (!row.ownerHost || row.ownerHost === OWNER_HOST);
  if (ownRow) return false; // ours, but not in the lock table → orphaned
  return isForeignOwnerLive(row, now, staleMs);
}

/**
 * Mark queued/running operations that are no longer really running as
 * interrupted. Returns the affected operations.
 */
export function markInterruptedOperations(opts: { staleMs?: number } = {}): OperationRecord[] {
  const now = Date.now();
  const rows = db
    .select()
    .from(schema.appOperations)
    .where(inArray(schema.appOperations.status, ACTIVE_OPERATION_STATUSES))
    .all()
    .filter((row) => !isStillRunning(row, now, opts.staleMs ?? HEARTBEAT_STALE_MS));
  if (rows.length === 0) return [];

  const at = new Date().toISOString();
  db.transaction((tx) => {
    for (const row of rows) {
      tx.update(schema.appOperations)
        .set({ status: "interrupted", error: INTERRUPTED_MESSAGE, updatedAt: at, finishedAt: at })
        .where(eq(schema.appOperations.id, row.id))
        .run();
      tx.insert(schema.appOperationEvents)
        .values({
          operationId: row.id,
          appId: row.appId,
          status: "interrupted",
          step: row.step,
          progress: row.progress,
          message: INTERRUPTED_MESSAGE,
          createdAt: at,
        })
        .run();
    }
  });

  return rows.map((r) => rowToOperation({ ...r, status: "interrupted", error: INTERRUPTED_MESSAGE, updatedAt: at, finishedAt: at }));
}

export interface ReconcileFinding {
  appId: string;
  operationId: string | null;
  checkedAt: string;
  containers: { name: string; status: string; image: string }[];
  installedStatusBefore: string | null;
  installedStatusAfter: string | null;
  note: string;
  error?: string;
}

function observedStatus(containers: { status: string }[]): InstalledAppStatus {
  if (containers.some((c) => c.status === "running")) return "running";
  if (containers.length > 0) return "stopped";
  return "error";
}

function latestUnrolledSnapshotId(appId: string): number | null {
  try {
    const rows = db
      .select({ id: schema.updateSnapshots.id, rolledBack: schema.updateSnapshots.rolledBack })
      .from(schema.updateSnapshots)
      .where(eq(schema.updateSnapshots.appId, appId))
      .all();
    const candidates = rows.filter((r) => !r.rolledBack).map((r) => r.id);
    return candidates.length > 0 ? Math.max(...candidates) : null;
  } catch {
    return null;
  }
}

async function reconcileApp(
  appId: string,
  op: OperationRecord | null,
): Promise<ReconcileFinding> {
  const checkedAt = new Date().toISOString();
  const installed = db
    .select()
    .from(schema.installedApps)
    .where(eq(schema.installedApps.appId, appId))
    .get();

  const finding: ReconcileFinding = {
    appId,
    operationId: op?.id ?? null,
    checkedAt,
    containers: [],
    installedStatusBefore: installed?.status ?? null,
    installedStatusAfter: installed?.status ?? null,
    note: "",
  };

  let containers: Awaited<ReturnType<typeof findAppContainers>>;
  try {
    containers = await findAppContainers(appId, installed?.overrideComposePath ?? undefined);
  } catch (err) {
    finding.error = `Docker unavailable during reconcile: ${err instanceof Error ? err.message : String(err)}`;
    finding.note = "Could not inspect containers; app status left unchanged.";
    return finding;
  }

  finding.containers = containers.map((c) => ({ name: c.name, status: c.status, image: c.image }));
  const observed = observedStatus(containers);

  // A new install/update may have started since the interrupted one was marked
  // (boot delay, sweeper): its transient status is accurate — leave it alone.
  const liveOperation = hasLiveOperation(appId);
  if (installed && TRANSIENT_APP_STATUSES.includes(installed.status) && !liveOperation) {
    db.update(schema.installedApps)
      .set({
        status: observed,
        containerIds: containers.length > 0 ? JSON.stringify(containers.map((c) => c.id)) : installed.containerIds,
        updatedAt: checkedAt,
      })
      .where(eq(schema.installedApps.appId, appId))
      .run();
    finding.installedStatusAfter = observed;
  }

  const parts: string[] = [];
  parts.push(
    containers.length === 0
      ? "No containers found for this app."
      : `${containers.filter((c) => c.status === "running").length}/${containers.length} container(s) running.`,
  );
  if (op?.kind === "update" || op?.kind === "rollback") {
    const snapshotId = latestUnrolledSnapshotId(appId);
    parts.push(
      snapshotId !== null
        ? `The update did not finish. A rollback snapshot (#${snapshotId}) is available — use "rollback update" if the app misbehaves.`
        : "The update did not finish and no rollback snapshot was recorded.",
    );
  } else if (op?.kind === "install" && !installed) {
    parts.push("The install did not finish and the app was never registered. Install it again.");
  } else if (op?.kind === "install" && containers.length === 0) {
    parts.push("The install did not finish. Uninstall and install the app again.");
  }
  if (liveOperation) parts.push("Another operation on this app is now running, so its status was left to that operation.");
  parts.push("Nothing was re-run automatically.");
  finding.note = parts.join(" ");
  return finding;
}

/**
 * Inspect real container state for interrupted operations (and apps stuck in a
 * transient status) and record what was found. Never re-executes work.
 */
export async function reconcileInterruptedOperations(ops: OperationRecord[]): Promise<ReconcileFinding[]> {
  const findings: ReconcileFinding[] = [];
  const handled = new Set<string>();

  // Latest interrupted op per app (older ones just get the same finding)
  const byApp = new Map<string, OperationRecord[]>();
  for (const op of ops) {
    const list = byApp.get(op.appId) ?? [];
    list.push(op);
    byApp.set(op.appId, list);
  }

  for (const [appId, appOps] of byApp) {
    appOps.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const finding = await reconcileApp(appId, appOps[0]);
    findings.push(finding);
    handled.add(appId);
    for (const op of appOps) {
      try {
        patchOperationDetail(op.id, { reconcile: finding });
      } catch (err) {
        log.warn(`Failed to record reconcile finding on ${op.id}`, err);
      }
      emitOperationEvent({
        operationId: op.id,
        appId,
        kind: op.kind,
        actor: op.actor,
        status: "interrupted",
        step: op.step,
        progress: op.progress,
        message: finding.note,
        at: finding.checkedAt,
      });
    }
  }

  // Apps stuck in installing/updating with no journaled operation (legacy crash)
  try {
    const stuck = db
      .select({ appId: schema.installedApps.appId })
      .from(schema.installedApps)
      .where(inArray(schema.installedApps.status, TRANSIENT_APP_STATUSES))
      .all();
    for (const row of stuck) {
      if (handled.has(row.appId)) continue;
      // Legitimately installing/updating right now — not stuck.
      if (hasLiveOperation(row.appId)) continue;
      findings.push(await reconcileApp(row.appId, null));
    }
  } catch (err) {
    log.warn("Failed to reconcile stuck installed apps", err);
  }

  if (ops.length > 0) {
    const names = [...byApp.keys()].join(", ");
    writeNotification(
      "warning",
      "Operations interrupted by restart",
      `${ops.length} operation(s) were cut short when Talome restarted (${names}). Their current state was checked and recorded; nothing was re-run automatically.`,
      "ops",
    );
  }

  return findings;
}

/** Remove terminal operations (and their step history) older than `days`. */
export function pruneOperationHistory(days = 180): number {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const old = db
    .select({ id: schema.appOperations.id })
    .from(schema.appOperations)
    .where(and(isNotNull(schema.appOperations.finishedAt), lt(schema.appOperations.finishedAt, cutoff)))
    .all()
    .map((r) => r.id);
  if (old.length === 0) return 0;
  for (let i = 0; i < old.length; i += 500) {
    const chunk = old.slice(i, i + 500);
    db.delete(schema.appOperationEvents).where(inArray(schema.appOperationEvents.operationId, chunk)).run();
    db.delete(schema.appOperations).where(inArray(schema.appOperations.id, chunk)).run();
  }
  return old.length;
}

let sweeper: ReturnType<typeof setInterval> | null = null;

/**
 * Periodically interrupt operations whose owner stopped heartbeating (e.g. an
 * MCP stdio process killed mid-operation) and reconcile their apps.
 */
export function startOperationSweeper(intervalMs = 60_000): () => void {
  if (sweeper) return stopOperationSweeper;
  sweeper = setInterval(() => {
    try {
      const stale = markInterruptedOperations({ staleMs: HEARTBEAT_STALE_MS * 2 });
      if (stale.length > 0) {
        log.warn(`Interrupted ${stale.length} operation(s) with a stale heartbeat`);
        void reconcileInterruptedOperations(stale).catch((err: unknown) => log.error("Sweeper reconcile failed", err));
      }
    } catch (err) {
      log.warn("Operation sweeper failed", err);
    }
  }, intervalMs);
  sweeper.unref?.();
  return stopOperationSweeper;
}

export function stopOperationSweeper(): void {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

export interface BootRecoveryResult {
  interruptedOperations: OperationRecord[];
  interruptedAutomationRuns: number;
  /** Resolves when the (async) container reconcile pass has finished. */
  reconciled: Promise<ReconcileFinding[]>;
}

/**
 * Call once at boot, after migrations. The DB marking is synchronous (before
 * any new operation can start); the Docker reconcile runs after `delayMs`.
 */
export function recoverOperationsOnBoot(opts: { delayMs?: number; sweeper?: boolean } = {}): BootRecoveryResult {
  let interruptedOperations: OperationRecord[] = [];
  try {
    interruptedOperations = markInterruptedOperations();
    if (interruptedOperations.length > 0) {
      log.warn(`Marked ${interruptedOperations.length} interrupted app operation(s)`);
    }
  } catch (err) {
    log.error("Failed to mark interrupted operations", err);
  }

  let interruptedAutomationRuns = 0;
  try {
    interruptedAutomationRuns = markInterruptedAutomationRuns();
    if (interruptedAutomationRuns > 0) {
      log.warn(`Marked ${interruptedAutomationRuns} interrupted automation run(s)`);
    }
  } catch (err) {
    log.error("Failed to mark interrupted automation runs", err);
  }

  try {
    const pruned = pruneOperationHistory();
    if (pruned > 0) log.info(`Pruned ${pruned} old operation record(s)`);
  } catch (err) {
    log.warn("Failed to prune operation history", err);
  }

  if (opts.sweeper !== false) startOperationSweeper();

  const reconciled = new Promise<ReconcileFinding[]>((resolve) => {
    const timer = setTimeout(() => {
      reconcileInterruptedOperations(interruptedOperations)
        .then(resolve)
        .catch((err: unknown) => {
          log.error("Reconcile pass failed", err);
          resolve([]);
        });
    }, opts.delayMs ?? 5_000);
    timer.unref?.();
  });

  return { interruptedOperations, interruptedAutomationRuns, reconciled };
}
