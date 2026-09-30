import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { pendingActivity, toolOrbState } from "@/lib/agent-activity";

const user: UIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "Install Jellyfin" }] };

function assistant(parts: UIMessage["parts"]): UIMessage {
  return { id: "a1", role: "assistant", parts };
}

function tool(name: string, state: string) {
  return { type: `tool-${name}`, toolCallId: `${name}-1`, state, input: {} } as unknown as UIMessage["parts"][number];
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

  it("fills the gap between a finished tool and the next words", () => {
    const parts: UIMessage["parts"] = [tool("list_containers", "output-available"), { type: "step-start" }];
    expect(pendingActivity([user, assistant(parts)], "streaming")).toBe("Thinking");
  });
});
