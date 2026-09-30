import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  BlueprintDraftBar,
  getReadiness,
  type BlueprintState,
} from "@/components/creator/blueprint-draft-bar";

function completeBlueprint(): BlueprintState {
  return {
    identity: { name: "Focused App" },
    research: {
      useCases: [
        {
          id: "primary-job",
          title: "Complete the primary job",
          userGoal: "Finish one meaningful task",
          outcome: "See a useful result",
          frequency: "daily",
        },
      ],
      githubQueries: ["focused app open source github"],
      patternQuestions: [],
      libraryNeeds: [],
    },
    experienceDesign: {
      primaryUseCaseId: "primary-job",
      workflows: [
        {
          id: "primary-flow",
          name: "Primary flow",
          useCaseId: "primary-job",
          outcome: "See a useful result",
          steps: ["Open the app", "Complete the task"],
        },
      ],
      screens: [
        {
          id: "overview",
          name: "Overview",
          useCaseIds: ["primary-job"],
          job: "Complete the primary job",
          primaryAction: "Complete",
          pattern: "Task-focused overview",
          componentCandidates: [],
          states: ["default", "loading", "empty", "error"],
        },
      ],
    },
    services: [
      { name: "app", image: "example/app:1", ports: [], volumes: [], environment: {} },
    ],
    appSpec: {
      surfaces: [{ id: "overview", blocks: [] }],
      assistant: { exposedActions: [] },
    } as unknown as BlueprintState["appSpec"],
    criteria: ["Primary workflow succeeds"],
  };
}

describe("blueprint design readiness", () => {
  it("blocks build until research and screen design are present", () => {
    const blueprint = completeBlueprint();
    delete blueprint.research;
    delete blueprint.experienceDesign;

    const result = getReadiness(blueprint);
    expect(result.ready).toBe(false);
    expect(result.checks.find((check) => check.label === "Research")?.met).toBe(false);
    expect(result.checks.find((check) => check.label === "Screen design")?.met).toBe(false);
  });

  it("enables build after all six design and implementation prerequisites are present", () => {
    const result = getReadiness(completeBlueprint());
    expect(result.ready).toBe(true);
    expect(result.checks).toHaveLength(6);
  });
});

describe("blueprint expanded detail", () => {
  it("renders the expanded detail inside a height-capped scroll container", () => {
    render(
      <BlueprintDraftBar
        blueprint={completeBlueprint()}
        onBuild={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText("Expand blueprint"));

    const scroller = screen.getByText("Research foundation").closest(".overflow-y-auto");
    expect(scroller).not.toBeNull();
    expect(scroller?.className).toContain("max-h-");
  });
});
