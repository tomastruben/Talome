import { describe, it, expect } from "vitest";
import { getToolTier, requiresApproval } from "../approval/engine.js";

describe("approval engine", () => {
  it("marks run_shell as destructive and approval-required", () => {
    expect(getToolTier("run_shell")).toBe("destructive");
    expect(requiresApproval("run_shell")).toBe(true);
  });

  it("marks read tools as not requiring approval", () => {
    expect(getToolTier("list_containers")).toBe("read");
    expect(requiresApproval("list_containers")).toBe(false);
  });
});
