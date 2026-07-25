"use client";

import { useMemo } from "react";
import type { TalomeTimeSeries, TalomeValueFormat } from "@talome/types";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatNativeValue } from "./native-app-values";

const TALOME_SERIES_COLORS = [
  "var(--foreground)",
  "var(--muted-foreground)",
  "var(--chart-2)",
  "var(--chart-4)",
];

/**
 * Talome's restrained adaptation of Evil Charts' composable area-chart pattern.
 * It keeps the data/tooltip craft while removing gradients, glow, and intro motion.
 */
export function TalomeAreaTrend({
  data,
  series,
  label,
  valueFormat,
  currency,
}: {
  data: Array<Record<string, string | number>>;
  series: TalomeTimeSeries[];
  label: string;
  valueFormat?: TalomeValueFormat;
  currency?: string;
}) {
  const config = useMemo<ChartConfig>(() => Object.fromEntries(
    series.map((item, index) => [item.id, {
      label: item.label,
      color: TALOME_SERIES_COLORS[index % TALOME_SERIES_COLORS.length],
    }]),
  ), [series]);

  const formatAxis = (value: number) => {
    if (valueFormat === "currency") {
      return new Intl.NumberFormat(undefined, {
        notation: "compact",
        style: "currency",
        currency: currency ?? "USD",
        maximumFractionDigits: 0,
      }).format(value);
    }
    return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
  };

  return (
    <ChartContainer config={config} className="min-h-64 w-full">
      <AreaChart
        accessibilityLayer
        aria-label={`${label} chart`}
        data={data}
        margin={{ top: 8, right: 8, bottom: 0, left: 4 }}
      >
        <CartesianGrid vertical={false} strokeDasharray="3 5" />
        <XAxis dataKey="x" tickLine={false} axisLine={false} minTickGap={24} tickMargin={10} />
        <YAxis
          width={64}
          tickLine={false}
          axisLine={false}
          tickFormatter={formatAxis}
          tickMargin={8}
        />
        <ChartTooltip
          cursor={{ stroke: "var(--border)" }}
          content={(
            <ChartTooltipContent
              formatter={(value, name) => (
                <div className="flex min-w-40 items-center justify-between gap-6">
                  <span className="text-muted-foreground">{config[String(name)]?.label}</span>
                  <span className="font-mono font-medium tabular-nums text-foreground">
                    {formatNativeValue(value, valueFormat, currency)}
                  </span>
                </div>
              )}
            />
          )}
        />
        {series.map((item, index) => (
          <Area
            key={item.id}
            type="monotone"
            dataKey={item.id}
            stroke={`var(--color-${item.id})`}
            fill={`var(--color-${item.id})`}
            fillOpacity={index === 0 ? 0.1 : 0.035}
            strokeWidth={index === 0 ? 2 : 1.5}
            strokeDasharray={index === 1 ? "5 5" : undefined}
            dot={false}
            activeDot={{ r: 3 }}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  );
}
