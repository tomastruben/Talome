import { describe, expect, it } from "vitest";
import { classifyChatError, serializeChatError } from "../ai/chat-error.js";

describe("chat error classification", () => {
  it("keeps the failed provider attached to an Anthropic credit error", () => {
    const error = {
      statusCode: 400,
      responseBody: JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Your credit balance is too low to access the Anthropic API.",
        },
      }),
    };

    expect(classifyChatError(error, "anthropic")).toMatchObject({
      provider: "anthropic",
      code: "insufficient_credits",
      retryable: false,
      statusCode: 400,
    });
  });

  it("distinguishes OpenAI insufficient quota from a rate limit", () => {
    const quota = classifyChatError({
      statusCode: 429,
      data: { error: { code: "insufficient_quota", message: "You exceeded your current quota." } },
    }, "openai");
    const rateLimit = classifyChatError({
      statusCode: 429,
      data: { error: { code: "rate_limit_exceeded", message: "Rate limit reached for requests." } },
    }, "openai");

    expect(quota.code).toBe("insufficient_credits");
    expect(quota.retryable).toBe(false);
    expect(rateLimit.code).toBe("rate_limited");
    expect(rateLimit.retryable).toBe(true);
  });

  it("classifies invalid credentials separately from billing", () => {
    expect(classifyChatError({
      statusCode: 401,
      responseBody: JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }),
    }, "anthropic")).toMatchObject({
      code: "authentication_failed",
      retryable: false,
    });
  });

  it("serializes a protocol envelope for streamed AI SDK errors", () => {
    const serialized = serializeChatError(new Error("fetch failed"), "openai");
    expect(JSON.parse(serialized)).toMatchObject({
      kind: "talome-chat-error",
      version: 1,
      provider: "openai",
      code: "network_error",
      retryable: true,
    });
  });
});
