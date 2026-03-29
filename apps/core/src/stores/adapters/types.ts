import type { AppManifest, StoreSource, StoreType } from "@talome/types";

export interface StoreAdapter {
  type: StoreType;
  detect(storePath: string): boolean;
  parse(storePath: string, storeId: string, source?: StoreSource): AppManifest[];
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
