"use client";

import { useSystemStats } from "@/hooks/use-system-stats";
import type { MetricSample } from "@/hooks/use-system-stats";
import { HugeiconsIcon, Wifi01Icon, ArrowDown01Icon, ArrowUp01Icon } from "@/components/icons";
import { SlidingSparkline, COLORS } from "@/components/dashboard/stat-card";
import { Widget, WidgetHeader } from "./widget";
import { StatTile } from "./stat-tile";
import { TemporalLineChart } from "@/components/dashboard/temporal-line-chart";
import { cn } from "@/lib/utils";

function formatRate(bytesPerSec: number): { value: string; unit: string } {
  if (bytesPerSec >= 1_000_000) {
    return { value: (bytesPerSec / 1_000_000).toFixed(1), unit: "MB/s" };
  }
  if (bytesPerSec >= 1_000) {
    return { value: (bytesPerSec / 1_000).toFixed(1), unit: "KB/s" };
  }
  return { value: Math.round(bytesPerSec).toString(), unit: "B/s" };
}

interface ChannelRowProps {
  label: string;
  icon: typeof ArrowDown01Icon;
  bytesPerSec: number;
  history: MetricSample[];
  palette: { stroke: string; fill: string };
  className?: string;
}

function ChannelRow({ label, icon, bytesPerSec, history, palette, className }: ChannelRowProps) {
  const { value, unit } = formatRate(bytesPerSec);

  return (
    <div className={cn("relative overflow-hidden px-4 py-3.5 flex items-center justify-between gap-3", className)}>
      <div className="absolute inset-0 h-full">
        <SlidingSparkline
          data={history}
          stroke={palette.stroke}
          fill={palette.fill}
          strokeWidth={1.5}
          height={56}
        />
      </div>
      <div className="relative flex items-center gap-2.5 min-w-0">
        <div className="flex items-center justify-center size-6 rounded-md bg-muted/40 shrink-0">
          <HugeiconsIcon icon={icon} size={13} className="text-muted-foreground" strokeWidth={2} />
        </div>
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      <div className="relative flex items-baseline gap-1.5 shrink-0">
        <span className="text-xl font-medium tabular-nums tracking-tight">
          {value}
        </span>
        <span className="text-xs text-muted-foreground font-medium w-8">{unit}</span>
      </div>
    </div>
  );
}

function StatsState({
  text,
}: {
  text: string;
}) {
  return (
    <div className="px-4 pt-8 pb-7 flex flex-col items-center justify-center gap-2 text-center text-muted-foreground min-h-40">
      <HugeiconsIcon icon={Wifi01Icon} size={30} className="text-dim-foreground" />
      <p className="text-xs">{text}</p>
    </div>
  );
}

export function NetworkWidget({ mode = "full" }: { mode?: "compact" | "split" | "full" }) {
  const { stats, error, isConnecting, history } = useSystemStats();

  if (mode === "compact") {
    if (!stats) {
      return (
        <StatTile
          title="Network"
          icon={Wifi01Icon}
          chartData={history.networkRx}
          secondaryChartData={history.networkTx}
          isLoading={isConnecting}
          error={error}
        />
      );
    }
    const rx = formatRate(stats.network.rxBytesPerSec);
    const tx = formatRate(stats.network.txBytesPerSec);
    return (
      <Widget>
        <WidgetHeader title="Network" />
        <div className="px-4 pt-3 pb-2 grid gap-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HugeiconsIcon icon={ArrowDown01Icon} size={16} className="text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Down</span>
            </div>
            <span className="text-sm font-medium tabular-nums">{rx.value} {rx.unit}</span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HugeiconsIcon icon={ArrowUp01Icon} size={16} className="text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Up</span>
            </div>
            <span className="text-sm font-medium tabular-nums">{tx.value} {tx.unit}</span>
          </div>
        </div>
        <TemporalLineChart
          data={history.networkRx}
          secondaryData={history.networkTx}
          height={44}
        />
      </Widget>
    );
  }

  if (mode === "split") {
    const rx = stats ? formatRate(stats.network.rxBytesPerSec) : null;
    const tx = stats ? formatRate(stats.network.txBytesPerSec) : null;

    return (
      <Widget>
        <WidgetHeader title="Network" />
        {isConnecting ? (
          <StatsState text="Collecting live data..." />
        ) : error ? (
          <StatsState text="Stats unavailable" />
        ) : stats ? (
          <div className="divide-y divide-border/40">
            <div className="pt-2.5">
              <div className="px-4 pb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <HugeiconsIcon icon={ArrowDown01Icon} size={14} className="text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Down</span>
                </div>
                <span className="text-xs font-medium tabular-nums">{rx?.value} {rx?.unit}</span>
              </div>
              <TemporalLineChart data={history.networkRx} height={34} />
            </div>
            <div className="pt-2.5">
              <div className="px-4 pb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <HugeiconsIcon icon={ArrowUp01Icon} size={14} className="text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Up</span>
                </div>
                <span className="text-xs font-medium tabular-nums">{tx?.value} {tx?.unit}</span>
              </div>
              <TemporalLineChart data={history.networkTx} height={34} />
            </div>
          </div>
        ) : null}
      </Widget>
    );
  }

  return (
    <Widget>
      <WidgetHeader
        title="Network"
        actions={
          stats && (
            <div className="flex items-center gap-1.5">
              <div className="size-1.5 rounded-full bg-status-healthy/70 animate-pulse" />
              <span className="text-xs text-muted-foreground tabular-nums">Live</span>
            </div>
          )
        }
      />

      {isConnecting ? (
        <StatsState text="Collecting live data..." />
      ) : error ? (
        <StatsState text="Stats unavailable" />
      ) : stats ? (
        <div className="divide-y divide-border/40">
          <ChannelRow
            label="Down"
            icon={ArrowDown01Icon}
            bytesPerSec={stats.network.rxBytesPerSec}
            history={history.networkRx}
            palette={COLORS.rx}
          />
          <ChannelRow
            label="Up"
            icon={ArrowUp01Icon}
            bytesPerSec={stats.network.txBytesPerSec}
            history={history.networkTx}
            palette={COLORS.tx}
          />
        </div>
      ) : null}
    </Widget>
  );
}
