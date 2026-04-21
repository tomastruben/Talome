"use client";

import { CpuIcon } from "@/components/icons";
import { useSystemStats } from "@/hooks/use-system-stats";
import { StatTile } from "./stat-tile";

export function CpuWidget() {
  const { stats, history, isConnecting, error } = useSystemStats();
  return (
    <StatTile
      title="CPU"
      icon={CpuIcon}
      value={stats ? `${stats.cpu.usage.toFixed(1)}%` : undefined}
      subtitle={stats ? `${stats.cpu.cores} cores` : undefined}
      chartData={history.cpu}
      isLoading={!stats && isConnecting}
      error={!stats ? error : null}
    />
  );
}
