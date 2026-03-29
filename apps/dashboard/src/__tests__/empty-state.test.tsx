import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock HugeiconsIcon since it imports SVG internals not available in jsdom
vi.mock("@/components/icons", () => ({
  HugeiconsIcon: ({ icon: _icon, ...props }: Record<string, unknown>) => (
    <svg data-testid="icon" {...props} />
  ),
  AlertCircleIcon: {},
}));

// Mock Button to avoid shadcn internals
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: (string | undefined | false)[]) => classes.filter(Boolean).join(" "),
}));

import { EmptyState, ErrorState } from "@/components/ui/empty-state";

describe("EmptyState", () => {
  it("renders title", () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });

  it("renders description when provided", () => {
    render(<EmptyState title="Empty" description="No items found" />);
    expect(screen.getByText("No items found")).toBeInTheDocument();
  });

  it("does not render description when omitted", () => {
    render(<EmptyState title="Empty" />);
    expect(screen.queryByText("No items found")).not.toBeInTheDocument();
  });

  it("renders action slot when provided", () => {
    render(<EmptyState title="Empty" action={<button>Add item</button>} />);
    expect(screen.getByRole("button", { name: "Add item" })).toBeInTheDocument();
  });

  it("renders icon when provided", () => {
    render(<EmptyState title="Empty" icon={{} as never} />);
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });
});

describe("ErrorState", () => {
  it("renders default title", () => {
    render(<ErrorState />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("renders custom title", () => {
    render(<ErrorState title="Failed to load" />);
    expect(screen.getByText("Failed to load")).toBeInTheDocument();
  });

  it("renders retry button when onRetry provided", () => {
    const spy = vi.fn();
    render(<ErrorState onRetry={spy} />);
    const btn = screen.getByRole("button", { name: /try again/i });
    expect(btn).toBeInTheDocument();
    btn.click();
    expect(spy).toHaveBeenCalledOnce();
  });

  it("does not render retry button when onRetry omitted", () => {
    render(<ErrorState />);
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });
});
