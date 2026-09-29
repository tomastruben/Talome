/**
 * "The app catalog changed" signal. Store sync fires it after every catalog
 * rewrite; modules that memoize catalog data (e.g. the container list's
 * catalog lookup in routes/containers.ts) subscribe to drop their memo.
 *
 * Keeps stores/ free of imports from HTTP route modules: a memo that is not
 * loaded has nothing to invalidate.
 */

type CatalogListener = () => void;

const listeners = new Set<CatalogListener>();

/** Subscribe to catalog changes. Returns an unsubscribe function. */
export function onCatalogChanged(listener: CatalogListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Notify subscribers that catalog rows were rewritten or removed. Never throws. */
export function notifyCatalogChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // a subscriber's failure must never break a catalog sync
    }
  }
}
