import { Hono } from "hono";
import { z } from "zod";
import { checkInterContainerConnectivity, type ContainerPair } from "../docker/client.js";
import { errorTracker } from "../middleware/error-tracker.js";
import { serverError } from "../middleware/request-logger.js";

const health = new Hono();

const containerPairSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  port: z.number().int().positive().optional(),
});

const connectivityRequestSchema = z.object({
  pairs: z.array(containerPairSchema).min(1).max(20),
});

/**
 * GET /api/health/container-connectivity
 *
 * Test inter-container network connectivity between specified container pairs.
 * Each pair tests DNS resolution and TCP/HTTP reachability from 'from' into 'to'.
 *
 * Query params:
 *   pairs - JSON-encoded array of {from, to, port?} objects
 *
 * Example: /api/health/container-connectivity?pairs=[{"from":"sonarr","to":"prowlarr"},{"from":"radarr","to":"qbittorrent"}]
 */
health.get("/container-connectivity", async (c) => {
  try {
    const rawPairs = c.req.query("pairs");
    if (!rawPairs) {
      return c.json({ error: "Missing 'pairs' query parameter. Provide a JSON array of {from, to, port?} objects." }, 400);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawPairs);
    } catch {
      return c.json({ error: "Invalid JSON in 'pairs' query parameter." }, 400);
    }

    const validation = connectivityRequestSchema.safeParse({ pairs: parsed });
    if (!validation.success) {
      return c.json({ error: "Invalid pairs format.", details: validation.error.flatten() }, 400);
    }

    const pairs: ContainerPair[] = validation.data.pairs;
    const report = await checkInterContainerConnectivity(pairs);
    return c.json(report);
  } catch (err) {
    return serverError(c, err, { message: "Failed to check connectivity" });
  }
});

/**
 * POST /api/health/container-connectivity
 *
 * Same as GET but accepts the pairs in the request body for convenience.
 */
health.post("/container-connectivity", async (c) => {
  try {
    const body = await c.req.json();
    const validation = connectivityRequestSchema.safeParse(body);
    if (!validation.success) {
      return c.json({ error: "Invalid request body.", details: validation.error.flatten() }, 400);
    }

    const pairs: ContainerPair[] = validation.data.pairs;
    const report = await checkInterContainerConnectivity(pairs);
    return c.json(report);
  } catch (err) {
    return serverError(c, err, { message: "Failed to check connectivity" });
  }
});

/**
 * GET /api/health/diagnostics
 *
 * Combined health + error diagnostics endpoint.
 * Returns the count and list of recent 5xx errors (last 10 minutes by default)
 * so users can quickly see what's failing.
 *
 * Query params:
 *   - window: time window in minutes (default 10, max 60)
 *   - limit:  max errors to return (default 20, max 100)
 */
health.get("/diagnostics", (c) => {
  const windowMin = Math.min(Math.max(Number(c.req.query("window")) || 10, 1), 60);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 100);
  const windowMs = windowMin * 60 * 1000;

  const summary = errorTracker.getSummary(windowMs);
  const topEndpoints = errorTracker.getTopEndpoints(windowMs, 10);

  const recentErrors = summary.errors
    .slice(-limit)
    .reverse()
    .map((e) => ({
      errorId: e.errorId,
      timestamp: e.timestamp,
      method: e.method,
      path: e.path,
      status: e.status,
      durationMs: e.durationMs,
      errorType: e.errorType,
      errorMessage: e.errorMessage,
      userId: e.userId,
      context: e.context,
    }));

  return c.json({
    status: summary.count === 0 ? "healthy" : "errors_detected",
    windowMinutes: windowMin,
    errorCount: summary.count,
    bufferSize: errorTracker.size,
    topEndpoints,
    byErrorType: summary.byErrorType,
    recentErrors,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

export { health };
