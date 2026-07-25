import { describe, expect, it } from "vitest";
import { parseAssistantError } from "@/lib/assistant-chat-error";

describe("assistant chat error protocol", () => {
  it("uses the provider captured by the failed request, not the current selector", () => {
    const error = new Error(JSON.stringify({
      kind: "talome-chat-error",
      version: 1,
      provider: "anthropic",
      code: "insufficient_credits",
      message: "Your credit balance is too low to access the Anthropic API.",
      retryable: false,
    }));

    expect(parseAssistantError(error, "openai")).toMatchObject({
      provider: "anthropic",
      code: "insufficient_credits",
      retryable: false,
    });
  });

  it("does not render a rate limit as an exhausted credit balance", () => {
    const error = new Error(JSON.stringify({
      kind: "talome-chat-error",
      version: 1,
      provider: "openai",
      code: "rate_limited",
      message: "Rate limit reached for requests.",
      retryable: true,
    }));

    expect(parseAssistantError(error, "anthropic").code).toBe("rate_limited");
  });

  it("parses non-streaming JSON errors returned by the chat route", () => {
    const error = new Error(JSON.stringify({
      error: "No Anthropic API key configured.",
      code: "API_KEY_MISSING",
      provider: "anthropic",
      retryable: false,
    }));

    expect(parseAssistantError(error, "openai")).toEqual({
      provider: "anthropic",
      code: "api_key_missing",
      message: "No Anthropic API key configured.",
      retryable: false,
    });
  });

  it("keeps backward compatibility with legacy plain-text credit errors", () => {
    const parsed = parseAssistantError(
      new Error("Your credit balance is too low to access the Anthropic API."),
      "anthropic",
    );
    expect(parsed.code).toBe("insufficient_credits");
  });
});
