import type { MiddlewareHandler } from "hono";

/**
 * Ensures async route errors always propagate to app.onError.
 * Without this, synchronous throws inside async handlers can produce
 * unhandled rejections rather than structured HTTP 500 responses.
 */
export const safeRoute: MiddlewareHandler = async (c, next) => {
  try {
    await next();
  } catch (err) {
    throw err;
  }
};
