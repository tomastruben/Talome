import { Hono } from "hono";
import { detectJellyfinErrors } from "../services/diagnostics.js";
import { errorTracker } from "../middleware/error-tracker.js";
import { serverError } from "../middleware/request-logger.js";
import { getSystemStats } from "../docker/client.js";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import type { SystemStats } from "@talome/types";

const diagnostics = new Hono();

diagnostics.get("/jellyfin-errors", async (c) => {
  try {
    const result = await detectJellyfinErrors();
    return c.json(result);
  } catch (err) {
    return serverError(c, err, { message: "Failed to detect Jellyfin errors" });
  }
});

/**
 * GET /api/diagnostics/recent-errors
 *
 * Returns a summary + list of recent 5xx API errors for debugging.
 * Query params:
 *   - window:   time window in minutes (default 10, max 60)
 *   - limit:    max errors to return (default 50, max 200)
 *   - endpoint: filter to a specific endpoint path (e.g. "/api/containers")
 */
diagnostics.get("/recent-errors", (c) => {
  const windowMin = Math.min(Math.max(Number(c.req.query("window")) || 10, 1), 60);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const endpointFilter = c.req.query("endpoint");
  const windowMs = windowMin * 60 * 1000;

  const summary = errorTracker.getSummary(windowMs);
  const topEndpoints = errorTracker.getTopEndpoints(windowMs);

  // Filter by endpoint if requested
  let filtered = summary.errors;
  if (endpointFilter) {
    filtered = filtered.filter((e) => e.path.startsWith(endpointFilter));
  }

  // Return most recent errors first, capped at limit
  const errors = filtered
    .slice(-limit)
    .reverse();

  return c.json({
    windowMinutes: windowMin,
    count: summary.count,
    filteredCount: errors.length,
    byEndpoint: summary.byEndpoint,
    byErrorType: summary.byErrorType,
    topEndpoints,
    errors,
  });
});

/**
 * GET /api/diagnostics/error/:errorId
 *
 * Look up a single error record by its errorId for cross-referencing.
 */
diagnostics.get("/error/:errorId", (c) => {
  const errorId = c.req.param("errorId");
  // Search the full buffer (no time window)
  const all = errorTracker.getRecent(Infinity);
  const found = all.find((e) => e.errorId === errorId);

  if (!found) {
    return c.json({ error: "Error record not found (may have been evicted from ring buffer)" }, 404);
  }

  return c.json(found);
});

/**
 * GET /api/diagnostics/health
 *
 * Combined health check: system stats, database status, recent error summary.
 * Designed for quick triage when the dashboard is misbehaving.
 */
diagnostics.get("/health", async (c) => {
  const windowMs = 10 * 60 * 1000; // 10 minutes
  const errorSummary = errorTracker.getSummary(windowMs);
  const topEndpoints = errorTracker.getTopEndpoints(windowMs, 5);

  let systemOk = false;
  let systemStats: SystemStats | null = null;
  try {
    systemStats = await getSystemStats();
    systemOk = true;
  } catch { /* Docker may be unreachable */ }

  let dbOk = false;
  try {
    db.get(sql`SELECT 1`);
    dbOk = true;
  } catch { /* DB may be corrupted */ }

  const healthy = dbOk && systemOk && errorSummary.count === 0;

  return c.json({
    status: healthy ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    checks: {
      database: dbOk ? "ok" : "error",
      docker: systemOk ? "ok" : "error",
      recentErrors: errorSummary.count,
    },
    systemStats: systemStats ? {
      cpuPercent: systemStats.cpu.usage,
      memoryPercent: systemStats.memory.percent,
      diskPercent: systemStats.disk.percent,
    } : null,
    errors: {
      last10Minutes: errorSummary.count,
      byEndpoint: errorSummary.byEndpoint,
      byErrorType: errorSummary.byErrorType,
      topEndpoints,
    },
  }, healthy ? 200 : 503);
});

export { diagnostics };
