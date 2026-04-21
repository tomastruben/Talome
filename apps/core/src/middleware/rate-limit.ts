import type { MiddlewareHandler } from "hono";
import { RateLimiterMemory } from "rate-limiter-flexible";

// Cache of limiter instances keyed by "maxRequests:windowMs"
const limiters = new Map<string, RateLimiterMemory>();

function getLimiter(maxRequests: number, windowMs: number): RateLimiterMemory {
  const key = `${maxRequests}:${windowMs}`;
  if (!limiters.has(key)) {
    limiters.set(
      key,
      new RateLimiterMemory({
        points: maxRequests,
        duration: windowMs / 1000, // RateLimiterMemory uses seconds
      })
    );
  }
  return limiters.get(key)!;
}

/**
 * Rate limiter middleware backed by rate-limiter-flexible (RateLimiterMemory).
 * Keyed by client IP. Returns 429 with Retry-After header when limit exceeded.
 *
 * @param maxRequests Max requests allowed per window
 * @param windowMs    Window duration in milliseconds
 */
export function rateLimit(maxRequests: number, windowMs: number): MiddlewareHandler {
  return async (c, next) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
      c.req.header("x-real-ip") ??
      "unknown";

    const limiter = getLimiter(maxRequests, windowMs);

    try {
      await limiter.consume(ip);
      return next();
    } catch (rejRes: unknown) {
      const retryAfter =
        rejRes && typeof rejRes === "object" && "msBeforeNext" in rejRes
          ? Math.ceil((rejRes as { msBeforeNext: number }).msBeforeNext / 1000)
          : Math.ceil(windowMs / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "Too many requests", retryAfter }, 429);
    }
  };
}
