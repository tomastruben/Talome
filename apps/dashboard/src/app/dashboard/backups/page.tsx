"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import useSWR from "swr";
import { toast } from "sonner";
import { CORE_URL } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  HugeiconsIcon,
  ArchiveIcon,
  DatabaseRestoreIcon,
  MoreHorizontalIcon,
  Package01Icon,
  SecurityCheckIcon,
  Settings01Icon,
} from "@/components/icons";
import { relativeTime } from "@/lib/format";
import { fetchJson } from "@/lib/fetch-json";
import { StaleRow, useLoadedAt, useLoadingPhase } from "@/components/data-state/data-state";
import { useUser } from "@/hooks/use-user";
import { cn } from "@/lib/utils";
import { INLINE_BACKUP_ACTIONS_MIN_WIDTH, useMinWidth } from "./_lib/use-min-width";
import {
  BackupRequestError,
  METHOD_LABELS,
  backupErrorMessage,
  formatBytes,
  isForbiddenError,
  lastAttemptFailed,
  needsAttention,
  stageLabel,
  verificationState,
} from "./_lib/backup-status";
import type { AppBackupOverview } from "./_lib/types";
import { nextPendingBackupStep, operationEndedReceipt, type PendingBackup } from "./_lib/pending-backup";
import { parseOperationRecord } from "@/lib/app-operations";
import { VerificationBadge } from "./_components/verification-badge";
import { RestoreDialog } from "./_components/restore-dialog";
import { BackupSettingsSheet } from "./_components/backup-settings-sheet";
import { StorageSheet } from "./_components/storage-sheet";

const fetcher = (url: string) => fetchJson<AppBackupOverview[]>(url);

async function postJson(url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => null);
    throw new BackupRequestError(backupErrorMessage(res.status, data, `Request failed (${res.status})`), res.status);
  }
  return res.json().catch(() => null);
}

/** The journal row of one operation, or null when it can't be read. */
async function fetchOperation(operationId: string) {
  try {
    const res = await fetch(`${CORE_URL}/api/operations/${encodeURIComponent(operationId)}`, { credentials: "include" });
    if (!res.ok) return null;
    return parseOperationRecord(await res.json());
  } catch {
    return null;
  }
}

// ── Row pieces ────────────────────────────────────────────────────────────────

function AppIcon({ app }: { app: AppBackupOverview }) {
  const hasImage = app.iconUrl && !app.iconUrl.startsWith("file://");
  return (
    <div className="relative size-9 shrink-0 rounded-lg bg-muted/60 border border-border/40 flex items-center justify-center overflow-hidden text-lg">
      {hasImage ? (
        <Image src={app.iconUrl!} alt="" role="presentation" className="object-cover" fill />
      ) : app.icon && app.icon !== "📦" ? (
        <span>{app.icon}</span>
      ) : (
        <HugeiconsIcon icon={Package01Icon} size={18} className="text-dim-foreground" />
      )}
    </div>
  );
}

function LastBackupCell({ app }: { app: AppBackupOverview }) {
  if (app.operation) {
    return (
      <Shimmer as="span" duration={1.5} className="text-sm">
        {`${app.operation.kind === "restore" ? "Restoring" : "Backing up"} · ${stageLabel(app.operation.stage)}`}
      </Shimmer>
    );
  }
  const ok = app.lastSuccessfulBackup;
  const failed = lastAttemptFailed(app);
  return (
    <div className="grid gap-0.5 min-w-0">
      <span className="text-sm">{ok ? relativeTime(ok.completedAt ?? ok.startedAt) : "Never"}</span>
      {failed ? (
        <span className="text-sm text-status-critical truncate" title={app.lastBackup?.error ?? undefined}>
          Last attempt failed
        </span>
      ) : ok ? (
        <span className="text-sm text-muted-foreground">{formatBytes(ok.sizeBytes)}</span>
      ) : null}
    </div>
  );
}

