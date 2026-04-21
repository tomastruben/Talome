"use client";

import { StatCard } from "@/components/dashboard/stat-card";
import { CpuIcon, RamMemoryIcon, Database01Icon, Wifi01Icon, AlertCircleIcon } from "@/components/icons";
import { HugeiconsIcon } from "@/components/icons";
import { useSystemStats } from "@/hooks/use-system-stats";
import { formatBytes } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";

// Renders 4 stat cards in a sub-grid — the WidgetWrapper handles col-span-2
export function SystemHealthWidget() {
  const { stats, error, history } = useSystemStats();

  if (error) {
    return (
    <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
        <div className="col-span-2 lg:col-span-4 flex items-center gap-3 rounded-xl border border-destructive/15 bg-destructive/5 px-4 py-3">
          <HugeiconsIcon
            icon={AlertCircleIcon}
            size={15}
            className="text-destructive shrink-0"
            strokeWidth={1.5}
          />
          <p className="text-sm text-muted-foreground">
            System stats unavailable —{" "}
            <span className="text-muted-foreground">{error}</span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
      {stats ? (
        <>
          <StatCard
            title="CPU"
            value={stats.cpu.usage}
            suffix="%"
            subtitle={`${stats.cpu.cores} cores — ${stats.cpu.model}`}
            icon={CpuIcon}
            showBar
            history={history.cpu}
          />
          <StatCard
            title="Memory"
            value={stats.memory.percent}
            suffix="%"
            subtitle={`${formatBytes(stats.memory.usedBytes)} / ${formatBytes(stats.memory.totalBytes)}`}
            icon={RamMemoryIcon}
            showBar
            history={history.memory}
          />
          <StatCard
            title="Disk"
            value={stats.disk.percent}
            suffix="%"
            subtitle={`${formatBytes(stats.disk.usedBytes)} / ${formatBytes(stats.disk.totalBytes)}`}
            icon={Database01Icon}
            showBar
            history={history.disk}
          />
          <StatCard
            title="Network ↓"
            value={Math.round(stats.network.rxBytesPerSec / 1024)}
            suffix=" KB/s"
            subtitle={`↑ ${formatBytes(stats.network.txBytesPerSec)}/s`}
            icon={Wifi01Icon}
            history={history.networkRx}
          />
        </>
      ) : (
        Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[90px] rounded-lg" />
        ))
      )}
    </div>
  );
}
