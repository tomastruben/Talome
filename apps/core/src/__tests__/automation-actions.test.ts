import { describe, it, expect, vi, beforeEach } from "vitest";
import { runActions } from "../automation/engine.js";

const {
  mockRestartContainer,
  mockWriteNotification,
  mockWriteAuditEntry,
  mockRunAutomationPrompt,
  mockExec,
} = vi.hoisted(() => ({
  mockRestartContainer: vi.fn().mockResolvedValue(undefined),
  mockWriteNotification: vi.fn(),
  mockWriteAuditEntry: vi.fn(),
  mockRunAutomationPrompt: vi.fn(),
  mockExec: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "" }),
}));

vi.mock("../docker/client.js", () => ({
  restartContainer: mockRestartContainer,
}));

vi.mock("../db/notifications.js", () => ({
  writeNotification: mockWriteNotification,
}));

vi.mock("../db/audit.js", () => ({
  writeAuditEntry: mockWriteAuditEntry,
}));

vi.mock("../approval/engine.js", () => ({
  requiresApproval: (toolName: string) =>
    toolName === "run_shell" || toolName === "launch_claude_code",
}));

vi.mock("../ai/agent.js", () => ({
  runAutomationPrompt: mockRunAutomationPrompt,
}));

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: () => mockExec,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockRunAutomationPrompt.mockResolvedValue("Diagnosis: healthy");
});

describe("runActions", () => {
  const context = {
    automationId: "auto-1",
    automationName: "Restart helper",
    triggerType: "container_stopped",
  };

  it("executes allowlisted actions without approval", async () => {
    const result = await runActions([
      { type: "restart_container", containerId: "myapp" },
      { type: "send_notification", level: "info", title: "Done" },
    ], context);

    expect(result.success).toBe(true);
    expect(result.actionsRun).toBe(2);
    expect(mockRestartContainer).toHaveBeenCalledWith("myapp");
    expect(mockWriteNotification).toHaveBeenCalledWith("info", "Done", "");
  });

  it("blocks run_shell without explicit action approval", async () => {
    const result = await runActions([
      { type: "run_shell", command: "echo hi" },
    ], context);

    expect(result.success).toBe(false);
    expect(result.actionsRun).toBe(0);
    expect(result.error).toContain("requires explicit approval");
  });

  it("executes run_shell when explicitly approved", async () => {
    const result = await runActions([
      { type: "run_shell", command: "echo hi", approved: true },
    ], context);

    expect(result.success).toBe(true);
    expect(result.actionsRun).toBe(1);
  });

  it("executes ask_ai when explicitly approved", async () => {
    const result = await runActions([
      { type: "ask_ai", prompt: "Investigate container issue", approved: true },
    ], context);

    expect(result.success).toBe(true);
    expect(result.actionsRun).toBe(1);
    expect(mockRunAutomationPrompt).toHaveBeenCalledWith({
      prompt: "Investigate container issue",
      automationName: "Restart helper",
      triggerType: "container_stopped",
    });
    expect(mockWriteNotification).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("AI analysis"),
      expect.stringContaining("Diagnosis"),
      "auto-1",
    );
  });
});
