import { describe, expect, it } from "vitest";
import { AUTOMATION_STATUSES, automationStatus, automationStatusMeta } from "@/lib/automation-status";

describe("automation run and step statuses", () => {
  it("names every status the run journal writes", () => {
    expect(AUTOMATION_STATUSES).toEqual(["running", "succeeded", "failed", "blocked_approval", "blocked", "interrupted", "skipped"]);
    expect(automationStatusMeta("running")).toEqual({ label: "Running", tone: "info" });
    expect(automationStatusMeta("succeeded")).toEqual({ label: "Succeeded", tone: "success" });
    expect(automationStatusMeta("failed")).toEqual({ label: "Failed", tone: "error" });
    expect(automationStatusMeta("blocked_approval")).toEqual({ label: "Waiting for approval", tone: "warning" });
    expect(automationStatusMeta("blocked")).toEqual({ label: "Blocked", tone: "warning" });
    expect(automationStatusMeta("interrupted")).toEqual({ label: "Interrupted", tone: "warning" });
    expect(automationStatusMeta("skipped")).toEqual({ label: "Skipped", tone: "neutral" });
  });

  it("reads the stored status first", () => {
    expect(automationStatus({ status: "blocked_approval", success: false })).toBe("blocked_approval");
    expect(automationStatus({ status: "interrupted", success: false })).toBe("interrupted");
    expect(automationStatus({ status: "running", success: true })).toBe("running");
    // A blocked step keeps its precise status over the legacy flag.
    expect(automationStatus({ status: "blocked_approval", success: false, blocked: true })).toBe("blocked_approval");
  });

  it("falls back to the legacy flags for rows written before statuses", () => {
    expect(automationStatus({ status: null, success: true })).toBe("succeeded");
    expect(automationStatus({ success: false })).toBe("failed");
    expect(automationStatus({ status: null, success: false, blocked: true })).toBe("blocked");
  });

  it("never shows a status the server doesn't write", () => {
    // PR-era "waiting_approval" was never a server status: unknown values use the flags.
    expect(automationStatus({ status: "waiting_approval", success: false })).toBe("failed");
    expect(automationStatus({ status: "something-new", success: true })).toBe("succeeded");
  });
});
