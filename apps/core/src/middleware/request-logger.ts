/**
 * Hono middleware that logs all API requests and captures 5xx errors
 * into the ErrorTracker for diagnostics.
 *
 * For every request:
 *  - Assigns a unique X-Request-Id header
 *  - Records start time for duration measurement
 *  - After the handler runs, checks response status
 *  - 5xx responses are recorded in the error tracker and logged
 *  - If the 500 response body lacks an errorId, injects one so the
 *    client can always cross-reference with server logs
 *
 * This catches both:
 *  - Errors that reach app.onError (unhandled throws)
 *  - Errors caught by route-level try/catch blocks that return 500 directly
 *
 * Route handlers can call `captureRouteError(c, err)` inside their catch
 * blocks to preserve the full stack trace for the error log — without this,
 * route-caught errors only get the message string from the JSON body.
 *
 * Even simpler: use `serverError(c, err)` which captures AND returns the
 * 500 response in one call.
 */

import type { MiddlewareHandler, Context } from "hono";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import { errorTracker, type ErrorRecord } from "./error-tracker.js";

const log = createLogger("api-error");

/**
 * Store the current request's errorId so app.onError can reuse it
 * rather than generating a second ID.
 */
const REQUEST_ID_KEY = "requestId" as never;
const REQUEST_START_KEY = "requestStart" as never;
const CAPTURED_ERROR_KEY = "capturedError" as never;
const CAPTURED_CONTEXT_KEY = "capturedErrorContext" as never;

export function getRequestId(c: { get: (key: never) => unknown }): string | undefined {
  return c.get(REQUEST_ID_KEY) as string | undefined;
}

export function getRequestStart(c: { get: (key: never) => unknown }): number | undefined {
  return c.get(REQUEST_START_KEY) as number | undefined;
}

/**
 * Call from a route handler's catch block to preserve the full Error
 * (including stack trace) so the request-logger middleware can include
 * it in the structured log line and error tracker record.
 *
 * ```ts
 * catch (err) {
 *   captureRouteError(c, err, { containerId: id });
 *   return c.json({ error: "..." }, 500);
 * }
 * ```
 */
export function captureRouteError(
  c: { set: (key: never, value: unknown) => void },
  err: unknown,
  context?: Record<string, unknown>,
): void {
  c.set(CAPTURED_ERROR_KEY, err);
  if (context) c.set(CAPTURED_CONTEXT_KEY, context);
}

/**
 * Convenience: capture the error AND return a 500 JSON response in one call.
 * Replaces the common pattern:
 *
 * ```ts
 * catch (err) {
 *   return c.json({ error: err instanceof Error ? err.message : "..." }, 500);
 * }
 * ```
 *
 * With:
 *
 * ```ts
 * catch (err) {
 *   return serverError(c, err);
 * }
 * ```
 */
export function serverError(
  c: Context,
  err: unknown,
  opts?: { message?: string; context?: Record<string, unknown>; extra?: Record<string, unknown> },
): Response {
  const error = err instanceof Error ? err : new Error(String(err));
  captureRouteError(c, error, opts?.context);
  return c.json(
    { error: opts?.message || error.message || "Internal server error", ...opts?.extra },
    500,
  );
}

/**
 * Record an error in the tracker for routes that return a graceful fallback
 * (e.g. 200 with empty data) instead of a 500 status. Without this, the
 * requestLogger middleware won't see the error because it only captures 5xx.
 *
 * ```ts
 * catch (err) {
 *   recordGracefulError(c, err, { endpoint: "notifications/list" });
 *   return c.json([]);
 * }
 * ```
 */
export function recordGracefulError(
  c: { get: (key: never) => unknown; req: { method: string; url: string } },
  err: unknown,
  context?: Record<string, unknown>,
): void {
  const error = err instanceof Error ? err : new Error(String(err));
  const errorId = (c.get(REQUEST_ID_KEY) as string) || "unknown";
  const startMs = c.get(REQUEST_START_KEY) as number | undefined;
  const url = new URL(c.req.url);

  const record: ErrorRecord = {
    errorId,
    timestamp: new Date().toISOString(),
    method: c.req.method,
    path: url.pathname,
    query: url.search,
    status: 500,
    durationMs: startMs ? Date.now() - startMs : -1,
    errorType: error.constructor.name,
    errorMessage: error.message,
    stack: error.stack,
    context: { ...context, gracefulFallback: true },
  };

  errorTracker.record(record);

  log.error(`${c.req.method} ${url.pathname} (graceful fallback)`, {
    errorId,
    error: error.message,
    stack: error.stack,
    context,
  });
}

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const requestId = randomUUID().slice(0, 8);
  const startMs = Date.now();

  c.set(REQUEST_ID_KEY, requestId);
  c.set(REQUEST_START_KEY, startMs);

  // Set the request ID on the response so callers can reference it
  c.header("X-Request-Id", requestId);

  await next();

  const status = c.res.status;
  if (status < 500) return;

  const durationMs = Date.now() - startMs;
  const url = new URL(c.req.url);

  // Check if the route handler captured an error with full stack trace
  const capturedErr = c.get(CAPTURED_ERROR_KEY) as Error | undefined;
  const capturedCtx = c.get(CAPTURED_CONTEXT_KEY) as Record<string, unknown> | undefined;

  // Try to extract error details from the response body.
  // Clone the response so the original stream is not consumed.
  let errorMessage = "Unknown error";
  let errorId = requestId;
  let bodyHadErrorId = false;
  let parsedBody: Record<string, unknown> | null = null;

  try {
    const cloned = c.res.clone();
    parsedBody = (await cloned.json()) as Record<string, unknown>;
    if (typeof parsedBody.error === "string") errorMessage = parsedBody.error;
    if (typeof parsedBody.errorId === "string") {
      errorId = parsedBody.errorId;
      bodyHadErrorId = true;
    }
  } catch {
    // Body wasn't JSON or couldn't be read — use defaults
  }

  // If a captured error has a better message, prefer it
  if (capturedErr?.message && errorMessage === "Unknown error") {
    errorMessage = capturedErr.message;
  }

  // Inject errorId + timestamp into 5xx JSON responses that lack them.
  // This means every 500 response the client receives will have an errorId
  // for cross-referencing with the diagnostics endpoint / server logs,
  // without modifying each route handler individually.
  if (parsedBody && !bodyHadErrorId) {
    const enriched = {
      ...parsedBody,
      errorId,
      timestamp: new Date().toISOString(),
    };
    c.res = new Response(JSON.stringify(enriched), {
      status: c.res.status,
      headers: c.res.headers,
    });
  }

  // Derive error type: use the captured error's constructor name if available,
  // otherwise fall back to the generic "HttpError" label.
  const errorType = capturedErr?.constructor?.name || "HttpError";

  const record: ErrorRecord = {
    errorId,
    timestamp: new Date(startMs).toISOString(),
    method: c.req.method,
    path: url.pathname,
    query: url.search,
    status,
    durationMs,
    errorType,
    errorMessage,
    stack: capturedErr?.stack,
    userId: (c.get("sessionUser" as never) as string) || undefined,
    context: capturedCtx,
  };

  errorTracker.record(record);

  // Structured log line with all diagnostic fields
  log.error(`${status} ${c.req.method} ${url.pathname}`, {
    errorId,
    timestamp: record.timestamp,
    status,
    method: c.req.method,
    path: url.pathname,
    query: url.search || undefined,
    durationMs,
    errorType,
    error: errorMessage,
    stack: capturedErr?.stack,
    userId: record.userId,
    context: capturedCtx,
  });
};
