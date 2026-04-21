import { Hono } from "hono";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { createChatStream } from "../ai/agent.js";
import { checkDailyCap, getDailyCapUsd, getTodayCostUsd } from "../agent-loop/budget.js";
import { serverError } from "../middleware/request-logger.js";

const chat = new Hono();

/* ── Concurrent stream tracking ──────────────────────────────────────────── */

// Track active streams per conversation to prevent duplicate concurrent requests.
// Key: conversationId (from last user message id fallback), Value: AbortController
const activeStreams = new Map<string, AbortController>();

function extractErrorMessage(err: unknown): string {
  const e = err as any;
  // Anthropic SDK wraps errors in AI_APICallError — the human-readable message
  // is in data.error.message (from the API response body).
  const fromResponseBody = e?.responseBody
    ? (() => { try { return JSON.parse(e.responseBody)?.error?.message; } catch { return undefined; } })()
    : undefined;
  const apiMsg: string | undefined = e?.data?.error?.message ?? fromResponseBody;
  if (apiMsg) return apiMsg;
  return e?.message || "Chat request failed";
}

chat.post("/", async (c) => {
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

    const { messages, pageContext, model, provider } = await c.req.json();

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

    const result = await createChatStream(messages, pageContext ?? undefined, model ?? undefined, streamAbort.signal, provider ?? undefined);

    // Wrap the result stream so lazy read failures are always translated
    // into protocol-level "error" chunks the client can render.
    const uiStream = createUIMessageStream({
      onError: (err) => extractErrorMessage(err),
      execute: ({ writer }) => {
        return writer.merge(
          result.toUIMessageStream({
            sendSources: true,
            onError: (err) => extractErrorMessage(err),
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
        { error: providerMsg, code: "API_KEY_MISSING" },
        422
      );
    }

    return serverError(c, err, { message: extractErrorMessage(err), context: { endpoint: "chat" } });
  }
});

export { chat };
