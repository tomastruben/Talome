import { describe, expect, it } from "vitest";
import { createDefaultAppSpec, TalomeAppSpecSchema } from "../app-specs/schema.js";

describe("Talome AppSpec", () => {
  it("preserves grouped category charts, unit labels and legacy series identifiers", () => {
    const spec = createDefaultAppSpec({ appId: "analysis", name: "Analysis", description: "Compare actual observations." });
    spec.surfaces[0].blocks = [{
      id: "comparison", component: "time-series", title: "Temperature by location", dataSource: "app-status",
      rowsPath: "rows", xPath: "location", variant: "bar", xLabel: "Location", valueLabel: "Temperature", unit: "°C",
      series: [{ id: "x", label: "Measured", valuePath: "measured" }, { id: "reference.v1:temp", label: "Reference", valuePath: "reference" }],
    }];
    expect(TalomeAppSpecSchema.parse(spec)).toEqual(spec);
  });

  it("rejects duplicate chart series instead of overwriting a measure", () => {
    const spec = createDefaultAppSpec({ appId: "analysis", name: "Analysis", description: "Compare actual observations." });
    spec.surfaces[0].blocks = [{
      id: "comparison", component: "time-series", title: "Comparison", dataSource: "app-status", xPath: "category",
      series: [{ id: "value", label: "Actual", valuePath: "actual" }, { id: "value", label: "Reference", valuePath: "reference" }],
    }];
    expect(TalomeAppSpecSchema.safeParse(spec).error?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Duplicate chart series: value", path: ["surfaces", 0, "blocks", 0, "series", 1, "id"] })]));
  });

  it("rejects chart variants the shipped renderer does not implement", () => {
    const spec = createDefaultAppSpec({ appId: "analysis", name: "Analysis", description: "Compare actual observations." });
    const raw = { ...spec, surfaces: [{ ...spec.surfaces[0], blocks: [{ id: "unsupported", component: "time-series", title: "Scatter", dataSource: "app-status", xPath: "x", variant: "scatter", series: [{ id: "y", label: "Y", valuePath: "y" }] }] }] };
    expect(TalomeAppSpecSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects ambiguous surface, block, and action input identities", () => {
    const spec = createDefaultAppSpec({ appId: "test", name: "Test", description: "Test app." });
    spec.surfaces.push(structuredClone(spec.surfaces[0]));
    spec.surfaces[0].blocks.push(structuredClone(spec.surfaces[0].blocks[0]));
    spec.actions[0].input = [
      { id: "name", type: "string", label: "Name" },
      { id: "name", type: "number", label: "Count" },
    ];
    const messages = TalomeAppSpecSchema.safeParse(spec).error?.issues.map((issue) => issue.message);
    expect(messages).toEqual(expect.arrayContaining(["Duplicate surface: overview", "Duplicate block: about", "Duplicate action input: name"]));
  });

  it("requires row actions to bind a declared action input", () => {
    const spec = createDefaultAppSpec({ appId: "test", name: "Test", description: "Test app." });
    spec.surfaces[0].blocks.push({
      id: "activity", title: "Activity", component: "activity-list", dataSource: "app-status",
      datePath: "date", titlePath: "name", valuePath: "amount",
      rowAction: { actionId: "inspect-with-assistant", inputId: "record-id", valuePath: "id" },
    });
    expect(TalomeAppSpecSchema.safeParse(spec).error?.issues.some((issue) => issue.message === "Unknown action input: record-id")).toBe(true);
    spec.actions[0].input = [{ id: "record-id", type: "string", label: "Record" }];
    expect(TalomeAppSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("creates a valid native surface with assistant actions", () => {
    const spec = createDefaultAppSpec({
      appId: "family-budget",
      name: "Family Budget",
      description: "A shared household budget.",
      icon: "💶",
    });

    expect(TalomeAppSpecSchema.parse(spec)).toEqual(spec);
    expect(spec.assistant.exposedActions).toEqual([
      "inspect-with-assistant",
      "restart-service",
    ]);
    expect(spec.surfaces[0].blocks.map((block) => block.component)).toEqual([
      "markdown",
      "stat",
      "actions",
    ]);
  });

  it("rejects blocks that reference undeclared data sources", () => {
    const spec = createDefaultAppSpec({
      appId: "documents",
      name: "Documents",
      description: "Private documents.",
    });
    const status = spec.surfaces[0].blocks.find((block) => block.component === "stat")!;
    status.dataSource = "missing";

    const result = TalomeAppSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("Unknown data source"))).toBe(true);
  });

  it("rejects protected Talome paths at the schema boundary", () => {
    const spec = createDefaultAppSpec({
      appId: "unsafe",
      name: "Unsafe",
      description: "Invalid path test.",
    });
    const source = spec.dataSources[0];
    if (source.kind !== "talome-api") throw new Error("Expected Talome API source");
    source.path = "https://example.com/api";

    expect(TalomeAppSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("accepts hierarchical metrics, comparisons, activity, and contextual actions", () => {
    const spec = createDefaultAppSpec({
      appId: "family-budget",
      name: "Family Budget",
      description: "Private household finances.",
    });
    spec.actions.push({
      id: "add-transaction",
      label: "Add transaction",
      description: "Record an expense.",
      kind: "assistant",
      prompt: "Help me add a transaction.",
    });
    spec.surfaces = [{
      id: "overview",
      title: "Overview",
      layout: "dashboard",
      primaryActionId: "add-transaction",
      blocks: [
        {
          id: "available",
          title: "Available this month",
          component: "stat",
          dataSource: "app-status",
          valuePath: "available",
          emphasis: "hero",
          progressValuePath: "spent",
          progressMaxPath: "budget",
        },
        {
          id: "budget-workspace",
          title: "Budget overview",
          component: "budget-overview",
          dataSource: "app-status",
          currency: "CHF",
          reviewActionId: "add-transaction",
          span: 4,
        },
        {
          id: "categories",
          title: "Budget by category",
          component: "comparison-bars",
          dataSource: "app-status",
          rowsPath: "categories",
          labelPath: "category",
          plannedPath: "budget",
          actualPath: "spent",
          actionId: "add-transaction",
        },
        {
          id: "activity",
          title: "Transactions",
          component: "activity-list",
          dataSource: "app-status",
          rowsPath: "transactions",
          datePath: "date",
          titlePath: "description",
          valuePath: "amount",
          filterPath: "kind",
          filters: [{ label: "Expenses", value: "expense" }],
        },
      ],
    }];

    expect(TalomeAppSpecSchema.parse(spec)).toEqual(spec);
  });

  it("rejects an undeclared contextual primary action", () => {
    const spec = createDefaultAppSpec({
      appId: "invalid-primary-action",
      name: "Invalid",
      description: "Invalid primary action.",
    });
    spec.surfaces[0].primaryActionId = "missing";

    const result = TalomeAppSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("Unknown action"))).toBe(true);
  });
});
