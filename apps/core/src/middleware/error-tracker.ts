/**
 * In-memory ring buffer that stores recent API error records.
 * Used by the request-logger middleware and the diagnostics endpoint
 * to surface 500-level errors for debugging.
 */

export interface ErrorRecord {
  errorId: string;
  timestamp: string;
  method: string;
  path: string;
  query: string;
  status: number;
  durationMs: number;
  errorType: string;
  errorMessage: string;
  stack?: string;
  userId?: string;
  /** Extra context from the route handler (serviceId, appId, containerId, etc.) */
  context?: Record<string, unknown>;
}

const MAX_ERRORS = 500;

class ErrorTracker {
  private errors: ErrorRecord[] = [];

  record(entry: ErrorRecord): void {
    this.errors.push(entry);
    if (this.errors.length > MAX_ERRORS) {
      this.errors = this.errors.slice(-MAX_ERRORS);
    }
  }

  /** Return errors within the last `windowMs` milliseconds. */
  getRecent(windowMs: number): ErrorRecord[] {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    return this.errors.filter((e) => e.timestamp >= cutoff);
  }

  /** Summary of recent errors grouped by endpoint. */
  getSummary(windowMs: number): {
    count: number;
    byEndpoint: Record<string, number>;
    byErrorType: Record<string, number>;
    errors: ErrorRecord[];
  } {
    const recent = this.getRecent(windowMs);
    const byEndpoint: Record<string, number> = {};
    const byErrorType: Record<string, number> = {};

    for (const e of recent) {
      const key = `${e.method} ${e.path}`;
      byEndpoint[key] = (byEndpoint[key] || 0) + 1;
      byErrorType[e.errorType] = (byErrorType[e.errorType] || 0) + 1;
    }

    return { count: recent.length, byEndpoint, byErrorType, errors: recent };
  }

  /**
   * Top endpoints ranked by error count within the window.
   * Useful for quickly spotting which route is broken.
   */
  getTopEndpoints(windowMs: number, limit = 10): { endpoint: string; count: number; lastSeen: string; lastError: string }[] {
    const recent = this.getRecent(windowMs);
    const map = new Map<string, { count: number; lastSeen: string; lastError: string }>();

    for (const e of recent) {
      const key = `${e.method} ${e.path}`;
      const existing = map.get(key);
      if (!existing || e.timestamp > existing.lastSeen) {
        map.set(key, {
          count: (existing?.count || 0) + 1,
          lastSeen: e.timestamp,
          lastError: e.errorMessage,
        });
      } else {
        existing.count++;
      }
    }

    return Array.from(map.entries())
      .map(([endpoint, data]) => ({ endpoint, ...data }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /** Total error count (all time, in the ring buffer). */
  get size(): number {
    return this.errors.length;
  }

  clear(): void {
    this.errors = [];
  }
}

export const errorTracker = new ErrorTracker();
