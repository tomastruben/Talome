import { describe, expect, it } from "vitest";
import { formatNativeChartValue, nativeChartNumber, nativeChartRows } from "@/components/native-app/native-chart-data";

describe("native chart numeric evidence", () => {
  it("preserves zero and negatives while retaining absent or invalid measurements as gaps", () => {
    expect([0, -18, "0", "-2.5", null, undefined, "", " ", false, [], {}, "invalid", Infinity, NaN].map(nativeChartNumber))
      .toEqual([0, -18, 0, -2.5, null, null, null, null, null, null, null, null, null, null]);
  });
  it("separates category and arbitrary contract IDs, with nested value paths", () => {
    expect(nativeChartRows([{ label: "Freezer", readings: { current: -18 } }], "label", [
      { id: "x", label: "Current", valuePath: "readings.current" },
      { id: "reference.v1:temp", label: "Target", valuePath: "target" },
    ])).toEqual([{ category: "Freezer", series0: -18, series1: null }]);
  });
  it("formats percentages on a single fractional scale, including over 100% and negative values", () => {
    expect([0, 0.01, 1, 1.2, -0.2].map((value) => formatNativeChartValue(value, "percent"))).toEqual(["0%", "1%", "100%", "120%", "-20%"]);
  });
  it("makes missingness explicit and applies units without changing the value", () => {
    expect(formatNativeChartValue(null, "number", undefined, "ms")).toBe("No data");
    expect(formatNativeChartValue(0, "number", undefined, "°C")).toBe("0 °C");
    expect(formatNativeChartValue(-18, "number", undefined, "°C")).toBe("-18 °C");
  });
});
