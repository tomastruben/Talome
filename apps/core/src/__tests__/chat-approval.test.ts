import { describe, it, expect, vi } from "vitest";
import { generateText, tool, type ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";

vi.mock("../db/audit.js", () => ({ writeAuditEntry: vi.fn() }));
vi.mock("../approval/tool-approvals.js", () => ({
  consumeApproval: vi.fn(() => null),
  requestApproval: vi.fn(),
  PENDING_TTL_MS: 30 * 60 * 1000,
}));
vi.mock("../utils/settings.js", () => ({ getSetting: vi.fn(() => "cautious") }));

import { gateToolExecution } from "../ai/tool-gateway.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A model that asks to uninstall an app, then answers in text once it sees a tool result. */
function uninstallingModel() {
  return new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      const sawToolResult = prompt.some((msg) => msg.role === "tool" && msg.content.some((p) => p.type === "tool-result"));
      if (sawToolResult) {
        return { content: [{ type: "text", text: "Done." }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
      }
      return {
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "uninstall_app", input: JSON.stringify({ appId: "jellyfin", confirmed: true }) }],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

describe("dashboard chat approvals (AI SDK tool approval)", () => {
  it("pauses a destructive call for the person's approval and runs it only after approval", async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const uninstall = tool({
      description: "Uninstall an app",
      inputSchema: z.object({ appId: z.string(), confirmed: z.boolean() }),
      execute,
    });
    const tools = { uninstall_app: gateToolExecution(uninstall, "uninstall_app", "destructive", { kind: "dashboard" }, "cautious") };

    // Turn 1: the model asks — even with confirmed: true — and the call is held for approval.
    const first = await generateText({ model: uninstallingModel(), prompt: "remove jellyfin", tools });
    expect(execute).not.toHaveBeenCalled();
    const request = first.content.find((p) => p.type === "tool-approval-request");
    expect(request).toBeDefined();

    // Turn 2: the chat UI sends the person's approval; the tool runs once.
    const approvalId = (request as { approvalId: string }).approvalId;
    const messages: ModelMessage[] = [
      { role: "user", content: "remove jellyfin" },
      ...first.response.messages,
      { role: "tool", content: [{ type: "tool-approval-response", approvalId, approved: true }] },
    ];
    const second = await generateText({ model: uninstallingModel(), messages, tools });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(second.text).toBe("Done.");
  });

  it("does not run the tool when the person denies it", async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const uninstall = tool({ description: "Uninstall", inputSchema: z.object({ appId: z.string(), confirmed: z.boolean() }), execute });
    const tools = { uninstall_app: gateToolExecution(uninstall, "uninstall_app", "destructive", { kind: "dashboard" }, "cautious") };

    const first = await generateText({ model: uninstallingModel(), prompt: "remove jellyfin", tools });
    const approvalId = (first.content.find((p) => p.type === "tool-approval-request") as { approvalId: string }).approvalId;
    await generateText({
      model: uninstallingModel(),
      messages: [
        { role: "user", content: "remove jellyfin" },
        ...first.response.messages,
        { role: "tool", content: [{ type: "tool-approval-response", approvalId, approved: false }] },
      ],
      tools,
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
