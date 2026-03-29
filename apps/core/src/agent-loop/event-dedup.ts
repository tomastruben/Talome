// ── Event Deduplication Cache ────────────────────────────────────────────────
//
// In-memory cache that collapses repeated critical/warning alerts into a single
// event with an occurrence count. Events are "similar" when they share the same
// type + source and their primary numeric value is within ±2%.
//
// Window: 5 minutes. After that the entry expires and a new event is created.

const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const VALUE_TOLERANCE = 0.02; // ±2%

interface CacheEntry {
  eventId: string;
  type: string;
  source: string;
  value: number | null;
  firstSeen: number;
  lastSeen: number;
  count: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(type: string, source: string): string {
  return `${type}:${source}`;
}

/** Extract the primary numeric value from event data for similarity comparison. */
function extractValue(type: string, data: Record<string, unknown>): number | null {
  switch (type) {
    case "high_memory":
      return typeof data.memoryPercent === "number" ? data.memoryPercent : null;
    case "high_cpu":
      return typeof data.cpuPercent === "number" ? data.cpuPercent : null;
    case "disk_trend":
      return typeof data.diskPercent === "number" ? data.diskPercent : null;
    case "error_spike":
      return typeof data.errorRate === "number" ? data.errorRate : null;
    case "restart_loop":
      return typeof data.restartCount === "number" ? data.restartCount : null;
    default:
      return null;
  }
}

function valuesAreSimilar(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  if (a === 0 && b === 0) return true;
  const ref = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / ref <= VALUE_TOLERANCE;
}

/** Prune expired entries from the cache. */
function pruneExpired(): void {
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  for (const [key, entry] of cache) {
    if (entry.lastSeen < cutoff) {
      cache.delete(key);
    }
  }
}

/** Notification thresholds — emit a consolidated notification when count first reaches these. */
export const NOTIFICATION_THRESHOLDS = [10, 50, 200] as const;

export interface DedupResult {
  /** true if this event was merged into an existing one */
  isDuplicate: boolean;
  /** The event ID that represents this group (original or new) */
  canonicalEventId: string;
  /** Total occurrence count after this event */
  count: number;
  /** true if count just crossed a notification threshold */
  shouldNotify: boolean;
}

/**
 * Check whether an incoming event is a duplicate of a recent one.
 * If it is, the cache entry is updated (count incremented, lastSeen bumped).
 * If not, a new cache entry is created.
 */
export function deduplicate(
  eventId: string,
  type: string,
  source: string,
  data: Record<string, unknown>,
): DedupResult {
  pruneExpired();

  const key = cacheKey(type, source);
  const existing = cache.get(key);
  const value = extractValue(type, data);

  if (existing && valuesAreSimilar(existing.value, value)) {
    const prevCount = existing.count;
    existing.count += 1;
    existing.lastSeen = Date.now();
    // Update tracked value to latest reading
    existing.value = value;
    return {
      isDuplicate: true,
      canonicalEventId: existing.eventId,
      count: existing.count,
      shouldNotify: NOTIFICATION_THRESHOLDS.some(
        (t) => prevCount < t && existing.count >= t,
      ),
    };
  }

  // New entry (or values diverged enough to be a distinct event)
  cache.set(key, {
    eventId,
    type,
    source,
    value,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    count: 1,
  });

  return {
    isDuplicate: false,
    canonicalEventId: eventId,
    count: 1,
    shouldNotify: false,
  };
}

/**
 * Format a human-readable occurrence label for the UI.
 * e.g. "Critical memory 99%+ (15 occurrences in last 5 min)"
 */
export function formatOccurrenceLabel(
  message: string,
  count: number,
): string {
  if (count <= 1) return message;
  const windowMin = Math.round(DEDUP_WINDOW_MS / 60_000);
  return `${message} (${count} occurrences in last ${windowMin} min)`;
}

/** Get the current dedup snapshot — useful for debugging / status endpoints. */
export function getDedupSnapshot(): Array<{
  eventId: string;
  type: string;
  source: string;
  value: number | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
}> {
  pruneExpired();
  return Array.from(cache.values()).map((e) => ({
    eventId: e.eventId,
    type: e.type,
    source: e.source,
    value: e.value,
    count: e.count,
    firstSeen: new Date(e.firstSeen).toISOString(),
    lastSeen: new Date(e.lastSeen).toISOString(),
  }));
}

/** Reset cache — useful for testing. */
export function resetDedupCache(): void {
  cache.clear();
}
