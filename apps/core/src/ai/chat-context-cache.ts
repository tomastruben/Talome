/**
 * Caches for the per-turn context the chat path injects into the prompt.
 *
 * Global, short-lived caches (both inputs change rarely but were recomputed
 * on every turn):
 * - feature-stack status runs `docker ps` + DB reads          → 30s TTL,
 *   dropped early after the agent runs a state-changing tool
 * - top memories ranks the memories table and bumps counters  → 60s TTL,
 *   reloaded early whenever the memories table changes
 *
 * Per-conversation state, which keeps everything in front of the cached
 * history byte-identical from turn to turn (Anthropic caches tools → system →
 * messages, so any change in the system block re-writes the whole history):
 * - a memories snapshot taken on the conversation's first turn, so memories
 *   extracted after each reply do not reshuffle the system block. Additions
 *   are ignored, but the snapshot is re-taken as soon as one of its memories
 *   is deleted, disabled or edited — from any write path or process
 * - turn notes: turn-scoped context (page context, saved screenshot paths)
 *   attached to the user message it belongs to, and replayed verbatim on
 *   later turns
 */

import { eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { getTopMemories } from "../db/memories.js";
import { getFeatureStackStatus } from "../stacks/feature-stacks.js";

export const FEATURE_STACK_TTL_MS = 30_000;
export const MEMORIES_TTL_MS = 60_000;
export const CONVERSATION_CONTEXT_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_CONVERSATIONS = 500;
const MAX_NOTES_PER_CONVERSATION = 200;

type StackStatus = Awaited<ReturnType<typeof getFeatureStackStatus>>;
type Memory = Awaited<ReturnType<typeof getTopMemories>>[number];

interface CacheEntry<T> {
  value: T;
  at: number;
  fingerprint?: string;
}

// ── Feature-stack status ────────────────────────────────────────────────────

let stackCache: (CacheEntry<StackStatus> & { generation: number }) | null = null;
let stackInFlight: { promise: Promise<StackStatus>; generation: number } | null = null;
/** Bumped by every invalidation; results of refreshes started earlier are discarded. */
let stackGeneration = 0;

/** Feature-stack status, cached for FEATURE_STACK_TTL_MS. Concurrent callers share one refresh. */
export async function getCachedFeatureStackStatus(): Promise<StackStatus> {
  const generation = stackGeneration;
  if (stackCache && stackCache.generation === generation && Date.now() - stackCache.at < FEATURE_STACK_TTL_MS) {
    return stackCache.value;
  }
  if (!stackInFlight || stackInFlight.generation !== generation) {
    const promise: Promise<StackStatus> = getFeatureStackStatus()
      .then((value) => {
        if (generation === stackGeneration) stackCache = { value, at: Date.now(), generation };
        return value;
      })
      .finally(() => {
        if (stackInFlight?.promise === promise) stackInFlight = null;
      });
    stackInFlight = { promise, generation };
  }
  return stackInFlight.promise;
}

/**
 * Drop the feature-stack status so the next turn sees installs, removals and
 * config changes the agent just made. Safe against in-flight refreshes: a
 * refresh started before the call can no longer populate the cache.
 */
export function invalidateFeatureStackCache(): void {
  stackGeneration++;
  stackCache = null;
  stackInFlight = null;
}

// ── Top memories ────────────────────────────────────────────────────────────

let memoryCache: CacheEntry<Memory[]> | null = null;
let memoryCacheLimit = 0;

/**
 * Cheap change detector for the memories table: row count, newest id and
 * newest update among enabled memories. Any add, edit, delete or enable
 * toggle changes at least one of them; access-count bumps do not.
 */
function memoriesFingerprint(): string | undefined {
  try {
    const row = db
      .select({
        n: sql<number>`count(*)`,
        maxId: sql<number | null>`max(${schema.memories.id})`,
        maxUpdated: sql<string | null>`max(${schema.memories.updatedAt})`,
      })
      .from(schema.memories)
      .where(eq(schema.memories.enabled, true))
      .get();
    return row ? `${row.n}:${row.maxId ?? ""}:${row.maxUpdated ?? ""}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Top memories for the system prompt, cached for MEMORIES_TTL_MS and
 * invalidated as soon as the memories table changes. Returned sorted by id so
 * the rendered prompt block does not reshuffle when ranking scores drift.
 */
export async function getCachedTopMemories(limit = 10): Promise<Memory[]> {
  const fingerprint = memoriesFingerprint();
  const fresh = memoryCache
    && memoryCacheLimit === limit
    && Date.now() - memoryCache.at < MEMORIES_TTL_MS
    && fingerprint !== undefined
    && memoryCache.fingerprint === fingerprint;
  if (fresh && memoryCache) return memoryCache.value;

  const rows = await getTopMemories(limit);
  const value = [...rows].sort((a, b) => a.id - b.id);
  // Store the fingerprint read BEFORE the load: if a memory is written while
  // loading, the next call sees a different fingerprint and reloads instead
  // of serving this (older) list under the newer fingerprint.
  memoryCache = { value, at: Date.now(), fingerprint };
  memoryCacheLimit = limit;
  return value;
}

// ── Per-conversation context ────────────────────────────────────────────────

interface ConversationContext {
  touchedAt: number;
  memories?: { limit: number; value: Memory[] };
  /** User message id → turn note attached to that message. Insertion-ordered. */
  notes: Map<string, string>;
}

const conversations = new Map<string, ConversationContext>();

function conversationContext(key: string, create: boolean): ConversationContext | undefined {
  let entry = conversations.get(key);
  if (entry && Date.now() - entry.touchedAt > CONVERSATION_CONTEXT_TTL_MS) {
    conversations.delete(key);
    entry = undefined;
  }
  if (!entry) {
    if (!create) return undefined;
    entry = { touchedAt: Date.now(), notes: new Map() };
  }
  // Re-insert so Map iteration order doubles as LRU order.
  conversations.delete(key);
  entry.touchedAt = Date.now();
  conversations.set(key, entry);
  while (conversations.size > MAX_CONVERSATIONS) {
    const oldest = conversations.keys().next().value;
    if (oldest === undefined) break;
    conversations.delete(oldest);
  }
  return entry;
}

/**
 * Whether every memory in a snapshot still exists, is enabled and has the same
 * content. Checked against the database (a primary-key lookup of at most
 * `limit` rows) rather than relying on invalidation calls, so deletes, "clear
 * all", edits and disables made from Settings, MCP (another process) or
 * another conversation are all seen. New memories do not invalidate it.
 */
function snapshotStillValid(snapshot: Memory[]): boolean {
  if (snapshot.length === 0) return true;
  try {
    const rows = db
      .select({
        id: schema.memories.id,
        content: schema.memories.content,
        enabled: schema.memories.enabled,
      })
      .from(schema.memories)
      .where(inArray(schema.memories.id, snapshot.map((m) => m.id)))
      .all();
    const current = new Map(rows.map((r) => [r.id, r]));
    return snapshot.every((m) => {
      const row = current.get(m.id);
      return !!row && !!row.enabled && row.content === m.content;
    });
  } catch {
    // Cannot confirm the snapshot: re-take it rather than risk replaying a
    // memory the user removed.
    return false;
  }
}

/**
 * Top memories as of the conversation's first turn. Later turns reuse the
 * snapshot, so memories extracted after each reply do not change the system
 * block (and bust the cached history) mid-conversation. The snapshot is
 * re-taken when one of its memories was deleted, disabled or edited. Without
 * a key this is just getCachedTopMemories().
 */
export async function getConversationMemories(conversationKey: string | undefined, limit = 10): Promise<Memory[]> {
  if (!conversationKey) return getCachedTopMemories(limit);
  const existing = conversationContext(conversationKey, false)?.memories;
  if (existing && existing.limit === limit && snapshotStillValid(existing.value)) return existing.value;
  const value = await getCachedTopMemories(limit);
  const entry = conversationContext(conversationKey, true) as ConversationContext;
  entry.memories = { limit, value };
  return value;
}

/** Drop a conversation's memories snapshot — e.g. after the agent edited memories in it. */
export function invalidateConversationMemories(conversationKey: string | undefined): void {
  if (!conversationKey) return;
  const entry = conversationContext(conversationKey, false);
  if (entry) entry.memories = undefined;
}

/** Turn notes remembered for a conversation (user message id → note). */
export function getTurnNotes(conversationKey: string | undefined): ReadonlyMap<string, string> {
  if (!conversationKey) return new Map();
  return conversationContext(conversationKey, false)?.notes ?? new Map();
}

/** Remember the turn note for one user message of a conversation. */
export function rememberTurnNote(conversationKey: string | undefined, messageId: string, note: string): void {
  if (!conversationKey || !messageId) return;
  const entry = conversationContext(conversationKey, true) as ConversationContext;
  entry.notes.delete(messageId);
  entry.notes.set(messageId, note);
  while (entry.notes.size > MAX_NOTES_PER_CONVERSATION) {
    const oldest = entry.notes.keys().next().value;
    if (oldest === undefined) break;
    entry.notes.delete(oldest);
  }
}

/** Drop every cache and all per-conversation state (tests, or after bulk changes). */
export function invalidateChatContextCaches(): void {
  invalidateFeatureStackCache();
  memoryCache = null;
  conversations.clear();
}
