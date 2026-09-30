import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReasoningSummary } from "@/components/ai-elements/reasoning";

describe("ReasoningSummary", () => {
  it("shows a quiet Thinking row while it streams, and the live summary on request", () => {
    render(
      <ReasoningSummary
        text="I checked the configured notification channels."
        state="streaming"
        isMessageStreaming
      />,
    );

    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.queryByText("I checked the configured notification channels.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Toggle reasoning summary" }));
    expect(screen.getByText("I checked the configured notification channels.")).toBeVisible();
  });

  it("collapses a completed summary to one line that opens and closes", () => {
    render(
      <ReasoningSummary
        text="The request requires checking channels before automations."
        state="done"
      />,
    );

    // History has no measured duration, so it just says "Thought".
    expect(screen.getByText("Thought")).toBeInTheDocument();
    expect(screen.queryByText("The request requires checking channels before automations.")).not.toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "Toggle reasoning summary" });
    fireEvent.click(trigger);
    expect(screen.getByText("The request requires checking channels before automations.")).toBeVisible();

    fireEvent.click(trigger);
    expect(screen.queryByText("The request requires checking channels before automations.")).not.toBeInTheDocument();
  });

  it("shows a durable completion state when an older message has no summary", () => {
    render(<ReasoningSummary text="" state="done" />);

    expect(screen.getByText("Thought · no summary was provided")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reasoning status" })).toBeDisabled();
  });
});
