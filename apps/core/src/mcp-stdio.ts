#!/usr/bin/env node
/**
 * Talome MCP stdio server.
 *
 * Claude Code launches this as a subprocess via .mcp.json — no HTTP server,
 * no token, no env vars required. Communication happens over stdin/stdout.
 *
 * The DB path defaults to ~/.talome/talome.db (same as the main server).
 * Docker access uses the same socket as the main server (/var/run/docker.sock).
 *
 * Trust model: the caller is the local owner (localStdioActor) — this process
 * already has the DB file and Docker socket, so per-token grants would not
 * constrain it. Security mode and approvals still apply to every call, and
 * every call is audited as actor "mcp_stdio" — or as agent_loop:remediation
 * when the agent loop launched Claude Code (TALOME_MCP_ACTOR).
 *
 * Nothing may be written to stdout except MCP frames — log to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpSession } from "./routes/mcp.js";
import { localStdioActor } from "./ai/execution.js";
import { runTrustMigrations } from "./db/migrations/trust.js";
import { runWireBackendMigrations } from "./db/migrations/wire-backend.js";
import { stdioActorFromEnv } from "./agent-loop/remediation-actor.js";
import { installStdioShutdown } from "./mcp-stdio-lifecycle.js";

/** How often to re-evaluate configured domains / disabled tools. */
const TOOL_SYNC_INTERVAL_MS = 15_000;

// The main server may be older than this process (or not running): make sure
// the trust tables/columns this process writes exist. Idempotent.
try {
  runTrustMigrations();
} catch (err) {
  process.stderr.write(`[mcp-stdio] trust migrations failed: ${err instanceof Error ? err.message : String(err)}\n`);
}
// Columns this process reads and writes (notifications.link, automations.actor_scopes, …).
try {
  runWireBackendMigrations();
} catch (err) {
  process.stderr.write(`[mcp-stdio] wire-backend migrations failed: ${err instanceof Error ? err.message : String(err)}\n`);
}

// Claude Code remediation (agent-loop/remediation.ts) launches this server
// with TALOME_MCP_ACTOR so its calls run as the agent loop, not the owner.
const session = createMcpSession(stdioActorFromEnv(process.env, localStdioActor()));
const transport = new StdioServerTransport();

let syncTimer: ReturnType<typeof setInterval> | undefined;

const lifecycle = installStdioShutdown({
  stdin: process.stdin,
  stdout: process.stdout,
  signals: process,
  getPpid: () => process.ppid,
  exit: (code) => process.exit(code),
  onShutdown: async () => {
    if (syncTimer) clearInterval(syncTimer);
    await session.server.close().catch(() => {});
  },
});

session.server.server.onclose = () => void lifecycle.shutdown("transport closed");

await session.server.connect(transport);

// Newly configured domains (or tools disabled in Settings) show up without a
// restart: the SDK emits notifications/tools/list_changed on every change.
syncTimer = setInterval(() => {
  try {
    const { added, removed } = session.sync();
    if (added.length || removed.length) {
      process.stderr.write(`[mcp-stdio] tools changed: +${added.length} -${removed.length}\n`);
    }
  } catch (err) {
    process.stderr.write(`[mcp-stdio] tool sync failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}, TOOL_SYNC_INTERVAL_MS);
syncTimer.unref();
