import { describe, expect, it } from "vitest";
import { createDefaultAppSpec, TalomeAppSpecSchema } from "../app-specs/schema.js";

describe("Talome AppSpec", () => {
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
