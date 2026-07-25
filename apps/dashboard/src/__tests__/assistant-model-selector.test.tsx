import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { AssistantModelSelector } from "@/components/assistant/assistant-model-selector";

const models = [
  { id: "gpt-5.6-luna", name: "OpenAI GPT-5.6-luna", provider: "openai" },
  { id: "claude-sonnet-4", name: "Anthropic Claude Sonnet 4", provider: "anthropic" },
];

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Element.prototype.scrollIntoView = vi.fn();
});

describe("AssistantModelSelector", () => {
  it("opens a searchable AI Elements selector and changes the active model", () => {
    const onModelChange = vi.fn();

    render(
      <AssistantModelSelector
        model="gpt-5.6-luna"
        modelOptions={models}
        modelReady
        onModelChange={onModelChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /current model: openai gpt-5\.6-luna/i }));

    const search = screen.getByPlaceholderText("Search models…");
    expect(search).toBeVisible();
    expect(screen.getByText("OpenAI", { selector: "[cmdk-group-heading]" })).toBeVisible();
    expect(screen.getByText("Anthropic", { selector: "[cmdk-group-heading]" })).toBeVisible();

    fireEvent.change(search, { target: { value: "Claude" } });
    expect(screen.queryByRole("option", { name: "Use OpenAI GPT-5.6-luna" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: "Use Anthropic Claude Sonnet 4" }));
    expect(onModelChange).toHaveBeenCalledWith("claude-sonnet-4");
    expect(screen.queryByPlaceholderText("Search models…")).not.toBeInTheDocument();
  });

  it("keeps the trigger disabled until model configuration is ready", () => {
    render(
      <AssistantModelSelector
        model=""
        modelOptions={[]}
        modelReady={false}
        onModelChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /loading models/i })).toBeDisabled();
  });
});
