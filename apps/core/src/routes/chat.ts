import { Hono } from "hono";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { UIMessage, UIMessageStreamWriter } from "ai";
import { createChatStream } from "../ai/agent.js";
import { checkDailyCap, getDailyCapUsd, getTodayCostUsd } from "../agent-loop/budget.js";
import { serverError } from "../middleware/request-logger.js";
import { getSetting } from "../utils/settings.js";

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

function getTextFromMessage(message: UIMessage): string {
  return message.parts
    ?.filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("") ?? "";
}

function toOllamaMessages(messages: UIMessage[], pageContext?: string) {
  const ollamaMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    {
      role: "system",
      content: [
        "You are Talome, a concise assistant for a self-hosted home server dashboard.",
        "Answer simple conversation directly and briefly.",
        "If the user asks for a server action, explain what you need or what you will do.",
        pageContext ? `Current dashboard context:\n${pageContext}` : "",
      ].filter(Boolean).join("\n"),
    },
  ];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = getTextFromMessage(message).trim();
    if (!content) continue;
    ollamaMessages.push({ role: message.role, content });
  }

  return ollamaMessages;
}

async function streamNativeOllamaChat(params: {
  messages: UIMessage[];
  pageContext?: string;
  model?: string;
  abortSignal: AbortSignal;
  writer: UIMessageStreamWriter;
}) {
  const url = getSetting("ollama_url");
  if (!url) {
    throw new Error("AI_PROVIDER_NOT_CONFIGURED: No Ollama server configured. Add the URL in Settings → AI Provider.");
  }

  const model = params.model || getSetting("ai_model");
  if (!model) {
    throw new Error("AI_PROVIDER_NOT_CONFIGURED: No Ollama model selected. Choose one in Settings → AI Provider.");
  }

  const textId = `ollama-text-${Date.now()}`;
  const reasoningId = `ollama-reasoning-${Date.now()}`;
  params.writer.write({ type: "start" });
  params.writer.write({ type: "start-step" });
  let textStarted = false;
  let reasoningStarted = true;
  params.writer.write({ type: "reasoning-start", id: reasoningId });
  params.writer.write({
    type: "reasoning-delta",
    id: reasoningId,
    delta: "Starting local Gemma reasoning...\n",
  });

  const res = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: toOllamaMessages(params.messages, params.pageContext),
      stream: true,
      think: true,
      options: {
        num_predict: 512,
      },
    }),
    signal: params.abortSignal,
  });

  if (!res.ok || !res.body) {
    const errorText = await res.text().catch(() => "");
    throw new Error(errorText || `Ollama returned HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const writeText = (delta: string) => {
    if (!delta) return;
    if (!textStarted) {
      params.writer.write({ type: "text-start", id: textId });
      textStarted = true;
    }
    params.writer.write({ type: "text-delta", id: textId, delta });
  };

  const writeReasoning = (delta: string) => {
    if (!delta) return;
    if (!reasoningStarted) {
      params.writer.write({ type: "reasoning-start", id: reasoningId });
      reasoningStarted = true;
    }
    params.writer.write({ type: "reasoning-delta", id: reasoningId, delta });
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (!line) continue;

      const chunk = JSON.parse(line) as {
        message?: { content?: string; thinking?: string };
        error?: string;
      };
      if (chunk.error) throw new Error(chunk.error);
      writeReasoning(chunk.message?.thinking ?? "");
      writeText(chunk.message?.content ?? "");
    }
  }

  if (reasoningStarted) {
    params.writer.write({ type: "reasoning-end", id: reasoningId });
  }
  if (textStarted) {
    params.writer.write({ type: "text-end", id: textId });
  } else {
    writeText("Hello.");
    params.writer.write({ type: "text-end", id: textId });
  }
  params.writer.write({ type: "finish-step" });
  params.writer.write({ type: "finish", finishReason: "stop" });
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

    const useNativeOllama = provider === "ollama" || (!provider && getSetting("ai_provider") === "ollama");

    // Wrap the result stream so lazy read failures are always translated
    // into protocol-level "error" chunks the client can render.
    const uiStream = createUIMessageStream({
      onError: (err) => extractErrorMessage(err),
      execute: async ({ writer }) => {
        if (useNativeOllama) {
          await streamNativeOllamaChat({
            messages,
            pageContext: pageContext ?? undefined,
            model: model ?? undefined,
            abortSignal: streamAbort.signal,
            writer,
          });
          return;
        }

        const result = await createChatStream(messages, pageContext ?? undefined, model ?? undefined, streamAbort.signal, provider ?? undefined);
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
