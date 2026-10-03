import { describe, it, expect, vi } from "vitest";
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

const DASHED_CARD = "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-12 text-center";

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

  it("is a dashed card by default, marked as an empty state", () => {
    const { container } = render(<EmptyState title="Empty" className="mt-4" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("data-slot", "empty-state");
    expect(root.className).toBe(`${DASHED_CARD} mt-4`);
  });

  it("fills the view, centred, without the dashed card", () => {
    const { container } = render(<EmptyState fill title="This folder is empty" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("data-slot", "empty-state");
    expect(root).toHaveClass("flex-1", "self-stretch", "min-h-64", "border-0", "items-center", "justify-center", "p-12");
    expect(root.className).not.toMatch(/border-dashed|rounded-xl/);
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

  it("renders a Retry button when onRetry provided", () => {
    const spy = vi.fn();
    render(<ErrorState onRetry={spy} />);
    const btn = screen.getByRole("button", { name: "Retry" });
    expect(btn).toBeInTheDocument();
    btn.click();
    expect(spy).toHaveBeenCalledOnce();
  });

  it("gives Retry, the only action on an error screen, a 44px target on touch", () => {
    render(<ErrorState onRetry={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Retry" })).toHaveClass("h-7", "phone-touch:h-11");
  });

  it("does not render retry button when onRetry omitted", () => {
    render(<ErrorState />);
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("is a dashed card by default and fills the view on request", () => {
    const { container, rerender } = render(<ErrorState />);
    let root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("data-slot", "error-state");
    expect(root.className).toBe(DASHED_CARD);

    rerender(<ErrorState fill />);
    root = container.firstElementChild as HTMLElement;
    expect(root).toHaveClass("flex-1", "self-stretch", "min-h-64");
    expect(root.className).not.toContain("border-dashed");
  });
});
