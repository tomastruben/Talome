/**
 * Anthropic prompt-cache breakpoints for the chat loop.
 *
 * Anthropic caches the request prefix in the order tools → system → messages,
 * up to 4 explicit breakpoints (`cache_control: { type: "ephemeral" }`). We use:
 *
 *   1. the last always-on (base) tool — shared by every conversation, and it
 *      survives when a conversation adds domains (those tools come after it)
 *   2. the static system prompt — covers all tools + static instructions
 *   3. the message just before the latest user turn — the previous turns,
 *      which the next request will present byte-identically
 *   4. the last message — so each tool-loop step reuses the step before it
 *
 * Only Anthropic reads these options; callers apply them for that provider only.
 * The installed @ai-sdk/anthropic (v3) reads `providerOptions.anthropic.cacheControl`
 * on system messages, messages (applied to their last content part) and tools.
 */

import type { ModelMessage, SystemModelMessage, Tool } from "ai";

type ProviderOptions = NonNullable<ModelMessage["providerOptions"]>;

export const ANTHROPIC_EPHEMERAL_CACHE: ProviderOptions = {
  anthropic: { cacheControl: { type: "ephemeral" } },
};

function withCacheControl(options: ProviderOptions | undefined): ProviderOptions {
  return {
    ...options,
    anthropic: { ...(options?.anthropic ?? {}), cacheControl: { type: "ephemeral" } },
  };
}

function withoutCacheControl(options: ProviderOptions | undefined): ProviderOptions | undefined {
  if (!options?.anthropic || !("cacheControl" in options.anthropic || "cache_control" in options.anthropic)) {
    return options;
  }
  const { cacheControl: _cacheControl, cache_control: _cacheControlSnake, ...anthropic } = options.anthropic;
  const rest: ProviderOptions = { ...options };
  if (Object.keys(anthropic).length > 0) rest.anthropic = anthropic;
  else delete rest.anthropic;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * System messages: the static prompt first (cache breakpoint when `cache`),
 * then the dynamic context — memories, setup status, page context — which may
 * change between turns without invalidating the cached tools + static prompt.
 */
export function buildSystemMessages(params: {
  staticPrompt: string;
  dynamicParts: string[];
  cache: boolean;
}): SystemModelMessage[] {
  const messages: SystemModelMessage[] = [
    {
      role: "system",
      content: params.staticPrompt,
      ...(params.cache ? { providerOptions: ANTHROPIC_EPHEMERAL_CACHE } : {}),
    },
  ];
  const dynamic = params.dynamicParts.filter((p) => p.trim().length > 0);
  if (dynamic.length > 0) {
    messages.push({ role: "system", content: dynamic.join("\n\n") });
  }
  return messages;
}

/**
 * Return a copy of `tools` (same key order) where `toolName` carries an
 * Anthropic cache breakpoint. The shared tool object is never mutated.
 */
export function withToolCacheBreakpoint(tools: Record<string, Tool>, toolName: string | undefined): Record<string, Tool> {
  if (!toolName || !(toolName in tools)) return tools;
  const out: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    out[name] = name === toolName
      ? ({ ...t, providerOptions: withCacheControl((t as { providerOptions?: ProviderOptions }).providerOptions) } as Tool)
      : t;
  }
  return out;
}

/** Anthropic rejects cache_control on empty text and cannot cache thinking blocks. */
function isCacheable(message: ModelMessage): boolean {
  if (message.role === "system") return false;
  const { content } = message;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content) || content.length === 0) return false;
  const last = content[content.length - 1] as { type: string; text?: unknown };
  if (last.type === "text") return typeof last.text === "string" && last.text.trim().length > 0;
  if (last.type === "reasoning" || last.type === "tool-approval-response" || last.type === "tool-approval-request") return false;
  return true;
}

function findCacheable(messages: readonly ModelMessage[], from: number): number {
  for (let i = from; i >= 0; i--) {
    if (isCacheable(messages[i])) return i;
  }
  return -1;
}

/**
 * Place message cache breakpoints (see header: #3 and #4) and strip any
 * message-level breakpoints left from a previous step, so the total never
 * exceeds Anthropic's limit of 4. Returns a new array; inputs are not mutated.
 */
export function applyMessageCacheBreakpoints(messages: readonly ModelMessage[]): ModelMessage[] {
  const marks = new Set<number>();
  const last = findCacheable(messages, messages.length - 1);
  if (last >= 0) marks.add(last);

  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser > 0) {
    const history = findCacheable(messages, lastUser - 1);
    if (history >= 0) marks.add(history);
  }

  return messages.map((message, i) => {
    const current = message.providerOptions as ProviderOptions | undefined;
    const next = marks.has(i) ? withCacheControl(current) : withoutCacheControl(current);
    if (next === current) return message;
    const copy = { ...message } as ModelMessage & { providerOptions?: ProviderOptions };
    if (next) copy.providerOptions = next;
    else delete copy.providerOptions;
    return copy as ModelMessage;
  });
}
