import { describe, expect, it } from "vitest";
import { repairCreatorBlueprint } from "../creator/blueprint-normalization.js";
import { AppBlueprintSchema } from "../creator/contracts.js";
import { createDefaultAppSpec } from "../app-specs/schema.js";

function blueprint() {
  const spec = createDefaultAppSpec({ appId: "analytics", name: "Analytics", description: "Synthetic analytics" });
  spec.surfaces[0].blocks.push({ id: "rows", title: "Rows", component: "table", dataSource: spec.dataSources[0].id,
    columns: [{ id: "count", label: "Units", path: "count", format: "number", currency: "" }] });
  return { id: "analytics", name: "Analytics", description: "Synthetic analytics", prompt: "Create analytics", category: "other",
    services: [{ name: "app", image: "nginx:alpine" }], scaffold: { enabled: false }, ui: {}, appSpec: spec,
    successCriteria: [], designAlignment: { summary: "Use native charts" }, instructionsVersion: "test" };
}
describe("bounded creator blueprint normalization", () => {
  it("only drops unused empty currency metadata and revalidates the entire blueprint", () => {
    const value = blueprint(); const input = JSON.stringify(value);
    const repaired = repairCreatorBlueprint(input)!;
    expect(repaired.removedPaths).toEqual([`appSpec.surfaces.0.blocks.${value.appSpec.surfaces[0].blocks.length - 1}.columns.0.currency`]);
    expect(AppBlueprintSchema.safeParse(JSON.parse(repaired.text)).success).toBe(true);
    expect(JSON.parse(repaired.text).appSpec.dataSources).toEqual(value.appSpec.dataSources);
    expect(input).toContain('"currency":""');
  });
  it("refuses an empty currency on a currency-formatted column", () => {
    const value = blueprint(); const block = value.appSpec.surfaces[0].blocks.at(-1)!;
    if (block.component === "table") block.columns[0].format = "currency";
    expect(repairCreatorBlueprint(JSON.stringify(value))).toBeNull();
  });
  it("does not repair other invalid fields or return a fallback object", () => {
    const value = blueprint(); value.appSpec.surfaces[0].primaryActionId = "missing-action";
    expect(repairCreatorBlueprint(JSON.stringify(value))).toBeNull();
    expect(repairCreatorBlueprint("not JSON")).toBeNull();
  });
  it("leaves valid output and nonempty invalid currency codes to normal validation", () => {
    const value = blueprint(); const block = value.appSpec.surfaces[0].blocks.at(-1)!;
    if (block.component === "table") block.columns[0].currency = "US";
    expect(repairCreatorBlueprint(JSON.stringify(value))).toBeNull();
    if (block.component === "table") delete block.columns[0].currency;
    expect(repairCreatorBlueprint(JSON.stringify(value))).toBeNull();
  });
});
