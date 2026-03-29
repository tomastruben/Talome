"use client";

import useSWR from "swr";
import Link from "next/link";
import { Widget, WidgetHeader } from "./widget";
import { CORE_URL } from "@/lib/constants";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface BackupStatus {
  lastBackup: { completed_at: string; size_bytes: number; app_id: string | null } | null;
  nextSchedule: { cron: string } | null;
  failedCount: number;
}

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return "never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${bytes} B`;
}

export function BackupStatusWidget() {
  const { data } = useSWR<BackupStatus>(
    `${CORE_URL}/api/backups/status`,
    fetcher,
    { refreshInterval: 60_000 },
  );

  const last = data?.lastBackup;
  const hasSchedule = !!data?.nextSchedule;
  const failedCount = data?.failedCount ?? 0;

  return (
    <Widget>
      <WidgetHeader title="Backups" />
      <Link href="/dashboard/settings/backups" className="block min-h-0 flex-1 px-4 py-3 hover:bg-muted/20 transition-colors">
        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Last backup</span>
            <span className="text-xs text-foreground">
              {last ? relativeTime(last.completed_at) : "never"}
            </span>
          </div>
          {last?.size_bytes && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Size</span>
              <span className="text-xs text-foreground">{formatSize(last.size_bytes)}</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Schedule</span>
            <span className="text-xs text-foreground">
              {hasSchedule ? data!.nextSchedule!.cron : "none"}
            </span>
          </div>
          {failedCount > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Failed (7d)</span>
              <span className="text-xs text-destructive">{failedCount}</span>
            </div>
          )}
        </div>
      </Link>
    </Widget>
  );
}
