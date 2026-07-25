import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReasoningSummary } from "@/components/ai-elements/reasoning";

describe("ReasoningSummary", () => {
  it("keeps live reasoning visible and expanded", () => {
    render(
      <ReasoningSummary
        text="I checked the configured notification channels."
        state="streaming"
        isMessageStreaming
      />,
    );

    expect(screen.getByText("Thinking")).toHaveClass(
      "shimmer",
      "shimmer-duration-1800",
      "text-muted-foreground",
    );
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("I checked the configured notification channels.")).toBeVisible();
  });

  it("lets a completed summary be collapsed and reopened", () => {
    render(
      <ReasoningSummary
        text="The request requires checking channels before automations."
        state="done"
      />,
    );

    const trigger = screen.getByRole("button", { name: "Toggle reasoning summary" });
    expect(screen.getByText("The request requires checking channels before automations.")).toBeVisible();

    fireEvent.click(trigger);
    expect(screen.queryByText("The request requires checking channels before automations.")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByText("The request requires checking channels before automations.")).toBeVisible();
  });

  it("shows a durable completion state when an older message has no summary", () => {
    render(<ReasoningSummary text="" state="done" />);

    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    expect(screen.getByText("Completed · no summary was provided")).toBeInTheDocument();
    expect(screen.getByText("Complete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reasoning status" })).toBeDisabled();
  });
});
