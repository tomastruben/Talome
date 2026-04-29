/**
 * Tool response truncation — cap large tool outputs to save model tokens.
 *
 * Wraps each tool's execute() so any result that serializes to more than the
 * configured budget gets truncated. The full result is stashed in an in-process
 * LRU cache, and the model is told the id so it can fetch more via
 * `get_full_tool_result` if it actually needs the rest.
 *
 * Truncation strategy: head + tail (70/30 split). Errors and tracebacks often
 * live at the end of logs, so a pure head cut hides them.
 */

import type { Tool } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getSetting } from "../utils/settings.js";

// ── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_BUDGET_CHARS = 4000;
const HEAD_RATIO = 0.7;
const CACHE_MAX_ENTRIES = 50;
const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Tools that legitimately return large content where truncation defeats the
 * purpose of the call. Numbers are character budgets.
 */
const TOOL_BUDGET_OVERRIDES: Record<string, number> = {
  read_file: 16_000,
  read_user_file: 16_000,
  read_app_config_file: 16_000,
  get_container_logs: 8_000,
  search_container_logs: 8_000,
  browse_files: 8_000,
  list_directory: 8_000,
  inspect_container: 6_000,
  get_full_tool_result: Number.POSITIVE_INFINITY,
  get_truncation_stats: Number.POSITIVE_INFINITY,
};

function getDefaultBudget(): number {
  const raw = getSetting("ai_tool_response_budget");
  if (!raw) return DEFAULT_BUDGET_CHARS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 256 ? n : DEFAULT_BUDGET_CHARS;
}

function getBudgetFor(toolName: string): number {
  const override = TOOL_BUDGET_OVERRIDES[toolName];
  if (override !== undefined) return override;
  return getDefaultBudget();
}

// ── Telemetry ───────────────────────────────────────────────────────────────

interface ToolStat {
  calls: number;
  truncations: number;
  charsReturned: number;
  charsSaved: number;
  largestOriginal: number;
  fetchedFull: number;
}

const stats = new Map<string, ToolStat>();
let processStartedAt = Date.now();

function statFor(name: string): ToolStat {
  let s = stats.get(name);
  if (!s) {
    s = { calls: 0, truncations: 0, charsReturned: 0, charsSaved: 0, largestOriginal: 0, fetchedFull: 0 };
    stats.set(name, s);
  }
  return s;
}

function recordCall(name: string, originalChars: number, returnedChars: number): void {
  const s = statFor(name);
  s.calls += 1;
  s.charsReturned += returnedChars;
  if (originalChars > s.largestOriginal) s.largestOriginal = originalChars;
  if (originalChars > returnedChars) {
    s.truncations += 1;
    s.charsSaved += originalChars - returnedChars;
  }
}

// ── LRU cache ───────────────────────────────────────────────────────────────

interface CacheEntry {
  toolName: string;
  fullSerialized: string;
  originalSize: number;
  storedAt: number;
}

const cache = new Map<string, CacheEntry>();

function pruneCache(): void {
  const now = Date.now();
  for (const [id, entry] of cache) {
    if (now - entry.storedAt > CACHE_TTL_MS) cache.delete(id);
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function storeFullResult(toolName: string, serialized: string): string {
  const id = randomUUID().slice(0, 8);
  cache.set(id, {
    toolName,
    fullSerialized: serialized,
    originalSize: serialized.length,
    storedAt: Date.now(),
  });
  pruneCache();
  return id;
}

// ── Truncation ──────────────────────────────────────────────────────────────

interface TruncatedEnvelope {
  _truncated: {
    id: string;
    tool: string;
    originalChars: number;
    returnedChars: number;
    hint: string;
  };
  preview: string;
}

function truncateString(s: string, budget: number): string {
  if (s.length <= budget) return s;
  const headLen = Math.floor(budget * HEAD_RATIO);
  const tailLen = Math.max(0, budget - headLen - 32); // 32 reserved for the marker
  const head = s.slice(0, headLen);
  const tail = tailLen > 0 ? s.slice(-tailLen) : "";
  return `${head}\n…[truncated ${s.length - headLen - tailLen} chars]…\n${tail}`;
}

function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildTruncatedEnvelope(
  toolName: string,
  serialized: string,
  budget: number,
): TruncatedEnvelope {
  const preview = truncateString(serialized, budget);
  const id = storeFullResult(toolName, serialized);
  return {
    _truncated: {
      id,
      tool: toolName,
      originalChars: serialized.length,
      returnedChars: preview.length,
      hint: `Result was ${serialized.length} chars, truncated to ${preview.length}. Call get_full_tool_result with id="${id}" to retrieve more (supports offset/limit). Or refine your query (filter, narrower path, smaller tail) to get a smaller result directly.`,
    },
    preview,
  };
}

// ── Tool wrapper ────────────────────────────────────────────────────────────

/**
 * Wrap a single tool so its result is truncated when over budget.
 * Idempotent: a tool that has already been wrapped is returned unchanged.
 */
function wrapTool(toolName: string, toolDef: Tool): Tool {
  const flagged = toolDef as Tool & { __truncationWrapped?: boolean; execute?: (args: unknown, opts: unknown) => Promise<unknown> };
  if (flagged.__truncationWrapped) return toolDef;
  if (typeof flagged.execute !== "function") return toolDef;

  const original = flagged.execute.bind(toolDef);
  const wrapped: Tool = {
    ...toolDef,
    execute: (async (args: unknown, opts: unknown) => {
      const result = await original(args, opts);
      const budget = getBudgetFor(toolName);
      if (!Number.isFinite(budget)) {
        const serialized = serialize(result);
        recordCall(toolName, serialized.length, serialized.length);
        return result;
      }

      const serialized = serialize(result);
      if (serialized.length <= budget) {
        recordCall(toolName, serialized.length, serialized.length);
        return result;
      }

      const envelope = buildTruncatedEnvelope(toolName, serialized, budget);
      recordCall(toolName, serialized.length, envelope.preview.length);
      return envelope;
    }) as Tool["execute"],
  };
  Object.defineProperty(wrapped, "__truncationWrapped", { value: true, enumerable: false });
  return wrapped;
}

/** Wrap every tool in the map. Idempotent. */
export function wrapToolsWithTruncation(tools: Record<string, Tool>): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const [name, def] of Object.entries(tools)) {
    out[name] = wrapTool(name, def);
  }
  return out;
}

