/**
 * Tool discovery — per-conversation tool routing for dashboard/messaging chat.
 *
 * A conversation starts with the base domains (core + setup). Other active
 * domains join when:
 *   1. any user message in the conversation matches their keywords,
 *   2. one of their tools was already used in the conversation, or
 *   3. the model calls `discover_tools`, which activates matching domains.
 *
 * The set only grows within a conversation (monotonic), so the tool list sent
 * to the model — and therefore the provider's cached prompt prefix — stays
 * stable from turn to turn. Everything is re-derived from the message history
 * on every request, so it survives restarts; an in-memory LRU additionally
 * remembers discover_tools activations for histories that do not keep tool
 * parts (e.g. messaging platforms that persist plain text only).
 */

import { tool, type Tool, type UIMessage } from "ai";
import { z } from "zod";
import {
  getActiveDomainNames,
  getAllDomains,
  getBaseDomainNames,
  getDomain,
  getDomainKeywords,
  getDomainNameForTool,
  getOrderedDomainTools,
  isBaseDomain,
  matchDomainsForText,
  textMatchesKeyword,
  type ToolDomain,
} from "./tool-registry.js";

export const DISCOVER_TOOLS_NAME = "discover_tools";

/** Max domains a single discover_tools call may activate — keeps the tool set lean. */
const MAX_ACTIVATIONS_PER_CALL = 3;
const MAX_RESULTS = 12;
const MAX_CONVERSATIONS = 500;
const CONVERSATION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_KEY_LENGTH = 200;

// ── Conversation state (in-memory LRU) ──────────────────────────────────────

interface RememberedDomains {
  domains: Set<string>;
  touchedAt: number;
}

const conversationDomains = new Map<string, RememberedDomains>();

function recall(key: string): Set<string> {
  const entry = conversationDomains.get(key);
  if (!entry) return new Set();
  if (Date.now() - entry.touchedAt > CONVERSATION_TTL_MS) {
    conversationDomains.delete(key);
    return new Set();
  }
  return entry.domains;
}

function remember(key: string, domains: Iterable<string>): void {
  const merged = new Set([...recall(key), ...domains]);
  // Re-insert so Map iteration order doubles as LRU order.
  conversationDomains.delete(key);
  conversationDomains.set(key, { domains: merged, touchedAt: Date.now() });
  while (conversationDomains.size > MAX_CONVERSATIONS) {
    const oldest = conversationDomains.keys().next().value;
    if (oldest === undefined) break;
    conversationDomains.delete(oldest);
  }
}

/** Test helper — forget all remembered conversations. */
export function resetToolRoutingState(): void {
  conversationDomains.clear();
}

/**
 * Stable key for a conversation: an explicit conversation id when the client
 * sends one, otherwise the id of the first message (stable for the life of a
 * conversation because history is append-only).
 */
export function deriveConversationKey(explicit: unknown, messages: readonly UIMessage[]): string | undefined {
  if (typeof explicit === "string" && explicit.trim()) return `c:${explicit.trim().slice(0, MAX_KEY_LENGTH)}`;
  const firstId = messages[0]?.id;
  if (typeof firstId === "string" && firstId.trim()) return `m:${firstId.trim().slice(0, MAX_KEY_LENGTH)}`;
  return undefined;
}

// ── History derivation ──────────────────────────────────────────────────────

interface ToolPartLike {
  type: string;
  toolName?: unknown;
  state?: unknown;
  output?: unknown;
}

