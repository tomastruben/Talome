import type { AppManifest, StoreSource, StoreType } from "@talome/types";

export interface StoreAdapter {
  type: StoreType;
  detect(storePath: string): boolean;
  parse(storePath: string, storeId: string, source?: StoreSource): AppManifest[];
  /**
   * Non-blocking variant used by catalog sync: async fs with periodic yields
   * to the event loop. Adapters without it fall back to `parse`.
   */
  parseAsync?(storePath: string, storeId: string, source?: StoreSource): Promise<AppManifest[]>;
}

/** Yield to the event loop every N app directories while parsing a store. */
export const PARSE_YIELD_EVERY = 16;

/** Let pending I/O and timers run before continuing a long parse loop. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Container paths that typically hold user-provided media, not app-managed data. */
const MEDIA_PATH_PATTERNS = [
  "/media", "/movies", "/tv", "/music", "/audiobooks", "/podcasts",
  "/downloads", "/photos", "/videos", "/upload", "/books", "/comics",
  "/library", "/data/media",
];

/** Heuristic: does this container path likely hold user media rather than app config? */
export function inferMediaVolume(containerPath: string): boolean {
  const lower = containerPath.toLowerCase();
  return MEDIA_PATH_PATTERNS.some((p) => lower === p || lower.startsWith(p + "/"));
}