// ── Companion tool: fetch the full result ───────────────────────────────────

export const getFullToolResultTool = tool({
  description: `Retrieve a previously truncated tool result by id. Use this only after a tool returned a \`_truncated\` envelope and you genuinely need more of the content than the preview showed.

Args:
- id: the id from the \`_truncated\` envelope
- offset: starting char offset (default 0)
- limit: max chars to return (default 8000, max 64000)

Prefer narrowing the original query (filter, narrower path, smaller tail) over fetching the full result. Cached results expire after 30 minutes.`,
  inputSchema: z.object({
    id: z.string().describe("Truncated-result id from a previous tool's _truncated envelope"),
    offset: z.number().int().min(0).default(0).describe("Char offset into the full result"),
    limit: z.number().int().min(256).max(64_000).default(8_000).describe("Max chars to return in this slice"),
  }),
  execute: async ({ id, offset, limit }) => {
    pruneCache();
    const entry = cache.get(id);
    if (!entry) {
      return {
        error: `No cached result for id "${id}". It may have expired (30 min TTL) or been evicted. Re-run the original tool with a narrower query.`,
      };
    }
    statFor(entry.toolName).fetchedFull += 1;
    const total = entry.fullSerialized.length;
    const start = Math.min(offset, total);
    const end = Math.min(start + limit, total);
    const slice = entry.fullSerialized.slice(start, end);
    return {
      tool: entry.toolName,
      offset: start,
      returnedChars: slice.length,
      totalChars: total,
      hasMore: end < total,
      nextOffset: end < total ? end : null,
      content: slice,
    };
  },
});

// ── Stats accessors + tool ──────────────────────────────────────────────────

export interface TruncationStatsRow {
  tool: string;
  calls: number;
  truncations: number;
  truncationRate: number;
  charsReturned: number;
  charsSaved: number;
  largestOriginal: number;
  fetchedFull: number;
}

export interface TruncationStatsSummary {
  uptimeMs: number;
  defaultBudgetChars: number;
  totals: {
    calls: number;
    truncations: number;
    charsReturned: number;
    charsSaved: number;
  };
  rows: TruncationStatsRow[];
}

export function getTruncationStats(): TruncationStatsSummary {
  const rows: TruncationStatsRow[] = [];
  let calls = 0;
  let truncations = 0;
  let charsReturned = 0;
  let charsSaved = 0;
  for (const [name, s] of stats) {
    rows.push({
      tool: name,
      calls: s.calls,
      truncations: s.truncations,
      truncationRate: s.calls > 0 ? s.truncations / s.calls : 0,
      charsReturned: s.charsReturned,
      charsSaved: s.charsSaved,
      largestOriginal: s.largestOriginal,
      fetchedFull: s.fetchedFull,
    });
    calls += s.calls;
    truncations += s.truncations;
    charsReturned += s.charsReturned;
    charsSaved += s.charsSaved;
  }
  rows.sort((a, b) => b.charsSaved - a.charsSaved);
  return {
    uptimeMs: Date.now() - processStartedAt,
    defaultBudgetChars: getDefaultBudget(),
    totals: { calls, truncations, charsReturned, charsSaved },
    rows,
  };
}

export const getTruncationStatsTool = tool({
  description: `Inspect tool-response truncation stats since the server started. Useful for tuning the per-tool char budgets — tools at the top of the list are saving the most tokens, and tools with high \`truncationRate\` may deserve a bigger override.

Returns total/per-tool call counts, truncation counts, chars returned vs saved, the largest single original payload seen, and how often the model fetched the full result via get_full_tool_result.`,
  inputSchema: z.object({
    top: z.number().int().min(1).max(50).default(15).describe("How many top tools to return (sorted by chars saved)"),
    reset: z.boolean().default(false).describe("Reset counters after reading"),
  }),
  execute: async ({ top, reset }) => {
    const summary = getTruncationStats();
    const trimmed = { ...summary, rows: summary.rows.slice(0, top) };
    if (reset) {
      stats.clear();
      processStartedAt = Date.now();
    }
    return trimmed;
  },
});

// ── Test/diagnostics helpers (not exported through index) ───────────────────

export function _resetTruncationCacheForTests(): void {
  cache.clear();
  stats.clear();
  processStartedAt = Date.now();
}
