import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ChartStyle,
  toChartColorKey,
  type ChartConfig,
} from "@/components/evilcharts/ui/chart";

describe("EvilCharts dark-mode color identifiers", () => {
  it("keeps readable series labels separate from CSS-safe paint keys", () => {
    const config: ChartConfig = {
      "Budget used": {
        label: "Budget used",
        colors: { dark: ["var(--status-healthy)"] },
      },
      "Money in": {
        label: "Money in",
        colors: { dark: ["var(--status-warning)"] },
      },
    };

    const { container } = render(<ChartStyle id="dark-chart" config={config} />);
    const css = container.querySelector("style")?.textContent ?? "";

    expect(toChartColorKey("Budget used")).toBe("Budget-used");
    expect(toChartColorKey("Money in")).toBe("Money-in");
    expect(css).toContain(".dark [data-chart=dark-chart]");
    expect(css).toContain("--color-Budget-used-0: var(--status-healthy)");
    expect(css).toContain("--color-Money-in-0: var(--status-warning)");
    expect(css).not.toContain("--color-Budget used");
    expect(css).not.toContain("--color-Money in");
  });
});
