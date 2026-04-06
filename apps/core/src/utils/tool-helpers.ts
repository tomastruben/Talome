/**
 * Shared utilities for AI tool result truncation.
 * Prevents unbounded payloads from blowing past LLM context windows.
 */

const DEFAULT_MAX_ITEMS = 50;

/**
 * Truncate a list of items and return metadata about truncation.
 */
export function truncateList<T>(
  items: T[],
  maxItems = DEFAULT_MAX_ITEMS,
): { items: T[]; totalCount: number; truncated: boolean } {
  return {
    items: items.slice(0, maxItems),
    totalCount: items.length,
    truncated: items.length > maxItems,
  };
}

/**
 * Summarize a list by mapping each item through a summarizer function,
 * then truncate to maxItems.
 */
export function summarizeList<T, S>(
  items: T[],
  summarizer: (item: T) => S,
  maxItems = DEFAULT_MAX_ITEMS,
): { items: S[]; totalCount: number; truncated: boolean } {
  return {
    items: items.slice(0, maxItems).map(summarizer),
    totalCount: items.length,
    truncated: items.length > maxItems,
  };
}
