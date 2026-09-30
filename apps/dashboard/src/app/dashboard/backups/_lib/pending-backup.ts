import type { AppBackupOverview, BackupSummary } from "./types";

/**
 * A backup this page started with "Back up now", until it settles.
 *
 * The trigger answers `{ started, operationId }` as soon as the journaled
 * operation starts, so the receipt has to come later. It usually comes from a
 * new `lastBackup` row, but some failures (the app's compose can't be
 * resolved, the app is busy) end the operation without writing a row. Then the
 * operation itself is the answer, and a cap keeps a lost entry from pinning
 * the page to fast polling forever.
 */
export interface PendingBackup {
  name: string;
  /** `lastBackup.id` when the button was clicked. */
  previousBackupId: string | null;
  /** The journaled operation the trigger started, when it said. */
  operationId: string | null;
  /** When the trigger answered (epoch ms). */
  startedAt: number;
}

/** Without a visible operation or a new row for this long, stop waiting. */
export const PENDING_BACKUP_MAX_MS = 10 * 60 * 1000;

export type PendingBackupStep =
  /** Still running: keep polling. */
  | { kind: "wait" }
  /** The app is gone from the overview: forget it quietly. */
  | { kind: "drop" }
  /** A new backup row settled: its status is the receipt. */
  | { kind: "row"; backup: BackupSummary }
  /** The operation ended without a new row: ask the journal how it ended. */
  | { kind: "check-operation"; operationId: string }
  /** Nothing to go on for too long: stop waiting and say so. */
  | { kind: "expire" };

const UNSETTLED_ROW = new Set<BackupSummary["status"]>(["pending", "running"]);

export function nextPendingBackupStep(
  pending: PendingBackup,
  app: AppBackupOverview | undefined,
  now: number,
  maxMs: number = PENDING_BACKUP_MAX_MS,
): PendingBackupStep {
  if (!app) return { kind: "drop" };
  const last = app.lastBackup;
  const newRow = !!last && last.id !== pending.previousBackupId;
  if (newRow && !UNSETTLED_ROW.has(last.status)) return { kind: "row", backup: last };
  // The backup (or anything else on this app) is still running.
  if (app.operation || newRow) return { kind: "wait" };
  if (now - pending.startedAt > maxMs) return { kind: "expire" };
  // No operation and no new row: the operation ended without writing one.
  if (pending.operationId) return { kind: "check-operation", operationId: pending.operationId };
  return { kind: "wait" };
}

/** Receipt for a backup operation that ended without a new backup row. */
export function operationEndedReceipt(
  name: string,
  rec: { status: string; error: string | null; detail: Record<string, unknown> | null } | null,
): { kind: "success" | "error"; title: string; description?: string } | null {
  if (!rec) return { kind: "error", title: `Couldn't confirm the backup of ${name}`, description: "Check its row below or the notifications." };
  if (rec.status === "queued" || rec.status === "running") return null;
  const detailError = typeof rec.detail?.error === "string" ? rec.detail.error : null;
  if (rec.status === "succeeded" && !detailError) return { kind: "success", title: `Backed up ${name}` };
  return {
    kind: "error",
    title: `Couldn't back up ${name}`,
    description: rec.error ?? detailError ?? "Check the notifications for details.",
  };
}
