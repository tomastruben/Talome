import type { TalomeTimeSeries, TalomeValueFormat } from "@talome/types";
import { formatNativeValue, getValueAtPath } from "./native-app-values";

export type NativeChartRow = { category: string; [key: string]: string | number | null };

/** Missing measurements stay gaps; coercible objects and booleans are not measurements. */
export function nativeChartNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function nativeChartRows(rows: Record<string, unknown>[], xPath: string, series: TalomeTimeSeries[]): NativeChartRow[] {
  return rows.map((row) => ({
    category: formatNativeValue(getValueAtPath(row, xPath)),
    ...Object.fromEntries(series.map((item, index) => [
      `series${index}`, nativeChartNumber(getValueAtPath(row, item.valuePath)),
    ])),
  }));
}

export function formatNativeChartValue(value: number | null, format?: TalomeValueFormat, currency?: string, unit?: string): string {
  if (value === null) return "No data";
  // Charts use a single continuous scale: percentage inputs are always fractions.
  const formatted = format === "percent"
    ? new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 2 }).format(value)
    : formatNativeValue(value, format ?? "number", currency);
  return unit ? `${formatted} ${unit}` : formatted;
}