function messageText(message: UIMessage): string {
  return (message.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join(" ");
}

function toolPartName(part: ToolPartLike): string | undefined {
  if (part.type === "dynamic-tool") return typeof part.toolName === "string" ? part.toolName : undefined;
  if (part.type.startsWith("tool-")) return part.type.slice("tool-".length);
  return undefined;
}

function activatedDomainsFromOutput(output: unknown): string[] {
  if (!output || typeof output !== "object") return [];
  const value = (output as { activatedDomains?: unknown }).activatedDomains;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Domains implied by a conversation's history: keyword matches over every
 * user message, domains of tools already called, and domains a previous
 * discover_tools call activated. Only active, non-base domains are returned.
 */
export function deriveDomainsFromHistory(
  messages: readonly UIMessage[],
  activeDomains: ReadonlySet<string> = getActiveDomainNames(),
): Set<string> {
  const derived = new Set<string>();
  const add = (name: string | undefined) => {
    if (!name || !activeDomains.has(name)) return;
    const domain = getDomain(name);
    if (domain && !isBaseDomain(domain)) derived.add(name);
  };

  for (const message of messages) {
    if (message.role === "user") {
      for (const name of matchDomainsForText(messageText(message), activeDomains)) add(name);
      continue;
    }
    for (const part of (message.parts ?? []) as ToolPartLike[]) {
      const toolName = toolPartName(part);
      if (!toolName) continue;
      if (toolName === DISCOVER_TOOLS_NAME) {
        for (const name of activatedDomainsFromOutput(part.output)) add(name);
        continue;
      }
      add(getDomainNameForTool(toolName));
    }
  }
  return derived;
}

// ── Routing session ─────────────────────────────────────────────────────────

export interface ToolRoutingSession {
  readonly key: string | undefined;
  /** Domains currently routed into the conversation (base + conversation). Grows only. */
  readonly domains: ReadonlySet<string>;
  /** Add domains (active, known ones only). Returns the names that were newly added. */
  activate(domainNames: Iterable<string>): string[];
  /** Tool names of the routed domains, in deterministic order. */
  toolNames(): string[];
}

export function createToolRoutingSession(options: {
  conversationKey?: string;
  messages: readonly UIMessage[];
  activeDomains?: ReadonlySet<string>;
}): ToolRoutingSession {
  const active = options.activeDomains ?? getActiveDomainNames();
  const key = options.conversationKey;
  const domains = new Set<string>(getBaseDomainNames().filter((n) => active.has(n)));

  const accept = (name: string): boolean => active.has(name) && getDomain(name) !== undefined;

  for (const name of deriveDomainsFromHistory(options.messages, active)) domains.add(name);
  if (key) {
    for (const name of recall(key)) if (accept(name)) domains.add(name);
    remember(key, [...domains].filter((n) => !isBaseDomain(getDomain(n) as ToolDomain)));
  }

  return {
    key,
    domains,
    activate(domainNames) {
      const added: string[] = [];
      for (const name of domainNames) {
        if (!accept(name) || domains.has(name)) continue;
        domains.add(name);
        added.push(name);
      }
      if (key && added.length > 0) remember(key, added);
      return added;
    },
    toolNames() {
      return getOrderedDomainTools(domains).map(([name]) => name);
    },
  };
}

// ── Search ──────────────────────────────────────────────────────────────────

const STOPWORDS = new Set(["the", "a", "an", "to", "for", "my", "and", "of", "in", "on", "with", "me", "i", "it", "is", "can", "you", "how", "do", "what"]);

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function shortDescription(t: Tool): string {
  const description = (t as { description?: string }).description ?? "";
  const firstSentence = description.split(/(?<=[.!?])\s/)[0] ?? description;
  return firstSentence.length > 160 ? `${firstSentence.slice(0, 157)}...` : firstSentence;
}

export interface ToolSearchMatch {
  name: string;
  domain: string;
  description: string;
  score: number;
}

/** Rank registered tools against a free-text query and/or a domain name. */
export function searchRegisteredTools(query: string, domainFilter?: string): ToolSearchMatch[] {
  const tokens = tokenize(query);
  const exact = query.trim().toLowerCase();
  const matches: ToolSearchMatch[] = [];

  for (const domain of getAllDomains()) {
    if (domainFilter && domain.name !== domainFilter) continue;
    const keywords = getDomainKeywords(domain);
    const domainHit = tokens.some((t) => keywords.some((kw) => kw === t || textMatchesKeyword(t, kw)))
      || (exact.length > 0 && keywords.some((kw) => textMatchesKeyword(exact, kw)));
    for (const [name, t] of Object.entries(domain.tools)) {
      if (getDomainNameForTool(name) !== domain.name) continue;
      const description = ((t as { description?: string }).description ?? "").toLowerCase();
      let score = 0;
      if (name === exact) score += 100;
      for (const token of tokens) {
        if (name.includes(token)) score += 3;
        else if (description.includes(token)) score += 1;
      }
      if (domainHit) score += 2;
      if (domainFilter) score += 1;
      if (score > 0) matches.push({ name, domain: domain.name, description: shortDescription(t), score });
    }
  }

  return matches.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ── discover_tools ──────────────────────────────────────────────────────────

const discoverToolsInput = z.object({
  query: z
    .string()
    .max(200)
    .optional()
    .describe("Keyword, capability or exact tool name, e.g. 'automation', 'torrent speed', 'design_app_blueprint'"),
  domain: z
    .string()
    .max(64)
    .optional()
    .describe("Load a whole tool domain by name, e.g. 'automations' or 'arr'"),
});

/**
 * Create the per-request `discover_tools` tool bound to a routing session.
 * Activated domains are added to the session immediately, so their tools are
 * callable from the model's next step (the chat loop re-reads the session in
 * prepareStep) and on every later turn of the conversation.
 */
export function createDiscoverToolsTool(session: ToolRoutingSession): Tool {
  return tool({
    description:
      "Find and load more tools. Your tool list holds core tools plus domains relevant to this conversation; " +
      "other capabilities (media and *arr, downloads, app integrations, automations, widgets, notifications, files, " +
      "storage, monitoring, docker networks/images, app groups and stores, memory management, self-improvement, app creation, local DNS) " +
      "load on demand. Call this with a keyword, capability or exact tool name whenever a tool you need is not in your list — " +
      "never tell the user something is impossible before checking. Matching tools are callable from your next step.",
    inputSchema: discoverToolsInput,
    execute: async ({ query, domain }) => {
      const active = getActiveDomainNames();
      const text = (query ?? "").trim();
      const domainName = domain?.trim() || undefined;

      if (!text && !domainName) {
        return {
          activatedDomains: [],
          tools: [],
          availableDomains: listRoutableDomains(active, session),
          note: "Pass a query or a domain name to load tools.",
        };
      }

      const matches = searchRegisteredTools(text, domainName);

      // Rank candidate domains by their best tool score; keyword-matched domains count too.
      const domainScores = new Map<string, number>();
      for (const m of matches) domainScores.set(m.domain, Math.max(domainScores.get(m.domain) ?? 0, m.score));
      for (const name of matchDomainsForText(text, active)) domainScores.set(name, Math.max(domainScores.get(name) ?? 0, 2));
      if (domainName && getDomain(domainName)) domainScores.set(domainName, Math.max(domainScores.get(domainName) ?? 0, 1000));

      const rankedDomains = [...domainScores.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([name]) => name);

      const toActivate = rankedDomains
        .filter((name) => active.has(name) && !session.domains.has(name))
        .slice(0, MAX_ACTIVATIONS_PER_CALL);
      const activatedDomains = session.activate(toActivate);

      const unconfigured = rankedDomains
        .filter((name) => !active.has(name))
        .slice(0, MAX_ACTIVATIONS_PER_CALL)
        .map((name) => ({ domain: name, needsAnyOfSettings: getDomain(name)?.settingsKeys ?? [] }));

      const tools = matches
        .filter((m) => session.domains.has(m.domain))
        .slice(0, MAX_RESULTS)
        .map(({ name, domain: d, description }) => ({ name, domain: d, description }));

      return {
        activatedDomains,
        alreadyLoaded: rankedDomains.filter((n) => session.domains.has(n) && !activatedDomains.includes(n)).slice(0, 5),
        tools,
        ...(unconfigured.length > 0 ? { unconfigured } : {}),
        ...(tools.length === 0 ? { availableDomains: listRoutableDomains(active, session) } : {}),
        note: activatedDomains.length > 0
          ? "The listed tools are now loaded and callable from your next step."
          : tools.length > 0
            ? "These tools are already loaded — call them directly."
            : "No matching tools. Try another keyword or one of availableDomains.",
      };
    },
  });
}

function listRoutableDomains(active: ReadonlySet<string>, session: ToolRoutingSession) {
  return getAllDomains()
    .filter((d) => active.has(d.name) && !isBaseDomain(d))
    .map((d) => ({
      name: d.name,
      loaded: session.domains.has(d.name),
      summary: d.summary ?? `${Object.keys(d.tools).length} tools — ${getDomainKeywords(d).slice(0, 6).join(", ")}`,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}
