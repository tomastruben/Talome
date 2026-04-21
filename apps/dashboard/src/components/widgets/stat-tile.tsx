"use client";

import { HugeiconsIcon } from "@/components/icons";
import type { MetricSample } from "@/hooks/use-system-stats";
import { Widget, WidgetHeader } from "./widget";
import { TemporalLineChart } from "@/components/dashboard/temporal-line-chart";
import { cn } from "@/lib/utils";

interface StatTileProps {
  title: string;
  icon: React.ComponentProps<typeof HugeiconsIcon>["icon"];
  value?: string;
  subtitle?: string;
  chartData: MetricSample[];
  secondaryChartData?: MetricSample[];
  isLoading?: boolean;
  error?: string | null;
}

function StatelessView({
  icon,
  text,
}: {
  icon: React.ComponentProps<typeof HugeiconsIcon>["icon"];
  text: string;
}) {
  return (
    <div className="px-4 pt-6 pb-5 flex flex-col items-center justify-center gap-2 text-center text-muted-foreground min-h-32">
      <HugeiconsIcon icon={icon} size={30} className="text-dim-foreground" />
      <p className="text-xs">{text}</p>
    </div>
  );
}

export function StatTile({
  title,
  icon,
  value,
  subtitle,
  chartData,
  secondaryChartData,
  isLoading,
  error,
}: StatTileProps) {
  const showState = !value;

  return (
    <Widget>
      <WidgetHeader title={title} />
      {showState ? (
        <StatelessView icon={icon} text={isLoading ? "Collecting live data..." : (error ?? "Stats unavailable")} />
      ) : (
        <>
          <div className="px-4 pt-3 pb-2 grid gap-1.5">
            <div className="flex items-center justify-between">
              <p className="text-2xl font-medium tabular-nums">{value}</p>
              <div className="rounded-lg bg-muted/35 p-1.5">
                <HugeiconsIcon icon={icon} size={20} className="text-dim-foreground" />
              </div>
            </div>
            {subtitle && <p className="text-xs text-muted-foreground truncate">{subtitle}</p>}
          </div>
          <TemporalLineChart
            data={chartData}
            secondaryData={secondaryChartData}
            height={52}
            className={cn("w-full")}
          />
        </>
      )}
    </Widget>
  );
}
