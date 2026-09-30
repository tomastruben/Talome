"use client";

import type { TalomeTimeSeries, TalomeValueFormat } from "@talome/types";
import { NativeDataChart } from "./native-data-chart";
import { nativeChartRows } from "./native-chart-data";

/** Compatibility entry point for existing shared area-chart consumers. */
export function TalomeAreaTrend({ data, series, label, valueFormat, currency }: {
  data: Array<Record<string, string | number | null>>;
  series: TalomeTimeSeries[];
  label: string;
  valueFormat?: TalomeValueFormat;
  currency?: string;
}) {
  const mappedSeries = series.map((item) => ({ ...item, valuePath: item.id }));
  return <NativeDataChart data={nativeChartRows(data, "x", mappedSeries)} series={series} label={label} variant="area" valueFormat={valueFormat} currency={currency} />;
}
