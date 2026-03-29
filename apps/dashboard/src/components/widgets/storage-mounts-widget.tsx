"use client";

import { useSystemStats } from "@/hooks/use-system-stats";
import { formatBytes } from "@/lib/format";
import { Widget, WidgetHeader } from "./widget";
import { HugeiconsIcon, HardDriveIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { WidgetList, WidgetListState } from "./list-widget";

/** Derive a short, readable label from a mount path */
function mountLabel(path: string): string {
  if (path === "/") return "System";
  // /Volumes/Media Hub → Media Hub
  if (path.startsWith("/Volumes/")) return path.slice("/Volumes/".length);
  // /media/user/drive → drive
  if (path.startsWith("/media/")) return path.split("/").pop() ?? path;
  if (path.startsWith("/mnt/")) return path.split("/").pop() ?? path;
  return path;
}

export function StorageMountsWidget() {
  const { stats, isConnecting } = useSystemStats();

  const HIDDEN_PREFIXES = [
    "/private/var/run/com.apple.",
    "/Library/Developer/",
    "/System/Volumes/",
  ];
  const HIDDEN_NAMES = ["TalomeHLS"];

  const mounts = (stats?.disk.mounts ?? []).filter((m) => {
    if (HIDDEN_PREFIXES.some((p) => m.mount.startsWith(p))) return false;
    if (m.fs?.includes(":/")) return false; // virtual container fs (OrbStack, Lima)
    const name = m.mount.split("/").pop() ?? "";
    if (HIDDEN_NAMES.includes(name)) return false;
    return true;
  });

  return (
    <Widget>
      <WidgetHeader title="Storage" href="/dashboard/files" hrefLabel="View files" />
      {isConnecting && !stats ? (
        <WidgetListState icon={HardDriveIcon} message="Loading storage..." />
      ) : mounts.length === 0 ? (
        <WidgetListState icon={HardDriveIcon} message="No mount data." />
      ) : (
        <WidgetList>
          <div className="divide-y divide-border/40">
            {mounts.map((mount) => {
              const label = mountLabel(mount.mount);
              return (
                <div key={mount.mount} className="px-4 py-2.5 grid gap-1.5">
                  <div className="flex items-center justify-between gap-3 min-w-0">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <HugeiconsIcon icon={HardDriveIcon} size={13} className="text-dim-foreground shrink-0" />
                      <p className="text-sm font-medium truncate" title={mount.mount}>{label}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-muted-foreground uppercase tracking-wide">
                        {mount.type ?? mount.fs}
                      </span>
                      <span
                        className={cn(
                          "text-xs tabular-nums font-medium",
                          mount.percent >= 90
                            ? "text-destructive"
                            : mount.percent >= 75
                              ? "text-status-warning"
                              : "text-muted-foreground",
                        )}
                      >
                        {mount.percent.toFixed(0)}%
                      </span>
                    </div>
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-border/60">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        mount.percent >= 90
                          ? "bg-destructive"
                          : mount.percent >= 75
                            ? "bg-status-warning"
                            : "bg-foreground/25",
                      )}
                      style={{ width: `${Math.min(mount.percent, 100)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums gap-x-2">
                    <span>{formatBytes(mount.totalBytes - mount.usedBytes)} free</span>
                    <span>{formatBytes(mount.usedBytes)} / {formatBytes(mount.totalBytes)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </WidgetList>
      )}
    </Widget>
  );
}
