"use client";

import { Database01Icon } from "@/components/icons";
import { useSystemStats } from "@/hooks/use-system-stats";
import { formatBytes } from "@/lib/format";
import { StatTile } from "./stat-tile";

export function DiskWidget() {
  const { stats, history, isConnecting, error } = useSystemStats();
  return (
    <StatTile
      title="Disk"
      icon={Database01Icon}
      value={stats ? `${stats.disk.percent.toFixed(1)}%` : undefined}
      subtitle={stats ? `${formatBytes(stats.disk.usedBytes)} / ${formatBytes(stats.disk.totalBytes)}` : undefined}
      chartData={history.disk}
      isLoading={!stats && isConnecting}
      error={!stats ? error : null}
    />
  );
}
