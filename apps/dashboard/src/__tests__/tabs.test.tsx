import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/utils", () => ({
  cn: (...classes: (string | undefined | false)[]) => classes.filter(Boolean).join(" "),
}));

// Mock @base-ui/react/tabs which isn't available in jsdom
vi.mock("@base-ui/react/tabs", () => ({
  Tabs: {
    Root: ({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div className={className} {...props}>{children}</div>
    ),
    List: ({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div role="tablist" className={className} {...props}>{children}</div>
    ),
    Tab: ({ children, className, ...props }: React.HTMLAttributes<HTMLButtonElement>) => (
      <button role="tab" className={className} {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}>{children}</button>
    ),
    Panel: ({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div role="tabpanel" className={className} {...props}>{children}</div>
    ),
    Indicator: ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
      <span className={className} {...props} />
    ),
  },
}));

// TabsBadge and TabsDot are exported from tabs.tsx
import { TabsBadge, TabsDot } from "@/components/ui/tabs";

describe("TabsBadge", () => {
  it("renders its children", () => {
    render(<TabsBadge>42</TabsBadge>);
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("renders as a span element", () => {
    const { container } = render(<TabsBadge>7</TabsBadge>);
    expect(container.querySelector("span")).toBeInTheDocument();
  });

  it("accepts additional className", () => {
    const { container } = render(<TabsBadge className="custom-class">5</TabsBadge>);
    expect(container.querySelector("span")).toHaveClass("custom-class");
  });
});

describe("TabsDot", () => {
  it("renders a span", () => {
    const { container } = render(<TabsDot />);
    expect(container.querySelector("span")).toBeInTheDocument();
  });

  it("applies color class for emerald", () => {
    const { container } = render(<TabsDot color="emerald" />);
    const innerDot = container.querySelector(".bg-status-healthy");
    expect(innerDot).toBeInTheDocument();
  });

  it("applies color class for red", () => {
    const { container } = render(<TabsDot color="red" />);
    expect(container.querySelector(".bg-status-critical")).toBeInTheDocument();
  });

  it("applies color class for amber", () => {
    const { container } = render(<TabsDot color="amber" />);
    expect(container.querySelector(".bg-status-warning")).toBeInTheDocument();
  });

  it("renders pulse animation span when pulse=true", () => {
    const { container } = render(<TabsDot color="emerald" pulse />);
    expect(container.querySelector(".animate-ping")).toBeInTheDocument();
  });

  it("does not render pulse animation span when pulse=false", () => {
    const { container } = render(<TabsDot color="emerald" pulse={false} />);
    expect(container.querySelector(".animate-ping")).not.toBeInTheDocument();
  });
});
