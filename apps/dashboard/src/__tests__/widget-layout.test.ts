import { describe, it, expect } from "vitest";
import { migrateLegacyLayout, mergeWithDefaults } from "@/hooks/use-widget-layout";

describe("widget layout migration", () => {
  it("expands legacy system-health into atomic stats widgets", () => {
    const migrated = migrateLegacyLayout([
      { id: "system-health", visible: true },
      { id: "services", visible: true },
    ]);
    const types = migrated.map((w) => w.widgetType);
    expect(types).toContain("cpu");
    expect(types).toContain("memory");
    expect(types).toContain("disk");
    expect(types).toContain("network");
    expect(types).toContain("services");
  });

  it("merges missing defaults without dropping existing widgets", () => {
    const merged = mergeWithDefaults([
      { instanceId: "services-custom", widgetType: "services", visible: true, size: { cols: 2, rows: 2 } },
    ]);
    expect(merged.some((w) => w.widgetType === "services")).toBe(true);
    expect(merged.some((w) => w.widgetType === "cpu")).toBe(true);
  });
});
