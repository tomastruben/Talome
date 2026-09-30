import { describe, expect, it } from "vitest";

import {
  curateOpenAiModels,
  resolveOpenAiActiveModel,
} from "../routes/ai-models.js";

describe("curateOpenAiModels", () => {
  it("keeps only the latest Sol, Terra, and Luna generation", () => {
    expect(curateOpenAiModels([
      { id: "gpt-5.6-luna", created: 106 },
      { id: "gpt-5.6-terra", created: 105 },
      { id: "gpt-5.6-sol", created: 104 },
      { id: "gpt-5.5", created: 103 },
      { id: "gpt-image-2", created: 102 },
      { id: "gpt-5.4-mini", created: 101 },
      { id: "codex-5.3", created: 100 },
    ])).toEqual([
      {
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        description: "Recommended · balanced for everyday work",
      },
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        description: "Most capable · for complex work",
      },
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        description: "Fastest · lowest cost",
      },
    ]);
  });

  it("automatically advances to a newer tiered generation", () => {
    expect(curateOpenAiModels([
      { id: "gpt-5.6-terra", created: 200 },
      { id: "gpt-5.7-sol", created: 100 },
      { id: "gpt-5.7-terra", created: 99 },
    ]).map((model) => model.id)).toEqual([
      "gpt-5.7-terra",
      "gpt-5.7-sol",
    ]);
  });

  it("falls back to one latest relevant chat model", () => {
    expect(curateOpenAiModels([
      { id: "gpt-image-2", created: 300 },
      { id: "gpt-5.5", created: 200 },
      { id: "gpt-4o", created: 100 },
    ])).toEqual([{
      id: "gpt-5.5",
      name: "GPT-5.5",
      description: "Latest available chat model",
    }]);
  });

  it("preserves a current selection and replaces a hidden legacy selection", () => {
    const curated = curateOpenAiModels([
      { id: "gpt-5.6-luna", created: 102 },
      { id: "gpt-5.6-terra", created: 101 },
      { id: "gpt-5.6-sol", created: 100 },
    ]);

    expect(resolveOpenAiActiveModel("gpt-5.6-luna", curated)).toBe("gpt-5.6-luna");
    expect(resolveOpenAiActiveModel("gpt-5.5", curated)).toBe("gpt-5.6-terra");
  });
});
