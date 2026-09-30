import type { Context, ErrorHandler, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { csrf } from "hono/csrf";
import { randomUUID } from "node:crypto";
import { errorTracker } from "./error-tracker.js";
import { getRequestId, getRequestStart } from "./request-logger.js";
import { createLogger } from "../utils/logger.js";

const errorLog = createLogger("error");

/**
 * CSRF protection — belt-and-suspenders on top of SameSite=Lax cookies and
 * the CORS allowlist.
 *
 * Policy (Hono `csrf()`): a state-changing request (not GET/HEAD) whose
 * Content-Type is one a plain HTML form can send — urlencoded, multipart,
 * text/plain, or NO body/Content-Type at all — must prove it comes from
 * Talome itself: either `Sec-Fetch-Site: same-origin` or a trusted `Origin`.
 * Otherwise it is rejected with 403.
 *
 * - Requests with a JSON (or other non-form) Content-Type always pass: a
 *   browser cannot send one cross-site without a CORS preflight, which the
 *   CORS allowlist answers.
 * - Bodyless POST/DELETE without an Origin are rejected on purpose: that is
 *   exactly what a cross-site form or an older browser can produce. Every
 *   browser sends Origin (and modern ones Sec-Fetch-Site) on fetch()
 *   POST/DELETE, so the dashboard — including its bodyless calls — passes.
 *   Non-browser clients (curl, scripts) either send `Content-Type:
 *   application/json` or an `Origin` header. This is consistent with CORS:
 *   CORS permits no-Origin requests only because it governs who may READ a
 *   response, not who may change state.
 *
 * A rejection is a clean JSON 403, never an "unhandled error".
 */
export function csrfProtection(isTrustedOrigin: (origin: string) => boolean): MiddlewareHandler {
  const guard = csrf({ origin: (origin) => isTrustedOrigin(origin) });
  return async (c, next) => {
    if (c.req.path.startsWith("/api/webhooks/")) return next();
    let passed = false;
    try {
      await guard(c, async () => {
        passed = true;
        await next();
      });
    } catch (err) {
      // Only the guard's own rejection becomes a 403 here; errors thrown by
      // later handlers propagate to onError unchanged.
      if (!passed && err instanceof HTTPException && err.status === 403) {
        return c.json(
          {
            error:
              "Cross-site request rejected — send a trusted Origin header or a JSON Content-Type with state-changing requests",
          },
          403,
        );
      }
      throw err;
    }
  };
}

/**
 * Global error handler. HTTPExceptions below 500 are intended responses
 * (403 from CSRF, 413/400 from Hono helpers, 401 from auth helpers): they are
 * returned as-is and not logged or tracked as unhandled errors. Everything
 * else is logged, recorded for diagnostics and answered with a generic 500.
 */
export const appErrorHandler: ErrorHandler = (err, c: Context) => {
  if (err instanceof HTTPException && err.status < 500) {
    return err.getResponse();
  }

  // Reuse the request-level ID if available, otherwise generate one
  const errorId = getRequestId(c) || randomUUID().slice(0, 8);
  const startMs = getRequestStart(c);
  const durationMs = startMs ? Date.now() - startMs : -1;

  errorLog.error(`Unhandled error ${errorId}`, err);

  // Record to the in-memory error tracker for the diagnostics endpoint
  const url = new URL(c.req.url);
  errorTracker.record({
    errorId,
    timestamp: new Date().toISOString(),
    method: c.req.method,
    path: url.pathname,
    query: url.search,
    status: 500,
    durationMs,
    errorType: err.constructor?.name || "Error",
    errorMessage: err.message || String(err),
    stack: err.stack,
    userId: (c.get("sessionUser" as never) as string) || undefined,
  });

  return c.json(
    {
      error: "An unexpected error occurred",
      errorId,
      timestamp: new Date().toISOString(),
    },
    500,
  );
};
