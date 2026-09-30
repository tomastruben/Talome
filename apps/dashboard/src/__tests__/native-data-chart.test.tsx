import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NativeDataChart } from "@/components/native-app/native-data-chart";

// SVG geometry is covered by the browser harness. Keep the numeric fallback real here.
vi.mock("@/components/ui/chart", () => ({ ChartContainer: () => <div />, ChartTooltip: () => null, ChartTooltipContent: () => null }));
const series = [{ id: "x", label: "Measured", valuePath: "reading" }, { id: "reference:temp", label: "Target", valuePath: "target" }];

describe("native chart accessible evidence", () => {
  it("provides named series and a keyboard disclosure containing every observation, zero, negative, and gap", () => {
    const { container } = render(<NativeDataChart label="Temperature" variant="bar" xLabel="Location" unit="°C" series={series} data={[
      { category: "Freezer", series0: -18, series1: -20 },
      { category: "Cold room", series0: 0, series1: null },
    ]} />);
    expect(screen.getByRole("list", { name: "Temperature series" })).toHaveTextContent("MeasuredTarget");
    const disclosure = container.querySelector("details")!;
    expect(disclosure.querySelector("summary")).toHaveTextContent("View data (2 rows)");
    disclosure.open = true;
    const table = screen.getByRole("table", { name: "Temperature data" });
    expect(within(table).getByRole("columnheader", { name: "Location" })).toBeVisible();
    expect(within(table).getByRole("cell", { name: "-18 °C" })).toBeVisible();
    expect(within(table).getByRole("cell", { name: "0 °C" })).toBeVisible();
    expect(within(table).getByRole("cell", { name: "No data" })).toBeVisible();
    expect(screen.getByText(/1 missing value/)).toBeVisible();
  });
  it("distinguishes no observations from observations without numeric measurements", () => {
    const { rerender } = render(<NativeDataChart label="Sensors" series={series} data={[]} />);
    expect(screen.getByText("No observations yet.")).toBeVisible();
    rerender(<NativeDataChart label="Sensors" series={series} data={[{ category: "Today", series0: null, series1: null }]} />);
    expect(screen.getByText("No numeric measurements available.")).toBeVisible();
    expect(screen.getByText("View data (1 row)")).toBeVisible();
  });
});
