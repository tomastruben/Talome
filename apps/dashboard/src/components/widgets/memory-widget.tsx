"use client";

import { RamMemoryIcon } from "@/components/icons";
import { useSystemStats } from "@/hooks/use-system-stats";
import { formatBytes } from "@/lib/format";
import { StatTile } from "./stat-tile";

export function MemoryWidget() {
  const { stats, history, isConnecting, error } = useSystemStats();
  return (
    <StatTile
      title="Memory"
      icon={RamMemoryIcon}
      value={stats ? `${stats.memory.percent.toFixed(1)}%` : undefined}
      subtitle={stats ? `${formatBytes(stats.memory.usedBytes)} / ${formatBytes(stats.memory.totalBytes)}` : undefined}
      chartData={history.memory}
      isLoading={!stats && isConnecting}
      error={!stats ? error : null}
    />
  );
}
