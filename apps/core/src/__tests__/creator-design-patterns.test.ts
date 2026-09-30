import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { TALOME_COMPONENT_IDS } from "@talome/types";
import { DESIGN_PATTERNS, searchDesignPatterns } from "../creator/design-patterns.js";
import { loadInstructionPack, loadTalomeReferenceSnapshots } from "../creator/instructions.js";
import { TalomeAppSpecSchema } from "../app-specs/schema.js";

describe("Talome composition discovery", () => {
  it("provides the current assistant creation entry and blueprint review as usable source references", async () => {
    const references = await loadTalomeReferenceSnapshots();
    for (const path of ["apps/dashboard/src/app/dashboard/assistant/page.tsx", "apps/dashboard/src/components/creator/blueprint-draft-bar.tsx"]) {
      const reference = references.find((item) => item.relativePath === path);
      expect(reference?.content.length).toBeGreaterThan(0);
      expect(reference?.reason).toBeTruthy();
    }
  });

  it.each([
    ["budget expenses", "budget-workspace"],
    ["weather metrics trend", "metric-monitor"],
    ["stopwatch pause resume", "focused-task"],
    ["filter transactions spreadsheet", "collection-review"],
    ["inspect document", "record-detail"],
    ["record-detail", "record-detail"],
    ["compare categories", "analytical-comparison"],
    ["multi-series chart", "analytical-comparison"],
  ])("finds shipped compositions for %s", (intent, id) => {
    expect(searchDesignPatterns(intent).patterns[0]?.id).toBe(id);
  });

  it("does not invent matches for unsupported concepts or overfill a kit", () => {
    expect(searchDesignPatterns("xyzzy").patterns).toEqual([]);
    expect(searchDesignPatterns("records metrics budget", 1).patterns).toHaveLength(1);
    expect(searchDesignPatterns().patterns).toHaveLength(DESIGN_PATTERNS.length);
  });

  it("references real native blocks, shadcn files and source examples", () => {
    expect(new Set(DESIGN_PATTERNS.map((pattern) => pattern.id)).size).toBe(DESIGN_PATTERNS.length);
    for (const pattern of DESIGN_PATTERNS) {
      for (const component of pattern.nativeComponents) expect(TALOME_COMPONENT_IDS).toContain(component);
      for (const component of pattern.shadcnComponents) {
        expect(existsSync(resolve("../dashboard/src/components/ui", `${component}.tsx`))).toBe(true);
      }
      for (const path of pattern.referencePaths) expect(existsSync(resolve("../..", path))).toBe(true);
      expect(pattern.requiredStates).toContain("error");
      expect(pattern.requiredStates).toContain("permission-denied");
      expect(pattern.verification.length).toBeGreaterThan(0);
    }
  });

  it("keeps machine discovery and the versioned generation pack in sync", async () => {
    const pack = await loadInstructionPack();
    expect(JSON.parse(pack.documents["pattern-catalog.json"])).toEqual(searchDesignPatterns());
    for (const pattern of DESIGN_PATTERNS) {
      expect(pack.documents["pattern-catalog.md"]).toContain(`## ${pattern.id}:`);
      expect(pack.documents["pattern-catalog.md"]).toContain(pattern.responsive);
    }
    expect(pack.summary.files).toContain("pattern-catalog.json");
    const charts = JSON.parse(pack.documents["chart-contract.json"]);
    expect(charts.examples).toHaveLength(2);
    for (const example of charts.examples) {
      expect(TalomeAppSpecSchema.parse(example.spec)).toEqual(example.spec);
      expect(example.dataProvenance).toContain("Synthetic");
      expect(example.spec.dataSources[0].kind).toBe("app-api");
      const chart = example.spec.surfaces[0].blocks[0];
      expect(chart.unit).toBeTruthy();
      expect(chart.series).toHaveLength(2);
      expect(example.exampleResponse.rows.some((row: Record<string, unknown>) => Object.values(row).includes(null))).toBe(true);
    }
    expect(charts.examples[0].spec.surfaces[0].blocks[0].variant).toBe("bar");
    expect(charts.rules.join(" ")).toContain("0.01 is 1%");
    expect(pack.summary.files).toContain("chart-contract.json");
    expect(pack.summary.version).toBe(`app-creation:${pack.summary.hash}`);
  });
});
