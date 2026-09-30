import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { safeRedirectPath } from "@/lib/safe-redirect";
import {
  lastRecoveryGroup,
  matchesLastGroup,
  normalizeRecoveryCode,
  recoveryCodeGroups,
} from "@/lib/recovery-code";
import { RecoveryCodeReveal } from "@/components/trust/recovery-code";

describe("safeRedirectPath (P0-3 open redirect)", () => {
  it.each([
    ["//evil.test", "/dashboard"],
    ["//evil.test/dashboard", "/dashboard"],
    ["/\\evil.test", "/dashboard"],
    ["\\\\evil.test", "/dashboard"],
    ["https://evil.test", "/dashboard"],
    ["javascript:alert(1)", "/dashboard"],
    ["dashboard", "/dashboard"],
    ["/dashboard\u0000", "/dashboard"],
    ["/\tevil.test", "/dashboard"],
    ["/login", "/dashboard"],
    ["/setup?from=/x", "/dashboard"],
    ["", "/dashboard"],
  ])("rejects %j", (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected);
  });

  it("keeps same-origin paths with query and hash", () => {
    expect(safeRedirectPath("/dashboard/apps?tab=installed#top")).toBe("/dashboard/apps?tab=installed#top");
    expect(safeRedirectPath(null)).toBe("/dashboard");
    expect(safeRedirectPath("/dashboard/a/../b")).toBe("/dashboard/b");
  });

  it("narrows to a prefix when asked", () => {
    expect(safeRedirectPath("/dashboard", "", { within: "/dashboard" })).toBe("/dashboard");
    expect(safeRedirectPath("/dashboard/files", "", { within: "/dashboard" })).toBe("/dashboard/files");
    expect(safeRedirectPath("/dashboardx", "", { within: "/dashboard" })).toBe("");
    expect(safeRedirectPath("/dashboard/../s/abc", "", { within: "/dashboard" })).toBe("");
  });
});

describe("recovery code helpers (P0-4)", () => {
  const code = "7K3M-Q9TD-0A1B-C2D3-E4F5-G6H7";

  it("splits into six groups and knows the last one", () => {
    expect(recoveryCodeGroups(code)).toHaveLength(6);
    expect(lastRecoveryGroup(code)).toBe("G6H7");
  });

  it("matches the last group ignoring case, spaces and look-alikes", () => {
    expect(matchesLastGroup(code, "g6h7")).toBe(true);
    expect(matchesLastGroup(code, " G6H7 ")).toBe(true);
    expect(matchesLastGroup("AAAA-B0I1", "boi1")).toBe(true);
    expect(matchesLastGroup(code, "G6H")).toBe(false);
    expect(matchesLastGroup(code, "")).toBe(false);
    expect(normalizeRecoveryCode("ab-cd ol")).toBe("ABCD01");
  });
});

describe("RecoveryCodeReveal", () => {
  it("shows the groups and only continues after the last group is typed back", () => {
    const onContinue = vi.fn();
    render(<RecoveryCodeReveal code="7K3M-Q9TD-0A1B-C2D3-E4F5-G6H7" onContinue={onContinue} />);

    expect(screen.getByRole("group", { name: /Recovery code: 7K3M, Q9TD/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy recovery code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print" })).toBeInTheDocument();

    const continueButton = screen.getByRole("button", { name: "Continue" });
    fireEvent.click(continueButton);
    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("doesn't match");

    const field = screen.getByLabelText("Last group of the code");
    expect(field).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(field, { target: { value: "g6h7" } });
    fireEvent.click(continueButton);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});
