import { describe, it, expect, vi, beforeEach } from "vitest";
import { runActions } from "../automation/engine.js";

const {
  mockWriteNotification,
  mockWriteAuditEntry,
  mockRunAutomationPrompt,
  mockExecuteTool,
} = vi.hoisted(() => ({
  mockWriteNotification: vi.fn(),
  mockWriteAuditEntry: vi.fn(),
  mockRunAutomationPrompt: vi.fn(),
  mockExecuteTool: vi.fn(),
}));

// Legacy v1 actions run their tools through the execution service.
vi.mock("../ai/execution.js", () => ({
  executeTool: mockExecuteTool,
  automationActor: (id: string, name?: string) => ({ kind: "automation", id, label: `Automation: ${name ?? id}` }),
  withExecutionContext: (_actor: unknown, _source: unknown, fn: () => unknown) => fn(),
}));

vi.mock("../ai/tool-registry.js", () => ({
  getAllRegisteredTools: () => ({
    restart_container: { execute: vi.fn() },
    run_shell: { execute: vi.fn() },
  }),
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

beforeEach(() => {
  vi.clearAllMocks();
  mockRunAutomationPrompt.mockResolvedValue("Diagnosis: healthy");
  mockExecuteTool.mockImplementation(async (p: { toolName: string; requireApproval?: boolean }) =>
    p.requireApproval
      ? {
        outcome: "approval_required",
        tier: "destructive",
        durationMs: 0,
        approval: {
          status: "approval_required",
          approvalId: "apr_1",
          approvalStatus: "pending",
          tool: p.toolName,
          summary: "Automation wants to run it.",
          expiresAt: "2099-01-01T00:00:00.000Z",
          approveUrl: "/dashboard/settings/approvals?id=apr_1",
          instructions: "approve",
        },
      }
      : { outcome: "success", tier: "modify", durationMs: 0, result: { success: true, stdout: "ok" } },
  );
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
    expect(mockExecuteTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "restart_container",
      args: { containerId: "myapp" },
      source: "automation",
      actor: expect.objectContaining({ kind: "automation", id: "auto-1" }),
      requireApproval: false,
    }));
    expect(mockWriteNotification).toHaveBeenCalledWith("info", "Done", "");
  });

  it("blocks run_shell without explicit action approval (server-issued approval)", async () => {
    const result = await runActions([
      { type: "run_shell", command: "echo hi" },
    ], context);

    expect(result.success).toBe(false);
    expect(result.actionsRun).toBe(0);
    expect(result.error).toContain("approval");
    expect(result.approvalRequired?.approveUrl).toBe("/dashboard/settings/approvals?id=apr_1");
    expect(result.results[0].blocked).toBe(true);
    expect(mockExecuteTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "run_shell", requireApproval: true }));
  });

  it("executes run_shell when explicitly approved (security mode still applies via executeTool)", async () => {
    const result = await runActions([
      { type: "run_shell", command: "echo hi", approved: true },
    ], context);

    expect(result.success).toBe(true);
    expect(result.actionsRun).toBe(1);
    expect(mockExecuteTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "run_shell",
      args: { command: "echo hi" },
      requireApproval: false,
    }));
  });

  it("executes ask_ai when explicitly approved", async () => {
    const result = await runActions([
      { type: "ask_ai", prompt: "Investigate container issue", approved: true },
    ], context);

    expect(result.success).toBe(true);
    expect(result.actionsRun).toBe(1);
    expect(mockRunAutomationPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Investigate container issue",
        automationName: "Restart helper",
        automationId: "auto-1",
        triggerType: "container_stopped",
      }),
    );
    expect(mockWriteNotification).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("AI analysis"),
      expect.stringContaining("Diagnosis"),
      "auto-1",
    );
  });
});
