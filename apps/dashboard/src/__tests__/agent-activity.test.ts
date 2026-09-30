import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { pendingActivity, pendingApprovalRequest, toolOrbState } from "@/lib/agent-activity";

const user: UIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "Install Jellyfin" }] };

function assistant(parts: UIMessage["parts"]): UIMessage {
  return { id: "a1", role: "assistant", parts };
}

function tool(name: string, state: string, output?: unknown) {
  return { type: `tool-${name}`, toolCallId: `${name}-1`, state, input: {}, output } as unknown as UIMessage["parts"][number];
}

/** A release `approval_required` tool result (core ai/execution.ts). */
function approvalRequired(approvalStatus: "pending" | "approved" = "pending") {
  return {
    status: "approval_required",
    approvalId: "apr_0123456789ab",
    approvalStatus,
    tool: "uninstall_app",
    summary: "Uninstall Jellyfin",
    expiresAt: "2099-01-01T00:00:00.000Z",
    approveUrl: "/dashboard/settings/approvals?id=apr_0123456789ab",
  };
}

describe("toolOrbState", () => {
  it("matches the orb to the kind of work", () => {
    expect(toolOrbState("list_containers")).toBe("searching");
    expect(toolOrbState("get_system_stats")).toBe("searching");
    expect(toolOrbState("wire_apps")).toBe("connecting");
    expect(toolOrbState("create_app")).toBe("shaping");
    expect(toolOrbState("restart_container")).toBe("working");
  });
});

describe("pendingActivity", () => {
  it("says nothing when the chat is idle", () => {
    expect(pendingActivity([user], "ready")).toBeNull();
  });

  it("shows thinking right after you send", () => {
    expect(pendingActivity([user], "submitted")).toBe("Thinking");
  });

  it("stays quiet while words, reasoning or a running tool are on screen", () => {
    expect(pendingActivity([user, assistant([{ type: "text", text: "Sure" }])], "streaming")).toBeNull();
    expect(pendingActivity([user, assistant([{ type: "reasoning", text: "Checking", state: "streaming" }])], "streaming")).toBeNull();
    expect(pendingActivity([user, assistant([tool("install_app", "input-available")])], "streaming")).toBeNull();
    expect(pendingActivity([user, assistant([tool("install_app", "approval-requested")])], "streaming")).toBeNull();
  });

  it("stays quiet next to a pending approval card, even as the stream goes on", () => {
    const held = tool("uninstall_app", "output-available", approvalRequired());
    expect(pendingActivity([user, assistant([held])], "streaming")).toBeNull();
    expect(pendingActivity([user, assistant([held, { type: "step-start" }])], "streaming")).toBeNull();
    // Tool results can also arrive as a JSON string.
    const asString = tool("uninstall_app", "output-available", JSON.stringify(approvalRequired()));
    expect(pendingActivity([user, assistant([asString, { type: "step-start" }])], "submitted")).toBeNull();
  });

  it("thinks again once the owner already approved and the agent retries", () => {
    const approved = tool("uninstall_app", "output-available", approvalRequired("approved"));
    expect(pendingActivity([user, assistant([approved, { type: "step-start" }])], "streaming")).toBe("Thinking");
  });

  it("fills the gap between a finished tool and the next words", () => {
    const parts: UIMessage["parts"] = [tool("list_containers", "output-available"), { type: "step-start" }];
    expect(pendingActivity([user, assistant(parts)], "streaming")).toBe("Thinking");
  });
});

describe("pendingApprovalRequest", () => {
  it("finds the latest pending approval_required result", () => {
    const held = tool("uninstall_app", "output-available", approvalRequired());
    expect(pendingApprovalRequest(assistant([tool("list_apps", "output-available", []), held]))).toMatchObject({
      approvalId: "apr_0123456789ab",
      tool: "uninstall_app",
    });
  });

  it("ignores user messages, running tools and ordinary results", () => {
    expect(pendingApprovalRequest(undefined)).toBeNull();
    expect(pendingApprovalRequest(user)).toBeNull();
    expect(pendingApprovalRequest(assistant([tool("uninstall_app", "input-available")]))).toBeNull();
    expect(pendingApprovalRequest(assistant([tool("list_apps", "output-available", { apps: [] })]))).toBeNull();
    expect(pendingApprovalRequest(assistant([tool("uninstall_app", "output-available", approvalRequired("approved"))]))).toBeNull();
  });
});
