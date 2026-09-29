/**
 * Server-side cache for the media library payload served by GET /api/media/library.
 *
 * /library pulls the full Sonarr /series and Radarr /movie lists (can be
 * several MB for large libraries). The mapped payload is cached and one
 * upstream fetch is shared between concurrent requests.
 *
 * Lives outside routes/media.ts so anything that mutates Sonarr/Radarr (the
 * media router itself, AI tools, automations) can drop the cache without
 * importing the HTTP router.
 */

export const LIBRARY_CACHE_TTL_MS = 60_000;
/** Shorter TTL when Sonarr/Radarr failed, so recovery shows up quickly. */
export const LIBRARY_CACHE_PARTIAL_TTL_MS = 10_000;

let libraryCache: { key: string; at: number; ttl: number; payload: unknown } | null = null;
let libraryInflight: { key: string; generation: number; promise: Promise<unknown> } | null = null;
let libraryGeneration = 0;

/** Drop the cached library payload (after any library mutation). */
export function invalidateLibraryCache(): void {
  libraryGeneration++;
  libraryCache = null;
}

/**
 * Return the cached payload for `key`, or build it with `build` — sharing one
 * in-flight build between concurrent callers. A build that raced with an
 * invalidation is returned to its callers but never cached.
 */
export function getOrBuildLibrary(
  key: string,
  build: () => Promise<{ payload: unknown; complete: boolean }>,
): Promise<unknown> {
  const now = Date.now();
  if (libraryCache && libraryCache.key === key && now - libraryCache.at < libraryCache.ttl) {
    return Promise.resolve(libraryCache.payload);
  }
  if (!libraryInflight || libraryInflight.key !== key || libraryInflight.generation !== libraryGeneration) {
    const generation = libraryGeneration;
    const promise = build()
      .then(({ payload, complete }) => {
        // Don't cache a result that raced with a mutation.
        if (generation === libraryGeneration) {
          libraryCache = {
            key,
            at: Date.now(),
            ttl: complete ? LIBRARY_CACHE_TTL_MS : LIBRARY_CACHE_PARTIAL_TTL_MS,
            payload,
          };
        }
        return payload;
      })
      .finally(() => {
        if (libraryInflight?.promise === promise) libraryInflight = null;
      });
    libraryInflight = { key, generation, promise };
  }
  return libraryInflight.promise;
}