function RowSkeleton({ actions }: { actions: boolean }) {
  return (
    <TableRow>
      <TableCell className="pl-4">
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-lg" />
          <div className="grid gap-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      </TableCell>
      <TableCell><Skeleton className="h-4 w-16" /></TableCell>
      <TableCell className="hidden @2xl:table-cell"><Skeleton className="h-4 w-20" /></TableCell>
      {actions && <TableCell><Skeleton className="h-8 w-40 ml-auto" /></TableCell>}
    </TableRow>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BackupsPage() {
  // Reads are open to every signed-in user; every change is admin-only on the
  // server, so members get a read-only status view.
  const { isAdmin: canManage, mutate: refreshUser } = useUser();
  const [restoreApp, setRestoreApp] = useState<AppBackupOverview | null>(null);
  const [settingsApp, setSettingsApp] = useState<AppBackupOverview | null>(null);
  const [storageOpen, setStorageOpen] = useState(false);
  // Backups whose verification this page started: backupId → app name (for the result toast)
  const pendingVerify = useRef(new Map<string, string>());

  // Backups this page started, until they settle (for the busy button and the receipt toast)
  const pendingBackup = useRef(new Map<string, PendingBackup>());
  // Operations whose journal row is being fetched, so a poll doesn't ask twice.
  const checkingOperations = useRef(new Set<string>());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const syncPendingIds = useCallback(() => setPendingIds(new Set(pendingBackup.current.keys())), []);
  const settlePendingBackups = useCallback(
    (latest: AppBackupOverview[]) => {
      const now = Date.now();
      for (const [appId, pending] of pendingBackup.current) {
        const step = nextPendingBackupStep(pending, latest.find((a) => a.appId === appId), now);
        if (step.kind === "wait") continue;
        if (step.kind === "check-operation") {
          // The operation ended without a new backup row: the journal says how.
          if (checkingOperations.current.has(step.operationId)) continue;
          checkingOperations.current.add(step.operationId);
          void fetchOperation(step.operationId).then((rec) => {
            checkingOperations.current.delete(step.operationId);
            if (pendingBackup.current.get(appId) !== pending) return;
            const receipt = operationEndedReceipt(pending.name, rec);
            if (!receipt) return; // still running per the journal: next poll
            pendingBackup.current.delete(appId);
            syncPendingIds();
            if (receipt.kind === "success") toast.success(receipt.title);
            else toast.error(receipt.title, { description: receipt.description });
          });
          continue;
        }
        pendingBackup.current.delete(appId);
        if (step.kind === "row") {
          if (step.backup.status === "completed") {
            toast.success(`Backed up ${pending.name} · checksums recorded`, {
              description: step.backup.sizeBytes != null ? formatBytes(step.backup.sizeBytes) : undefined,
            });
          } else {
            toast.error(`Couldn't back up ${pending.name}`, { description: step.backup.error ?? "Check the notifications for details." });
          }
        } else if (step.kind === "expire") {
          toast.error(`Couldn't confirm the backup of ${pending.name}`, { description: "Check its row below or the notifications." });
        }
      }
      syncPendingIds();
    },
    [syncPendingIds],
  );
  const { loadedAt, markLoaded } = useLoadedAt();
  const { data, error, isLoading, isValidating, mutate } = useSWR<AppBackupOverview[]>(`${CORE_URL}/api/backups/apps`, fetcher, {
    onSuccess: (latest) => {
      markLoaded();
      settlePendingBackups(latest);
    },
    // Poll quickly while anything is running, slowly otherwise
    refreshInterval: (latest?: AppBackupOverview[]) =>
      (latest ?? []).some((a) => a.operation !== null || a.lastSuccessfulBackup?.verifyStatus === "running") ||
      pendingVerify.current.size > 0 ||
      pendingBackup.current.size > 0
        ? 2_500
        : 30_000,
  });
  const apps = useMemo(() => data ?? [], [data]);
  // Nothing for the first 200ms of the first load, then a skeleton.
  const loadingPhase = useLoadingPhase(isLoading && !data);
  const showSkeleton = isLoading && !data;

  // Announce verification results once they land
  useEffect(() => {
    for (const [backupId, name] of pendingVerify.current) {
      const app = apps.find((a) => a.lastSuccessfulBackup?.id === backupId);
      const state = verificationState(app?.lastSuccessfulBackup);
      if (!app) {
        pendingVerify.current.delete(backupId);
        continue;
      }
      if (state !== "verified" && state !== "failed") continue;
      pendingVerify.current.delete(backupId);
      if (state === "verified") toast.success(`${name} backup verified`, { description: "Test restore and checksums passed." });
      else toast.error(`${name} backup failed verification`, { description: "Take a new backup and check the notifications for details." });
    }
  }, [apps]);

  const refresh = useCallback(() => void mutate(), [mutate]);

  function actionFailed(e: unknown, fallback: string) {
    toast.error(e instanceof Error ? e.message : fallback);
    // The role we hold is stale (e.g. changed in another tab): re-read it so
    // the admin-only actions disappear.
    if (isForbiddenError(e)) void refreshUser();
  }

  async function backupNow(app: AppBackupOverview) {
    if (pendingBackup.current.has(app.appId)) return;
    // Busy from the click, not from the next poll.
    pendingBackup.current.set(app.appId, {
      name: app.name,
      previousBackupId: app.lastBackup?.id ?? null,
      operationId: null,
      startedAt: Date.now(),
    });
    syncPendingIds();
    try {
      const started = await postJson(`${CORE_URL}/api/backups/trigger`, { appId: app.appId });
      const operationId =
        started && typeof started === "object" && typeof (started as { operationId?: unknown }).operationId === "string"
          ? (started as { operationId: string }).operationId
          : null;
      // Started, not done: the receipt comes when the backup (or its operation) has finished.
      const pending = pendingBackup.current.get(app.appId);
      if (pending) pendingBackup.current.set(app.appId, { ...pending, operationId, startedAt: Date.now() });
      refresh();
    } catch (e) {
      pendingBackup.current.delete(app.appId);
      syncPendingIds();
      actionFailed(e, "Backup failed to start");
    }
  }

  async function verifyNow(app: AppBackupOverview) {
    const backup = app.lastSuccessfulBackup;
    if (!backup) return;
    try {
      await postJson(`${CORE_URL}/api/backups/${backup.id}/verify`);
      pendingVerify.current.set(backup.id, app.name);
      refresh();
    } catch (e) {
      actionFailed(e, "Verification failed to start");
    }
  }

  const protectedCount = apps.filter((a) => a.lastSuccessfulBackup).length;
  const verifiedCount = apps.filter((a) => verificationState(a.lastSuccessfulBackup) === "verified").length;
  const attention = apps.filter(needsAttention);
  const appNames = useMemo(() => Object.fromEntries(apps.map((a) => [a.appId, a.name])), [apps]);
  const sorted = useMemo(
    () =>
      [...apps].sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || a.name.localeCompare(b.name)),
    [apps],
  );
  // Back up now, Verify now and Restore sit in the row when the list is wide
  // enough for them, else in its menu. Measured on the list, not the screen:
  // a desktop window's screen is the window, and the menu renders in a portal
  // outside every container query.
  const [listRef, inlineActions] = useMinWidth<HTMLDivElement>(INLINE_BACKUP_ACTIONS_MIN_WIDTH);

  return (
    <TooltipProvider>
      {/* A flex column filling the page (or the window's content), so the
          empty and error states centre in the space left */}
      <div ref={listRef} className="flex min-w-0 flex-1 flex-col gap-6">
        {/* Summary */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          {showSkeleton ? (
            loadingPhase === "skeleton" ? <Skeleton className="h-5 w-72" /> : <div className="h-5" />
          ) : !data ? null : (
            <p className="text-sm text-muted-foreground">
              <span className="text-foreground">{protectedCount}</span> of {apps.length} apps backed up
              <span className="mx-2">·</span>
              <span className="text-foreground">{verifiedCount}</span> verified
              {attention.length > 0 && (
                <>
                  <span className="mx-2">·</span>
                  <span className="text-status-warning">{attention.length} need attention</span>
                </>
              )}
            </p>
          )}
          {canManage && (
            <Button variant="ghost" size="sm" className="@lg:ml-auto text-muted-foreground" onClick={() => setStorageOpen(true)}>
              Storage &amp; retention
            </Button>
          )}
        </div>

        {/* The promise, where it's read first. */}
        <p className="-mt-3 text-sm text-muted-foreground">
          Every backup records a checksum for each file, and Talome test-restores it once a week.
        </p>

        {error && data && (
          <StaleRow loadedAt={loadedAt} subject="backups" onRetry={refresh} retrying={isValidating} />
        )}

        {error && !data ? (
          <ErrorState fill title="Couldn't load backups" description="Check that the Talome server is reachable, then retry." onRetry={refresh} />
        ) : showSkeleton && loadingPhase !== "skeleton" ? (
          <div className="min-h-64" aria-busy="true" />
        ) : !isLoading && apps.length === 0 ? (
          <EmptyState
            fill
            icon={ArchiveIcon}
            title="No apps to back up"
            description="Installed apps appear here with their backup and verification status."
            action={
              <Button variant="outline" size="sm" asChild>
                <Link href="/dashboard/apps">Browse App Store</Link>
              </Button>
            }
          />
        ) : (
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">App</TableHead>
                  <TableHead>Last backup</TableHead>
                  <TableHead className="hidden @2xl:table-cell">Verification</TableHead>
                  {canManage && <TableHead className="sr-only">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {showSkeleton
                  ? Array.from({ length: 5 }).map((_, i) => <RowSkeleton key={i} actions={canManage} />)
                  : sorted.map((app) => {
                      const ok = app.lastSuccessfulBackup;
                      const backingUp = pendingIds.has(app.appId);
                      const busyApp = app.operation !== null || backingUp;
                      const verifying = verificationState(ok) === "verifying";
                      return (
                        <TableRow key={app.appId} className="group">
                          <TableCell className="pl-4 py-3">
                            <div className="flex items-center gap-3 min-w-0">
                              <AppIcon app={app} />
                              <div className="grid gap-0.5 min-w-0">
                                <span className="text-sm font-medium truncate">{app.name}</span>
                                <span className="text-sm text-muted-foreground truncate">
                                  {app.effectiveMethod ? METHOD_LABELS[app.effectiveMethod] : "Not available"}
                                  {app.scheduled ? " · scheduled" : ""}
                                </span>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="py-3">
                            <LastBackupCell app={app} />
                            <VerificationBadge backup={ok} className="@2xl:hidden mt-1" />
                          </TableCell>
                          <TableCell className="hidden @2xl:table-cell py-3">
                            <VerificationBadge backup={ok} />
                          </TableCell>
                          {canManage && (
                            <TableCell className="py-3 pr-3">
                              <div className="flex items-center justify-end gap-1">
                                {inlineActions && (
                                  <>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      disabled={busyApp && !backingUp}
                                      busy={backingUp}
                                      busyLabel={`Backing up ${app.name}…`}
                                      onClick={() => void backupNow(app)}
                                    >
                                      <HugeiconsIcon icon={ArchiveIcon} size={16} />
                                      Back up now
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      disabled={!ok?.hasManifest || verifying || busyApp}
                                      onClick={() => void verifyNow(app)}
                                    >
                                      <HugeiconsIcon icon={SecurityCheckIcon} size={16} />
                                      Verify now
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      disabled={!ok || busyApp}
                                      onClick={() => setRestoreApp(app)}
                                    >
                                      <HugeiconsIcon icon={DatabaseRestoreIcon} size={16} />
                                      Restore
                                    </Button>
                                  </>
                                )}
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${app.name}`}>
                                      <HugeiconsIcon icon={MoreHorizontalIcon} size={16} />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="min-w-44">
                                    {!inlineActions && (
                                      <>
                                        <DropdownMenuItem disabled={busyApp} onSelect={() => void backupNow(app)}>
                                          <HugeiconsIcon icon={ArchiveIcon} size={16} />
                                          Back up now
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                          disabled={!ok?.hasManifest || verifying || busyApp}
                                          onSelect={() => void verifyNow(app)}
                                        >
                                          <HugeiconsIcon icon={SecurityCheckIcon} size={16} />
                                          Verify now
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                          disabled={!ok || busyApp}
                                          onSelect={() => setRestoreApp(app)}
                                        >
                                          <HugeiconsIcon icon={DatabaseRestoreIcon} size={16} />
                                          Restore
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator />
                                      </>
                                    )}
                                    <DropdownMenuItem onSelect={() => setSettingsApp(app)}>
                                      <HugeiconsIcon icon={Settings01Icon} size={16} />
                                      Backup settings
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
              </TableBody>
            </Table>
          </div>
        )}

        <p className={cn("text-sm text-muted-foreground", showSkeleton && "invisible")}>
          Verification unpacks a backup into a scratch folder, compares every file with its checksum and checks each
          database.
          {!canManage && " Only an admin can back up, verify or restore apps."}
        </p>
      </div>

      <RestoreDialog app={restoreApp} onOpenChange={(open) => !open && setRestoreApp(null)} onFinished={refresh} />
      <BackupSettingsSheet app={settingsApp} onOpenChange={(open) => !open && setSettingsApp(null)} onSaved={refresh} />
      <StorageSheet open={storageOpen} onOpenChange={setStorageOpen} appNames={appNames} />
    </TooltipProvider>
  );
}
