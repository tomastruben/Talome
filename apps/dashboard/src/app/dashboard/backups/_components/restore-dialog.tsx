"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { CORE_URL } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { HugeiconsIcon, AlertCircleIcon, CheckmarkCircle02Icon, Shield01Icon } from "@/components/icons";
import { relativeTime } from "@/components/settings/settings-primitives";
import { cn } from "@/lib/utils";
import {
  METHOD_LABELS,
  backupErrorMessage,
  defaultRestoreChoice,
  formatBytes,
  restorableBackups,
  stageLabel,
  verificationState,
} from "../_lib/backup-status";
import type { AppBackupDetail, AppBackupOverview, RestoreRun } from "../_lib/types";
import { VerificationBadge } from "./verification-badge";

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Request failed (${r.status})`);
    return r.json();
  });

type Phase = "confirm" | "running" | "done";

function describeBackup(b: { completedAt: string | null; startedAt: string; purpose: string | null }): string {
  const when = new Date(b.completedAt ?? b.startedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  if (b.purpose === "pre-restore") return `${when} · safety copy`;
  if (b.purpose === "pre-update") return `${when} · before update`;
  return when;
}

interface RestoreDialogProps {
  app: AppBackupOverview | null;
  onOpenChange: (open: boolean) => void;
  onFinished: () => void;
}

export function RestoreDialog({ app, onOpenChange, onFinished }: RestoreDialogProps) {
  const open = app !== null;
  const { data: detail, isLoading, mutate: refreshDetail } = useSWR<AppBackupDetail>(
    open ? `${CORE_URL}/api/backups/apps/${encodeURIComponent(app.appId)}` : null,
    fetcher,
  );
  const [selectedId, setSelectedId] = useState<string>("");
  const [phase, setPhase] = useState<Phase>("confirm");
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const backups = useMemo(() => restorableBackups(detail?.backups ?? []), [detail]);
  const selected = backups.find((b) => b.id === selectedId) ?? null;
  const verification = verificationState(selected);

  useEffect(() => {
    if (!open) {
      setPhase("confirm");
      setRestoreId(null);
      setSelectedId("");
      return;
    }
    if (!selectedId && detail) setSelectedId(defaultRestoreChoice(detail.backups)?.id ?? "");
  }, [open, detail, selectedId]);

  const { data: run } = useSWR<RestoreRun>(
    restoreId ? `${CORE_URL}/api/backups/restores/${restoreId}` : null,
    fetcher,
    { refreshInterval: phase === "running" ? 1500 : 0 },
  );

  useEffect(() => {
    if (phase !== "running" || !run || run.status === "running") return;
    setPhase("done");
    onFinished();
    // The dialog shows the full outcome; the toast is the one-line receipt.
    const name = app?.name ?? "The app";
    if (run.status === "completed") toast.success(`Restored ${name} · running again`);
    else if (run.status === "rolled_back") toast.error(`Couldn't restore ${name} · its previous data was put back`);
    else toast.error(`Couldn't restore ${name}`, { description: run.error ?? undefined });
  }, [run, phase, app, onFinished]);

  async function startRestore() {
    if (!selected || !app) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${CORE_URL}/api/backups/${selected.id}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const body = (await res.json().catch(() => ({}))) as { restoreId?: string; error?: string };
      if (!res.ok || !body.restoreId) throw new Error(backupErrorMessage(res.status, body, "Could not start the restore"));
      setRestoreId(body.restoreId);
      setPhase("running");
      onFinished();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start the restore");
    } finally {
      setSubmitting(false);
    }
  }

  const busy = phase === "running";
  const dateText = selected ? describeBackup(selected) : "";

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg" onInteractOutside={(e) => busy && e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>
            {phase === "done"
              ? run?.status === "completed"
                ? `${app?.name} restored`
                : "Restore didn't complete"
              : `Restore ${app?.name ?? ""}`}
          </DialogTitle>
          {phase === "confirm" && (
            <DialogDescription>Replace the app&apos;s current data with a backup.</DialogDescription>
          )}
        </DialogHeader>

        {phase === "confirm" && (
          <div className="grid gap-6">
            {isLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : backups.length === 0 ? (
              <p className="text-sm text-muted-foreground">There are no restorable backups for this app yet.</p>
            ) : (
              <div className="grid gap-2">
                <Select value={selectedId} onValueChange={setSelectedId}>
                  <SelectTrigger className="w-full" aria-label="Backup to restore">
                    <SelectValue placeholder="Choose a backup" />
                  </SelectTrigger>
                  <SelectContent>
                    {backups.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {describeBackup(b)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selected && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                    <VerificationBadge backup={selected} />
                    {selected.method && <span>{METHOD_LABELS[selected.method]}</span>}
                    <span>{formatBytes(selected.sizeBytes)}</span>
                  </div>
                )}
              </div>
            )}

            {selected && (
              <ul className="grid gap-3 text-sm">
                <li className="flex gap-3">
                  <HugeiconsIcon icon={AlertCircleIcon} size={16} className="mt-0.5 shrink-0 text-status-warning" />
                  <span>
                    {app?.name} will be stopped and its data replaced with the backup from {dateText}. Changes made since then
                    will be lost.
                  </span>
                </li>
                <li className="flex gap-3">
                  <HugeiconsIcon icon={Shield01Icon} size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground">
                    A safety copy of the current data is saved first. If the app doesn&apos;t come back healthy, Talome puts
                    the current data back automatically.
                  </span>
                </li>
              </ul>
            )}

            {verification === "failed" && (
              <p className="text-sm text-status-critical">
                This backup failed verification and can&apos;t be restored safely. Choose another backup.
              </p>
            )}
            {verification === "unverified" && (
              <p className="text-sm text-muted-foreground">
                This backup hasn&apos;t been verified yet. Its checksums are still checked before anything is changed.
              </p>
            )}
          </div>
        )}

        {phase === "running" && (
          <div className="flex items-center gap-3 py-6">
            <Spinner />
            <p className="text-sm">{stageLabel(run?.stage ?? "checking")}…</p>
          </div>
        )}

        {phase === "done" && run && (
          <div className="grid gap-3 text-sm">
            <div className="flex gap-3">
              <HugeiconsIcon
                icon={run.status === "completed" ? CheckmarkCircle02Icon : AlertCircleIcon}
                size={16}
                className={cn(
                  "mt-0.5 shrink-0",
                  run.status === "completed" ? "text-status-healthy" : "text-status-critical",
                )}
              />
              <p>
                {run.status === "completed"
                  ? run.detail?.health?.detail ?? "The app is running again."
                  : run.error ?? "The restore failed."}
              </p>
            </div>
            {run.status === "rolled_back" && (
              <p className="text-muted-foreground">
                The app was returned to the state it was in before the restore.
              </p>
            )}
            {run.status === "completed" && run.safety_backup_id && (
              <p className="text-muted-foreground">
                A safety copy of the data from before the restore is kept in the backup list. Undo restore puts it back.
              </p>
            )}
            {run.status === "failed" && run.safety_backup_id && (
              <p className="text-muted-foreground">
                The safety copy from {relativeTime(run.started_at)} is available in the backup list.
              </p>
            )}
            {(run.detail?.warnings ?? []).map((w) => (
              <p key={w} className="text-muted-foreground">
                {w}
              </p>
            ))}
          </div>
        )}

        <DialogFooter>
          {phase === "confirm" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={startRestore}
                disabled={!selected || submitting || verification === "failed"}
              >
                {submitting ? "Starting…" : `Restore ${app?.name ?? ""}`}
              </Button>
            </>
          )}
          {phase === "done" && run?.status === "completed" && run.safety_backup_id && (
            <Button
              variant="outline"
              onClick={() => {
                // Back to the confirm step with the safety copy chosen: the
                // same consequences are shown before anything changes.
                const safetyId = run.safety_backup_id!;
                void refreshDetail().then(() => {
                  setSelectedId(safetyId);
                  setRestoreId(null);
                  setPhase("confirm");
                });
              }}
            >
              Undo restore
            </Button>
          )}
          {phase === "done" && <Button onClick={() => onOpenChange(false)}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
