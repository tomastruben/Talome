import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppBlueprintSchema } from "../creator/contracts.js";
import { validateDesignArtifacts } from "../creator/workspace-executor.js";

const temporaryRoots: string[] = [];

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "talome-design-workflow-"));
  temporaryRoots.push(root);
  await Promise.all([
    mkdir(join(root, ".talome-creator", "research"), { recursive: true }),
    mkdir(join(root, ".talome-creator", "design"), { recursive: true }),
    mkdir(join(root, ".talome-creator", "validation"), { recursive: true }),
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("creator design workflow", () => {
  it("keeps legacy blueprints parseable with empty staged plans", () => {
    const blueprint = AppBlueprintSchema.parse({
      id: "legacy-app",
      name: "Legacy App",
      description: "A legacy app",
      prompt: "Build a legacy app",
      category: "other",
      services: [{ name: "app", image: "example/app:1", ports: [], volumes: [], environment: {} }],
      scaffold: { enabled: false },
      ui: {},
      successCriteria: [],
      designAlignment: { summary: "Use Talome" },
      instructionsVersion: "legacy",
    });

    expect(blueprint.research.useCases).toEqual([]);
    expect(blueprint.experienceDesign.screens).toEqual([]);
  });

  it("requires complete research, screen, and five-point validation artifacts", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, ".talome-creator", "research", "findings.md"), [
      "# Findings",
      "Status: complete",
      "| Candidate | Exact URL/ref | License | Maintenance evidence | Talome fit | Decision | Reusable part |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| Example | https://github.com/example/project/tree/v1.2.0 | MIT | release v1.2.0 | TypeScript and self-hosted | adapt | parser |",
    ].join("\n"));
    await writeFile(join(root, ".talome-creator", "design", "screen-spec.md"), [
      "# Screen Specification",
      "Status: complete",
      "One task-first overview with loading, empty, error, and compact states.",
    ].join("\n"));
    await writeFile(join(root, ".talome-creator", "validation", "report.md"), [
      "# Validation Report",
      "Status: complete",
      "| Check | Reference | Render | Result |",
      "| --- | --- | --- | --- |",
      "| 1 | hierarchy | screenshot | pass |",
      "| 2 | typography | screenshot | pass |",
      "| 3 | layout | screenshot | pass |",
      "| 4 | dark mode and compact | screenshot | pass |",
      "| 5 | interaction | state change | pass |",
    ].join("\n"));

    const checks = await validateDesignArtifacts(root);
    expect(checks).toHaveLength(3);
    expect(checks.every((check) => check.status === "passed")).toBe(true);
  });

  it("fails artifacts that still contain pending work", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, ".talome-creator", "research", "findings.md"), "Status: complete\n- [pending]");
    await writeFile(join(root, ".talome-creator", "design", "screen-spec.md"), "Status: pending");
    await writeFile(join(root, ".talome-creator", "validation", "report.md"), "Status: complete\n| 1 | a | b | c |");

    const checks = await validateDesignArtifacts(root);
    expect(checks.map((check) => check.status)).toEqual(["failed", "failed", "failed"]);
  });

  it("blocks completion when rendered validation omits dark-mode evidence", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, ".talome-creator", "research", "findings.md"), [
      "# Findings",
      "Status: complete",
      "| Candidate | Exact URL/ref | License | Maintenance evidence | Talome fit | Decision | Reusable part |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| Example | https://github.com/example/project/tree/v1.2.0 | MIT | release v1.2.0 | TypeScript and self-hosted | adapt | parser |",
    ].join("\n"));
    await writeFile(
      join(root, ".talome-creator", "design", "screen-spec.md"),
      "Status: complete\nDesktop and compact states are specified.",
    );
    await writeFile(join(root, ".talome-creator", "validation", "report.md"), [
      "# Validation Report",
      "Status: complete",
      "| Check | Reference | Render | Result |",
      "| --- | --- | --- | --- |",
      "| 1 | hierarchy | screenshot | pass |",
      "| 2 | typography | screenshot | pass |",
      "| 3 | layout | screenshot | pass |",
      "| 4 | compact | screenshot | pass |",
      "| 5 | interaction | state change | pass |",
    ].join("\n"));

    const checks = await validateDesignArtifacts(root);
    const renderedValidation = checks.find((check) => check.id === "rendered-validation");
    expect(renderedValidation?.status).toBe("failed");
    expect(renderedValidation?.details).toContain("evidence for dark mode");
  });
});
