import { Hono } from "hono";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { createChatStream } from "../ai/agent.js";
import { sessionChatActor, withExecutionContext } from "../ai/execution.js";
import { checkDailyCap, getDailyCapUsd, getTodayCostUsd } from "../agent-loop/budget.js";
import { serverError } from "../middleware/request-logger.js";
import { getActiveProvider } from "../ai/configured-model.js";
import { serializeChatError } from "../ai/chat-error.js";

const chat = new Hono();

/* ── Concurrent stream tracking ──────────────────────────────────────────── */

// Track active streams per conversation to prevent duplicate concurrent requests.
// Key: conversationId (from last user message id fallback), Value: AbortController
const activeStreams = new Map<string, AbortController>();

function resolveRequestProvider(provider: unknown): string {
  if (provider === "anthropic" || provider === "openai" || provider === "kimi" || provider === "ollama") return provider;
  return getActiveProvider();
}

chat.post("/", async (c) => {
  let requestProvider = resolveRequestProvider(undefined);
  try {
    // Enforce daily AI budget cap
    if (!checkDailyCap()) {
      const spent = getTodayCostUsd().toFixed(2);
      const cap = getDailyCapUsd().toFixed(2);
      return c.json(
        { error: `Daily AI budget reached ($${spent} / $${cap}). Adjust in Settings → API Cost.`, code: "DAILY_CAP_EXCEEDED" },
        429,
      );
    }

    const { messages, pageContext, model, provider, conversationId } = await c.req.json();
    requestProvider = resolveRequestProvider(provider);

    if (!messages || !Array.isArray(messages)) {
      return c.json({ error: "messages array is required" }, 400);
    }

    // Derive a stream key from the last user message id for dedup
    const lastUserMsg = [...messages].reverse().find((m: { role: string }) => m.role === "user");
    const streamKey = lastUserMsg?.id ?? `anon-${Date.now()}`;

    // If there's already an active stream for this exact message, abort the old one
    const existingStream = activeStreams.get(streamKey);
    if (existingStream) {
      existingStream.abort();
      activeStreams.delete(streamKey);
    }

    // Create a linked abort controller that respects both client disconnect and our tracking
    const streamAbort = new AbortController();
    const clientSignal = c.req.raw.signal;

    // If client disconnects, abort our tracked stream too
    const onClientAbort = () => streamAbort.abort();
    clientSignal.addEventListener("abort", onClientAbort, { once: true });

    activeStreams.set(streamKey, streamAbort);

    // Tool calls in this chat act as the session user (audit, approvals).
    const actor = sessionChatActor(c.get("sessionUser" as never), c.get("sessionUsername" as never), c.get("sessionRole" as never));
    // Optional stable conversation id keys per-conversation tool routing;
    // without it the first message id is used (see ai/tool-discovery.ts).
    const result = await withExecutionContext(actor, "chat", () =>
      createChatStream(messages, pageContext ?? undefined, model ?? undefined, streamAbort.signal, requestProvider, {
        conversationId: typeof conversationId === "string" ? conversationId : undefined,
      }),
    );

    // Wrap the result stream so lazy read failures are always translated
    // into protocol-level "error" chunks the client can render.
    const uiStream = createUIMessageStream({
      onError: (err) => serializeChatError(err, requestProvider),
      execute: ({ writer }) => {
        return writer.merge(
          result.toUIMessageStream({
            sendReasoning: true,
            sendSources: true,
            onError: (err) => serializeChatError(err, requestProvider),
          }),
        );
      },
      onFinish: () => {
        activeStreams.delete(streamKey);
        clientSignal.removeEventListener("abort", onClientAbort);
      },
    });

    return createUIMessageStreamResponse({ stream: uiStream });
  } catch (err: any) {
    const message = err?.message || "";

    if (message.includes("AI_PROVIDER_NOT_CONFIGURED") || message.includes("ANTHROPIC_API_KEY_MISSING")) {
      const providerMsg = message.includes(":")
        ? message.split(": ").slice(1).join(": ")
        : "No AI provider configured. Go to Settings → AI Provider to set one up.";
      return c.json(
        { error: providerMsg, code: "API_KEY_MISSING", provider: requestProvider, retryable: false },
        422
      );
    }

    return serverError(c, err, {
      message: serializeChatError(err, requestProvider),
      context: { endpoint: "chat", provider: requestProvider },
    });
  }
});

export { chat };
