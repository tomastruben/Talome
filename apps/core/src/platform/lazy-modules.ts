/**
 * Lazily loaded heavy native modules.
 *
 * `sharp` pulls in libvips (tens of MB of native code + thread pool) at
 * import time. Most requests never resize an image, so load it on first use
 * instead of at server boot / route registration.
 */

import type sharpType from "sharp";

export type SharpFactory = typeof sharpType;

let sharpPromise: Promise<SharpFactory> | null = null;

/** Resolve the `sharp` factory, importing the module once on first call. */
export function loadSharp(): Promise<SharpFactory> {
  if (!sharpPromise) {
    sharpPromise = import("sharp")
      .then((mod) => mod.default)
      .catch((err: unknown) => {
        // Allow a retry on the next call instead of caching the failure.
        sharpPromise = null;
        throw err;
      });
  }
  return sharpPromise;
}
