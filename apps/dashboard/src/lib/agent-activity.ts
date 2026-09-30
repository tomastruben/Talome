import type { ChatStatus, UIMessage } from "ai";
import type { OrbState } from "thinking-orbs";

/**
 * What the assistant is doing, as a thinking-orb animation.
 * Reads look for something, wiring connects things, making composes,
 * everything else works.
 */
export function toolOrbState(toolName: string): OrbState {
  const name = toolName.toLowerCase();
  if (/^(get|list|search|find|check|read|query|recall|inspect|browse|lookup|scan|diagnose|analy[sz]e|monitor|describe|show|fetch)_/.test(name)) {
    return "searching";
  }
  if (/(wire|connect|link|pair|integrat|proxy|network|tailscale|mdns|dns|mount)/.test(name)) {
    return "connecting";
  }
  if (/(create|design|generate|scaffold|blueprint|compose|draft|write|plan)/.test(name)) {
    return "shaping";
  }
  return "working";
}

/** Tool parts are typed `tool-<name>` or dynamic tools carrying `toolName`. */
function partToolName(part: UIMessage["parts"][number]): string | null {
  if (part.type === "dynamic-tool") return (part as { toolName: string }).toolName;
  if (part.type.startsWith("tool-")) return part.type.slice(5);
  return null;
}

function partState(part: UIMessage["parts"][number]): string | undefined {
  return (part as { state?: string }).state;
}

/**
 * The gap the conversation can't fill by itself: after you send, and between
 * a tool finishing and the next words. Returns a label while nothing else on
 * screen shows the assistant is busy, otherwise null.
 */
export function pendingActivity(messages: UIMessage[], status: ChatStatus | string): string | null {
  if (status !== "submitted" && status !== "streaming") return null;
  const last = messages[messages.length - 1];
  if (!last || last.role === "user") return "Thinking";
  if (last.role !== "assistant") return null;

  for (let i = last.parts.length - 1; i >= 0; i--) {
    const part = last.parts[i];
    if (part.type === "step-start") continue;
    if (part.type === "text") return part.text.trim() ? null : "Thinking";
    if (part.type === "reasoning") return null;
    if (partToolName(part)) {
      const state = partState(part);
      // A running tool or a pending approval shows its own state
      return state === "output-available" || state === "output-error" || state === "output-denied" ? "Thinking" : null;
    }
    return null;
  }
  return "Thinking";
}
