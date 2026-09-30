/** Pure helpers for core's health endpoint (`GET /api/health`). */

/**
 * Reads a 503 body. Core answers 503 with `{status: "degraded", checks}` when
 * its database probe fails: the server is reachable, so that is "degraded"
 * with named checks, not a network failure counting toward "offline" (which
 * is what the old code did, dropping the checks). A 503 from a proxy (no
 * JSON) is still a network-level failure.
 */
export function parseDegradedBody(body: unknown): { checks: Record<string, "ok" | "error">; uptime: number } | null {
  if (!body || typeof body !== "object") return null;
  const candidate = body as { status?: unknown; checks?: unknown; uptime?: unknown };
  if (candidate.status !== "degraded") return null;
  const checks: Record<string, "ok" | "error"> = {};
  if (candidate.checks && typeof candidate.checks === "object") {
    for (const [key, value] of Object.entries(candidate.checks as Record<string, unknown>)) {
      if (value === "ok" || value === "error") checks[key] = value;
    }
  }
  return { checks, uptime: typeof candidate.uptime === "number" ? candidate.uptime : 0 };
}

/** Human names for the health checks core reports. */
const CHECK_NAMES: Record<string, string> = { db: "the database", docker: "Docker" };

/** "Docker and the database", or null when no check is named as failing. */
export function failingChecksLabel(checks: Record<string, "ok" | "error">): string | null {
  const failing = Object.entries(checks)
    .filter(([, value]) => value === "error")
    .map(([key]) => CHECK_NAMES[key] ?? key);
  if (failing.length === 0) return null;
  if (failing.length === 1) return failing[0];
  return `${failing.slice(0, -1).join(", ")} and ${failing[failing.length - 1]}`;
}
