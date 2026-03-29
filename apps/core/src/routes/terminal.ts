/**
 * Terminal route — thin HTTP proxy to the terminal daemon on :4001.
 *
 * The terminal daemon (terminal-daemon.ts) runs as a separate process that
 * survives tsx watch restarts. All PTY session logic lives there.
 *
 * This route:
 *  - Forwards all /api/terminal/* HTTP requests to the daemon
 *  - Exposes the daemon port so the frontend can connect WebSocket directly
 *
 * WebSocket connections go directly from the browser to the daemon port
 * (no WS proxy needed — avoids bidirectional pipe complexity).
 */

import type { Hono } from "hono";
import { inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { DAEMON_PORT } from "../terminal-constants.js";
import { ensureDaemonRunning } from "../terminal-spawn.js";

const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

/**
 * Enrich session list with display names from the evolution_runs DB table.
 * The daemon stores display names in memory only, so they're lost on restart.
 */
function enrichSessionsWithDisplayNames(
  sessions: { id: string; displayName?: string | null; [key: string]: unknown }[],
): typeof sessions {
  // Collect evolution run IDs that are missing a display name
  const missing: { idx: number; runId: string }[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (s.displayName) continue;
    const m = (s.id as string).match(/^sess_evolution-(.+)$/);
    if (m) missing.push({ idx: i, runId: m[1] });
  }
  if (missing.length === 0) return sessions;

  const runIds = missing.map((m) => m.runId);
  const rows = db
    .select({ id: schema.evolutionRuns.id, displayName: schema.evolutionRuns.displayName })
    .from(schema.evolutionRuns)
    .where(inArray(schema.evolutionRuns.id, runIds))
    .all();

  const nameById = new Map(rows.filter((r) => r.displayName).map((r) => [r.id, r.displayName]));

  for (const { idx, runId } of missing) {
    const name = nameById.get(runId);
    if (name) sessions[idx].displayName = name;
  }

  return sessions;
}

export function setupTerminal(
  app: Hono,
  _upgradeWebSocket: unknown,
) {
  // Ensure the daemon is running — called by the frontend when it can't connect
  app.post("/api/terminal/ensure-daemon", async (c) => {
    const result = await ensureDaemonRunning();
    return c.json(result);
  });

  // Proxy all terminal HTTP API calls to the daemon
  app.all("/api/terminal/*", async (c) => {
    // Strip the /api/terminal prefix — daemon routes are at root level
    const suffix = c.req.path.replace(/^\/api\/terminal/, "") || "/";
    const search = new URL(c.req.raw.url).search;
    const url = `${DAEMON_URL}${suffix}${search}`;

    try {
      const res = await fetch(url, {
        method: c.req.method,
        headers: (() => {
          const h = new Headers();
          for (const [k, v] of Object.entries(c.req.raw.headers)) {
            if (k !== "host") h.set(k, v as string);
          }
          return h;
        })(),
        body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
        // @ts-expect-error Node fetch supports duplex
        duplex: "half",
        signal: AbortSignal.timeout(10_000),
      });

      // Enrich GET /sessions with display names from the DB
      if (c.req.method === "GET" && suffix === "/sessions" && res.ok) {
        try {
          const data = (await res.json()) as { sessions: { id: string; displayName?: string | null }[] };
          data.sessions = enrichSessionsWithDisplayNames(data.sessions);
          return c.json(data);
        } catch {
          // If JSON parse fails, return original response
        }
      }

      const resHeaders = new Headers(res.headers);
      resHeaders.delete("transfer-encoding");
      return new Response(res.body, { status: res.status, headers: resHeaders });
    } catch {
      return c.json({ error: "Terminal daemon unreachable — it may be starting up" }, 503);
    }
  });

  // Expose the daemon port so the frontend can build the direct WebSocket URL
  app.get("/api/terminal-daemon-port", (c) => c.json({ port: DAEMON_PORT }));
}

// Export the daemon port so the frontend can build the direct WS URL
export { DAEMON_PORT };
