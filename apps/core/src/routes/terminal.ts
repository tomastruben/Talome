/**
 * Terminal route — thin HTTP proxy to the terminal daemon on :4001.
 *
 * The terminal daemon (terminal-daemon.ts) runs as a separate process that
 * survives tsx watch restarts. All PTY session logic lives there.
 *
 * This route:
 *  - Requires a logged-in admin for every /api/terminal/* request
 *  - Forwards all /api/terminal/* HTTP requests to the daemon
 *  - Exposes the daemon port so the frontend can connect WebSocket directly
 *
 * WebSocket connections go directly from the browser to the daemon port
 * (no WS proxy needed — avoids bidirectional pipe complexity).
 */

import type { Hono, MiddlewareHandler } from "hono";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { createHash } from "node:crypto";
import { db, schema } from "../db/index.js";
import { DAEMON_PORT } from "../terminal-constants.js";
import { ensureDaemonRunning } from "../terminal-spawn.js";
import { getSetting } from "../utils/settings.js";
import { TERMINAL_USER_HEADER } from "../terminal-user-binding.js";

const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

/**
 * Shared secret with the terminal daemon. The daemon now requires this
 * header on its protected HTTP routes so a random local process can't
 * mint PTY tokens or list sessions just because it can reach
 * 127.0.0.1:4001. Derived deterministically from TALOME_SECRET so both
 * processes agree without any coordination — they share the .env.
 */
const DAEMON_INTERNAL_KEY = (() => {
  const secret = process.env.TALOME_SECRET;
  if (!secret) return null;
  return createHash("sha256").update(secret + ":daemon-internal").digest("hex");
})();

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

/**
 * A terminal is an unrestricted host shell, and this proxy adds the daemon's
 * internal key to every request — so everything under /api/terminal/* needs
 * a logged-in admin (requireSession sets the role; a request that skipped it
 * has none and is refused). Minting a PTY token is also refused while the
 * security mode is "locked", matching the daemon's rule for MCP tokens.
 */
export const requireTerminalAdmin: MiddlewareHandler = async (c, next) => {
  const user = c.get("sessionUser" as never) as string | undefined;
  if (!user) return c.json({ error: "Unauthorized — please log in" }, 401);
  const role = c.get("sessionRole" as never) as string | undefined;
  if (role !== "admin") return c.json({ error: "Forbidden — the terminal requires an admin account" }, 403);
  if (c.req.method === "POST" && c.req.path === "/api/terminal/session" && getSetting("security_mode") === "locked") {
    return c.json(
      { error: 'The terminal is disabled while the security mode is "locked". An admin can change it in Settings -> Security.' },
      423,
    );
  }
  await next();
};

export function setupTerminal(
  app: Hono,
  _upgradeWebSocket: unknown,
) {
  // Every terminal HTTP route (including ensure-daemon) is admin-only.
  app.use("/api/terminal/*", requireTerminalAdmin);

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

    if (c.req.method === "PATCH" && /^\/sessions\/[^/]+$/.test(suffix)) {
      const body = await c.req.raw.clone().json().catch(() => null);
      const parsed = z.object({ displayName: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/) }).strict().safeParse(body);
      if (!parsed.success) return c.json({ error: "Use a session name between 1 and 80 characters, without control characters." }, 400);
    }

    try {
      const res = await fetch(url, {
        method: c.req.method,
        headers: (() => {
          const h = new Headers();
          // Preserve body metadata, especially the multipart upload boundary.
          // Credentials and daemon identity are supplied by this admin proxy.
          for (const name of ["content-type", "content-length"]) {
            const value = c.req.header(name);
            if (value) h.set(name, value);
          }
          if (DAEMON_INTERNAL_KEY) h.set("x-daemon-auth", DAEMON_INTERNAL_KEY);
          // Who is asking: the daemon binds a new terminal to this admin and
          // closes it when they lose access. Never taken from the client.
          h.set(TERMINAL_USER_HEADER, c.get("sessionUser" as never) as string);
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
