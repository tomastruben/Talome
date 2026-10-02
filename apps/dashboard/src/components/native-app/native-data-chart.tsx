"use client";

import { useId } from "react";
import type { TalomeTimeSeries, TalomeValueFormat } from "@talome/types";
import { Area, Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNativeChartValue, type NativeChartRow } from "./native-chart-data";

const COLORS = ["var(--foreground)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-1)"];
const DASHES = [undefined, "6 3", "2 3", "8 3 2 3", "10 4", "3 2 3 5"];

export function NativeDataChart({ data, series, label, variant = "line", valueFormat, currency, unit, xLabel, valueLabel }: {
  data: NativeChartRow[];
  series: TalomeTimeSeries[];
  label: string;
  variant?: "line" | "area" | "bar";
  valueFormat?: TalomeValueFormat;
  currency?: string;
  unit?: string;
  xLabel?: string;
  valueLabel?: string;
}) {
  const descriptionId = useId();
  const config: ChartConfig = Object.fromEntries(series.map((item, index) => [
    `series${index}`, { label: item.label, color: COLORS[index % COLORS.length] },
  ]));
  const format = (value: number | null) => formatNativeChartValue(value, valueFormat, currency, unit);
  const values = data.flatMap((row) => series.map((_, index) => row[`series${index}`])).filter((value): value is number => typeof value === "number");
  const missingCount = data.length * series.length - values.length;
  const formatAxis = (value: number) => valueFormat === "percent"
    ? formatNativeChartValue(value, "percent")
    : valueFormat === "bytes" ? formatNativeChartValue(value, "bytes")
      : new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1,
        ...(valueFormat === "currency" ? { style: "currency", currency: currency ?? "USD" } : {}),
      }).format(value);

  return (
    <div className="min-w-0 space-y-3" data-native-chart={variant} data-count={data.length}>
      <p id={descriptionId} className="text-xs text-muted-foreground">
        {valueLabel ?? "Value"}{unit ? ` (${unit})` : ""}{xLabel ? ` by ${xLabel}` : ""}
        {missingCount ? ` · ${missingCount} missing ${missingCount === 1 ? "value" : "values"}; gaps indicate no data.` : ""}
      </p>
      {values.length ? <ChartContainer config={config} className="h-64 w-full min-w-0 aspect-auto @lg/block:h-72">
        <ComposedChart accessibilityLayer aria-label={`${label} chart`} aria-describedby={descriptionId} data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 5" />
          <XAxis dataKey="category" tickLine={false} axisLine={false} minTickGap={24} tickMargin={10} tickFormatter={(value: string) => value.length > 18 ? `${value.slice(0, 16)}…` : value} />
          <YAxis width={64} tickLine={false} axisLine={false} tickFormatter={formatAxis} tickMargin={8} domain={variant === "bar" || variant === "area" ? [(minimum: number) => Math.min(0, minimum), (maximum: number) => Math.max(0, maximum)] : undefined} />
          {values.some((value) => value < 0) ? <ReferenceLine y={0} stroke="var(--muted-foreground)" /> : null}
          <ChartTooltip filterNull={false} cursor={{ stroke: "var(--border)" }} content={<ChartTooltipContent formatter={(value, name) => (
            <div className="flex min-w-32 items-center justify-between gap-4">
              <span className="text-muted-foreground">{config[String(name)]?.label}</span>
              <span className="font-mono font-medium tabular-nums">{format(typeof value === "number" ? value : null)}</span>
            </div>
          )} />} />
          {series.map((item, index) => {
            const key = `series${index}`;
            const color = `var(--color-${key})`;
            const common = { dataKey: key, stroke: color, isAnimationActive: false };
            return variant === "bar" ? <Bar key={item.id} {...common} fill={color} maxBarSize={48} />
              : variant === "area" ? <Area key={item.id} {...common} type="linear" fill={color} fillOpacity={0.08} strokeWidth={2} strokeDasharray={DASHES[index]} connectNulls={false} dot={{ r: 2 }} activeDot={{ r: 4 }} />
                : <Line key={item.id} {...common} type="linear" strokeWidth={2} strokeDasharray={DASHES[index]} connectNulls={false} dot={{ r: 2 }} activeDot={{ r: 4 }} />;
          })}
        </ComposedChart>
      </ChartContainer> : <p className="py-8 text-center text-sm text-muted-foreground">{data.length ? "No numeric measurements available." : "No observations yet."}</p>}
      <ul aria-label={`${label} series`} className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
        {series.map((item, index) => <li key={item.id} className="flex min-w-0 items-center gap-2">
          <svg aria-hidden="true" width="24" height="12" className="shrink-0"><line x1="0" y1="6" x2="24" y2="6" stroke={COLORS[index % COLORS.length]} strokeWidth={variant === "bar" ? 7 : 2} strokeDasharray={variant === "bar" ? undefined : DASHES[index]} /></svg>
          <span className="break-words">{item.label}</span>
        </li>)}
      </ul>
      {data.length ? <details className="min-w-0 rounded-md border">
        <summary className="cursor-pointer rounded-md px-3 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">View data ({data.length} {data.length === 1 ? "row" : "rows"})</summary>
        <Table aria-label={`${label} data`} containerClassName="max-h-80">
          <TableHeader><TableRow><TableHead scope="col">{xLabel ?? "Observation"}</TableHead>{series.map((item) => <TableHead key={item.id} scope="col" className="text-right">{item.label}{unit ? ` (${unit})` : ""}</TableHead>)}</TableRow></TableHeader>
          <TableBody>{data.map((row, rowIndex) => <TableRow key={rowIndex}>
            <TableHead scope="row" className="font-normal">{row.category}</TableHead>
            {series.map((item, index) => <TableCell key={item.id} className="text-right tabular-nums">{format(typeof row[`series${index}`] === "number" ? row[`series${index}`] as number : null)}</TableCell>)}
          </TableRow>)}</TableBody>
        </Table>
      </details> : null}
    </div>
  );
}
