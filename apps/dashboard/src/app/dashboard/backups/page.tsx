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
import { relativeTime } from "@/components/settings/settings-primitives";
import { useUser } from "@/hooks/use-user";
import { cn } from "@/lib/utils";
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
import { VerificationBadge } from "./_components/verification-badge";
import { RestoreDialog } from "./_components/restore-dialog";
import { BackupSettingsSheet } from "./_components/backup-settings-sheet";
import { StorageSheet } from "./_components/storage-sheet";

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Request failed (${r.status})`);
    return r.json();
  });

async function postJson(url: string, body?: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => null);
    throw new BackupRequestError(backupErrorMessage(res.status, data, `Request failed (${res.status})`), res.status);
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
      <TableCell className="hidden md:table-cell"><Skeleton className="h-4 w-20" /></TableCell>
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

  const { data, error, isLoading, mutate } = useSWR<AppBackupOverview[]>(`${CORE_URL}/api/backups/apps`, fetcher, {
    // Poll quickly while anything is running, slowly otherwise
    refreshInterval: (latest?: AppBackupOverview[]) =>
      (latest ?? []).some((a) => a.operation !== null || a.lastSuccessfulBackup?.verifyStatus === "running") ||
      pendingVerify.current.size > 0
        ? 2_500
        : 30_000,
  });
  const apps = useMemo(() => data ?? [], [data]);

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
    try {
      await postJson(`${CORE_URL}/api/backups/trigger`, { appId: app.appId });
      toast.success(`Backing up ${app.name}`);
      refresh();
    } catch (e) {
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

  return (
    <TooltipProvider>
      <div className="grid gap-6">
        {/* Summary */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          {isLoading ? (
            <Skeleton className="h-5 w-72" />
          ) : (
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
            <Button variant="ghost" size="sm" className="sm:ml-auto text-muted-foreground" onClick={() => setStorageOpen(true)}>
              Storage &amp; retention
            </Button>
          )}
        </div>

        {error ? (
          <ErrorState title="Couldn't load backups" description="Check that the Talome server is reachable." onRetry={refresh} />
        ) : !isLoading && apps.length === 0 ? (
          <EmptyState
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
                  <TableHead className="hidden md:table-cell">Verification</TableHead>
                  {canManage && <TableHead className="sr-only">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading
                  ? Array.from({ length: 5 }).map((_, i) => <RowSkeleton key={i} actions={canManage} />)
                  : sorted.map((app) => {
                      const ok = app.lastSuccessfulBackup;
                      const busyApp = app.operation !== null;
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
                            <VerificationBadge backup={ok} className="md:hidden mt-1" />
                          </TableCell>
                          <TableCell className="hidden md:table-cell py-3">
                            <VerificationBadge backup={ok} />
                          </TableCell>
                          {canManage && (
                            <TableCell className="py-3 pr-3">
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="hidden sm:inline-flex"
                                  disabled={!ok?.hasManifest || verifying || busyApp}
                                  onClick={() => void verifyNow(app)}
                                >
                                  <HugeiconsIcon icon={SecurityCheckIcon} size={16} />
                                  Verify now
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="hidden sm:inline-flex"
                                  disabled={!ok || busyApp}
                                  onClick={() => setRestoreApp(app)}
                                >
                                  <HugeiconsIcon icon={DatabaseRestoreIcon} size={16} />
                                  Restore
                                </Button>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${app.name}`}>
                                      <HugeiconsIcon icon={MoreHorizontalIcon} size={16} />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="min-w-44">
                                    <DropdownMenuItem disabled={busyApp} onSelect={() => void backupNow(app)}>
                                      <HugeiconsIcon icon={ArchiveIcon} size={16} />
                                      Back up now
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      className="sm:hidden"
                                      disabled={!ok?.hasManifest || verifying || busyApp}
                                      onSelect={() => void verifyNow(app)}
                                    >
                                      <HugeiconsIcon icon={SecurityCheckIcon} size={16} />
                                      Verify now
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      className="sm:hidden"
                                      disabled={!ok || busyApp}
                                      onSelect={() => setRestoreApp(app)}
                                    >
                                      <HugeiconsIcon icon={DatabaseRestoreIcon} size={16} />
                                      Restore
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
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

        <p className={cn("text-sm text-muted-foreground", isLoading && "invisible")}>
          Every backup records a checksum for each file. Verification unpacks it into a scratch folder, compares every
          file and checks each database, and runs automatically once a week.
          {!canManage && " Only an admin can back up, verify or restore apps."}
        </p>
      </div>

      <RestoreDialog app={restoreApp} onOpenChange={(open) => !open && setRestoreApp(null)} onFinished={refresh} />
      <BackupSettingsSheet app={settingsApp} onOpenChange={(open) => !open && setSettingsApp(null)} onSaved={refresh} />
      <StorageSheet open={storageOpen} onOpenChange={setStorageOpen} appNames={appNames} />
    </TooltipProvider>
  );
}
