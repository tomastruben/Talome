/**
 * Short-lived caches for the per-turn context the chat path injects into the
 * system prompt. Both inputs change rarely but were recomputed on every turn:
 *
 * - feature-stack status runs `docker ps` + DB reads          → 30s TTL
 * - top memories ranks the memories table and bumps counters  → 60s TTL,
 *   and reloaded early whenever the memories table changes
 *
 * Stable values also keep the dynamic system block byte-identical between
 * turns, which lets the provider reuse the cached conversation prefix.
 */

import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { getTopMemories } from "../db/memories.js";
import { getFeatureStackStatus } from "../stacks/feature-stacks.js";

export const FEATURE_STACK_TTL_MS = 30_000;
export const MEMORIES_TTL_MS = 60_000;

type StackStatus = Awaited<ReturnType<typeof getFeatureStackStatus>>;
type Memory = Awaited<ReturnType<typeof getTopMemories>>[number];

interface CacheEntry<T> {
  value: T;
  at: number;
  fingerprint?: string;
}

let stackCache: CacheEntry<StackStatus> | null = null;
let stackInFlight: Promise<StackStatus> | null = null;
let memoryCache: CacheEntry<Memory[]> | null = null;
let memoryCacheLimit = 0;

/** Feature-stack status, cached for FEATURE_STACK_TTL_MS. Concurrent callers share one refresh. */
export async function getCachedFeatureStackStatus(): Promise<StackStatus> {
  if (stackCache && Date.now() - stackCache.at < FEATURE_STACK_TTL_MS) return stackCache.value;
  if (!stackInFlight) {
    stackInFlight = getFeatureStackStatus()
      .then((value) => {
        stackCache = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        stackInFlight = null;
      });
  }
  return stackInFlight;
}

/**
 * Cheap change detector for the memories table: row count, newest id and
 * newest update among enabled memories. Any add, edit, delete or enable
 * toggle changes at least one of them.
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
  // Re-read after the load: getTopMemories bumps access counters, which the
  // fingerprint deliberately ignores, so this matches the next turn's reading.
  memoryCache = { value, at: Date.now(), fingerprint: memoriesFingerprint() ?? fingerprint };
  memoryCacheLimit = limit;
  return value;
}

/** Drop both caches (tests, or after bulk changes). */
export function invalidateChatContextCaches(): void {
  stackCache = null;
  stackInFlight = null;
  memoryCache = null;
}
