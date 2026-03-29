"use client";

import { SlidingSparkline, COLORS } from "@/components/dashboard/stat-card";
import type { MetricSample } from "@/hooks/use-system-stats";
import { cn } from "@/lib/utils";

interface MiniAreaChartProps {
  data: MetricSample[];
  secondaryData?: MetricSample[];
  height?: number;
  className?: string;
}

export function TemporalLineChart({
  data,
  secondaryData,
  height = 48,
  className,
}: MiniAreaChartProps) {
  if (data.length < 2 && (!secondaryData || secondaryData.length < 2)) {
    return <div style={{ height }} className={className} />;
  }

  return (
    <div className={cn("relative w-full overflow-hidden", className)} style={{ height }}>
      {secondaryData && secondaryData.length >= 2 && (
        <SlidingSparkline
          data={secondaryData}
          stroke={COLORS.tx.stroke}
          fill={COLORS.tx.fill}
          strokeWidth={1.2}
          height={height}
        />
      )}
      {data.length >= 2 && (
        <SlidingSparkline
          data={data}
          stroke={COLORS.normal.stroke}
          fill={COLORS.normal.fill}
          strokeWidth={1.35}
          height={height}
        />
      )}
    </div>
  );
}
