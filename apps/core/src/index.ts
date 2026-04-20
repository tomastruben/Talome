import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
import { sql } from "drizzle-orm";
import { system } from "./routes/system.js";
import { containers } from "./routes/containers.js";
import { statsStream } from "./routes/stats-stream.js";
import { apps } from "./routes/apps.js";
import { stores } from "./routes/stores.js";
import { chat } from "./routes/chat.js";
import { auditLog } from "./routes/audit-log.js";
import { settings } from "./routes/settings.js";
import { media } from "./routes/media.js";
import { metrics as metricsRoute } from "./routes/metrics.js";
import { conversations } from "./routes/conversations.js";
import { userApps } from "./routes/user-apps.js";
import { notifications } from "./routes/notifications.js";
import { notificationChannels } from "./routes/notification-channels.js";
import { memories } from "./routes/memories.js";
import { integrations } from "./routes/integrations.js";
import { mcp } from "./routes/mcp.js";
import { setupTerminal } from "./routes/terminal.js";
import { automations } from "./routes/automations.js";
import { auth } from "./routes/auth.js";
import { users } from "./routes/users.js";
import { stacks } from "./routes/stacks.js";
import { creator } from "./routes/creator.js";
import { evolution } from "./routes/evolution.js";
import { setupRoutes } from "./routes/setup.js";
import { agentLoop as agentLoopRoute } from "./routes/agent-loop.js";
import { tools as toolsRoute } from "./routes/tools.js";
import { widgets } from "./routes/widgets.js";
import { community } from "./routes/community.js";
import { proxy } from "./routes/proxy.js";
import { mdns as mdnsRoute } from "./routes/mdns.js";
import { webhooks } from "./routes/webhooks.js";
import { backups as backupsRoute } from "./routes/backups.js";
import { updates as updatesRoute } from "./routes/updates.js";
import { ollama as ollamaRoute } from "./routes/ollama.js";
import { aiModels as aiModelsRoute } from "./routes/ai-models.js";
import { push as pushRoute } from "./routes/push.js";
import { storage as storageRoute } from "./routes/storage.js";
import { services as servicesRoute } from "./routes/services.js";
import { files as filesRoute, cleanupStaleHlsOnStartup, cleanupStaleTransmuxOnStartup } from "./routes/files.js";
import { optimization as optimizationRoute } from "./routes/optimization.js";
import { startAutoOptimize } from "./media/optimizer.js";
import { startSelfBackup, stopSelfBackup, snapshotNow } from "./services/self-backup.js";
import { audiobooks as audiobooksRoute } from "./routes/audiobooks.js";
import { audible as audibleRoute } from "./routes/audible.js";
import { suggestions as suggestionsRoute } from "./routes/suggestions.js";
import { health as healthRoute } from "./routes/health.js";
import { diagnostics as diagnosticsRoute } from "./routes/diagnostics.js";
import { search as searchRoute } from "./routes/search.js";
import { supervisor as supervisorRoute } from "./routes/supervisor.js";
import { startAutomationCron, stopAutomationCron } from "./automation/cron.js";
import { startMonitor } from "./monitor.js";
import { startAgentLoop } from "./agent-loop/index.js";
import { startDigestScheduler } from "./digest.js";
import { startActivitySummaryScheduler, stopActivitySummaryScheduler } from "./activity-summary.js";
import { runMigrations } from "./db/migrate.js";
import { initializeStores } from "./stores/sync.js";
import { migrateLegacyNetworks } from "./stores/lifecycle.js";
import { db, schema } from "./db/index.js";
import { eq } from "drizzle-orm";
import { startTelegramBot } from "./messaging/telegram.js";
// discord-bot.js is imported dynamically below to avoid loading discord.js at startup
import { checkDockerConnection, startPeriodicPrune } from "./docker/client.js";
import { safeRoute, rateLimit, requireSession, requireRole, requirePermission, requestLogger } from "./middleware/index.js";
import { errorTracker } from "./middleware/error-tracker.js";
import { getRequestId, getRequestStart } from "./middleware/request-logger.js";
import { randomUUID } from "node:crypto";
import { loadCustomTools } from "./ai/custom-tools.js";
import { migrateSettingsEncryption } from "./utils/crypto.js";
import { enableLocalDomains } from "./proxy/local-domains.js";
import { registerShutdownHandler } from "./evolution-restart.js";
import { network } from "./routes/network.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { DAEMON_PORT } from "./terminal-constants.js";
import { isDaemonAlive, spawnDaemon, ensureDaemonRunning } from "./terminal-spawn.js";
import { createLogger } from "./utils/logger.js";

const startupLog = createLogger("startup");
const shutdownLog = createLogger("shutdown");
const daemonLog = createLogger("terminal-daemon");
const errorLog = createLogger("error");

// ── Fatal startup ─────────────────────────────────────────────────────────────
// If migrations or store init fail the schema may be stale — don't serve.
try {
  runMigrations();
} catch (err) {
  startupLog.error("runMigrations failed — cannot start safely", err);
  process.exit(1);
}

// ── Legacy migration: talon → talome in DB paths ─────────────────────────────
// Covers all tables that may contain /.talon/ paths or talon.local domains.
try {
  let totalChanges = 0;

  // store_sources.local_path
  totalChanges += db.run(
    sql`UPDATE store_sources SET local_path = REPLACE(local_path, '/.talon/', '/.talome/') WHERE local_path LIKE '%/.talon/%'`
  ).changes;

  // installed_apps.override_compose_path
  totalChanges += db.run(
    sql`UPDATE installed_apps SET override_compose_path = REPLACE(override_compose_path, '/.talon/', '/.talome/') WHERE override_compose_path LIKE '%/.talon/%'`
  ).changes;

  // proxy_routes: domains and identifiers
  totalChanges += db.run(
    sql`UPDATE proxy_routes SET domain = REPLACE(domain, 'talon.local', 'talome.local') WHERE domain LIKE '%talon.local%'`
  ).changes;
  totalChanges += db.run(
    sql`UPDATE proxy_routes SET app_id = '__talome__' WHERE app_id = '__talon__'`
  ).changes;
  totalChanges += db.run(
    sql`UPDATE proxy_routes SET app_id = REPLACE(app_id, 'talon-', 'talome-') WHERE app_id LIKE 'talon-%'`
  ).changes;
  totalChanges += db.run(
    sql`UPDATE proxy_routes SET upstream = REPLACE(upstream, 'talon-', 'talome-') WHERE upstream LIKE '%talon-%'`
  ).changes;

  // settings: domain names and paths
  totalChanges += db.run(
    sql`UPDATE settings SET value = REPLACE(value, 'talon.local', 'talome.local') WHERE value LIKE '%talon.local%'`
  ).changes;
  totalChanges += db.run(
    sql`UPDATE settings SET value = REPLACE(value, 'TalonHLS', 'TalomeHLS') WHERE value LIKE '%TalonHLS%'`
  ).changes;

  // backups.file_path
  totalChanges += db.run(
    sql`UPDATE backups SET file_path = REPLACE(file_path, '/.talon/', '/.talome/') WHERE file_path LIKE '%/.talon/%'`
  ).changes;

  if (totalChanges > 0) {
    startupLog.info(`Legacy migration: updated ${totalChanges} DB record(s) talon → talome`);
  }
} catch {
  // Non-fatal — tables may not exist yet on first boot
}

// ── Secret key check ───────────────────────────────────────────────────────
if (!process.env.TALOME_SECRET) {
  if (process.env.NODE_ENV === "production") {
    // Auto-generate and persist a secret so encryption always works in production
    const dbPath = process.env.DATABASE_PATH || "./data/talome.db";
    const dataDir = dirname(resolve(dbPath));
    const secretPath = resolve(dataDir, "talome.secret");

    // Migrate legacy talon.secret → talome.secret
    const legacySecretPath = resolve(dataDir, "talon.secret");
    if (!existsSync(secretPath) && existsSync(legacySecretPath)) {
      try {
        renameSync(legacySecretPath, secretPath);
        startupLog.info(`Renamed ${legacySecretPath} → ${secretPath}`);
      } catch { /* non-fatal — will regenerate below */ }
    }

    try {
      if (existsSync(secretPath)) {
        process.env.TALOME_SECRET = readFileSync(secretPath, "utf-8").trim();
        startupLog.info("Loaded TALOME_SECRET from persisted file");
      } else {
        const generated = randomBytes(32).toString("hex"); // 64-char hex string
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(secretPath, generated, { mode: 0o600 });
        process.env.TALOME_SECRET = generated;
        startupLog.info(`TALOME_SECRET was not set — auto-generated and persisted to ${secretPath}`);
      }
    } catch (err) {
      startupLog.error("Failed to auto-generate TALOME_SECRET", err);
      process.exit(1);
    }
  } else {
    startupLog.warn(
      "TALOME_SECRET is not set. API keys and tokens will be stored in PLAINTEXT. " +
      "Set TALOME_SECRET to a 64-char hex string for encrypted storage."
    );
  }
}

// ── Reconcile interrupted evolution runs ──────────────────────────────────────
// Any run left in "running" status means the previous server process died mid-run.
// Mark them as "interrupted" so history is accurate and the UI doesn't show a stuck spinner.
try {
  const interrupted = db.run(
    sql`UPDATE evolution_runs SET status = 'interrupted', completed_at = datetime('now') WHERE status = 'running'`
  );
  if (interrupted.changes > 0) {
    startupLog.info(`Marked ${interrupted.changes} interrupted evolution run(s)`);
  }
} catch {
  // Non-fatal — schema may not exist yet on first boot (migration handles it)
}

try {
  initializeStores();
} catch (err) {
  startupLog.error("initializeStores failed", err);
  process.exit(1);
}

// ── Migrate legacy networks → unified `talome` bridge (non-fatal) ─────────────
migrateLegacyNetworks().catch((err) =>
  startupLog.error("migrateLegacyNetworks failed", err)
);

// ── Load custom AI tools (non-fatal) ──────────────────────────────────────────
loadCustomTools()
  .then((tools) => {
    const names = Object.keys(tools);
    if (names.length > 0) startupLog.info(`Custom tools loaded: ${names.join(", ")}`);
  })
  .catch((err) => startupLog.warn("Custom tools load failed", err));

// ── Migrate settings encryption (non-fatal) ───────────────────────────────────
migrateSettingsEncryption().catch((err) =>
  startupLog.error("migrateSettingsEncryption failed", err)
);

// ── App setup ─────────────────────────────────────────────────────────────────
const app = new Hono();

const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
// Safari's NSURLSession assumes permessage-deflate is active even when the server
// rejects it, corrupting all frames. Enable it so Safari works correctly.
wss.options.perMessageDeflate = {};

/**
 * Origin allowlist — shared by CORS and CSRF middleware.
 *
 * Talome is self-hosted on a user's own machine / LAN. Accept:
 *   1. Explicit allowlist via DASHBOARD_ORIGIN env (comma-separated)
 *   2. Loopback (localhost, 127.0.0.1, ::1) on any port
 *   3. RFC1918 private ranges on any port (home LAN)
 *   4. Tailscale 100.64.0.0/10 on any port
 *   5. Link-local IPv6 fe80::/10
 *   6. mDNS *.local hostnames
 *
 * Public hostnames must be opted in via DASHBOARD_ORIGIN. This prevents
 * a malicious page on a random *.com domain from driving the API even if
 * the user exposes Talome behind a reverse proxy. In dev mode we still
 * accept any origin for convenience.
 */
function isTrustedOrigin(origin: string): boolean {
  if (process.env.NODE_ENV !== "production") return true;

  const explicit = (process.env.DASHBOARD_ORIGIN || "http://localhost:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (explicit.includes(origin)) return true;

  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();

    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if (/^10\./.test(host)) return true;                          // 10/8
    if (/^192\.168\./.test(host)) return true;                    // 192.168/16
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;     // 172.16/12
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true; // 100.64/10 (Tailscale/CGNAT)
    if (/^fe80:/i.test(host)) return true;                        // IPv6 link-local
    if (host.endsWith(".local")) return true;                     // mDNS
  } catch {
    /* invalid origin — reject */
  }
  return false;
}

app.use(
  "*",
  cors({
    origin: (origin) => {
      // No Origin header: same-origin, server-to-server, or curl. Permit.
      if (!origin) return "*";
      return isTrustedOrigin(origin) ? origin : null;
    },
    credentials: true,
  }),
);

/**
 * CSRF protection — belt-and-suspenders on top of SameSite=Lax cookies
 * and the CORS allowlist above. Rejects state-changing requests whose
 * Origin header isn't trusted. Same-origin and no-Origin requests pass.
 * Webhook endpoints skip this (they're validated via HMAC elsewhere).
 */
app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api/webhooks/")) return next();
  return csrf({
    origin: (origin) => isTrustedOrigin(origin),
  })(c, next);
});

app.use("*", safeRoute);
app.use("/api/*", requestLogger);

// ── Security headers ──────────────────────────────────────────────────────────
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-XSS-Protection", "0");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: *; " +
    "connect-src 'self' *; " +
    "font-src 'self' data:; " +
    "frame-src 'self'; " +
    "media-src 'self' blob: *",
  );
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production") {
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
});

// ── Request body size limit (5 MB for JSON APIs) ─────────────────────────────
app.use("/api/*", async (c, next) => {
  const contentLength = parseInt(c.req.header("content-length") || "0", 10);
  if (contentLength > 5 * 1024 * 1024) {
    return c.json({ error: "Request body too large" }, 413);
  }
  await next();
});

// ── Session auth (guards all /api/* except health + auth + mcp + terminal) ───
app.use("/api/*", requireSession);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api/health", async (c) => {
  const checks: Record<string, "ok" | "error"> = {};

  // DB probe — if this fails the server genuinely can't serve data
  try {
    db.get(sql`SELECT 1`);
    checks.db = "ok";
  } catch {
    checks.db = "error";
  }

  // Docker probe — informational only; Docker being slow/unavailable does not
  // make the server "unreachable". We report the status but never return 503
  // solely because Docker is down, so the dashboard doesn't show a false alarm.
  try {
    const dockerHealth = await Promise.race([
      checkDockerConnection(),
      new Promise<{ ok: false; error: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, error: "timeout" }), 3000),
      ),
    ]);
    checks.docker = dockerHealth.ok ? "ok" : "error";
  } catch {
    checks.docker = "error";
  }

  // Only the DB check gates the overall status — Docker degradation is surfaced
  // in the checks object but does not flip the server to "degraded".
  const healthy = checks.db === "ok";
  return c.json(
    { status: healthy ? "ok" : "degraded", checks, uptime: process.uptime(), timestamp: new Date().toISOString() },
    healthy ? 200 : 503,
  );
});

// ── Admin-only route guards ──────────────────────────────────────────────────
app.use("/api/users/*", requireRole("admin"));
app.use("/api/settings/*", requireRole("admin"));
app.use("/api/evolution/*", requireRole("admin"));
app.use("/api/stores/*", requireRole("admin"));

// ── Feature-level permission guards ─────────────────────────────────────────
app.use("/api/media/*", requirePermission("media"));
app.use("/api/audiobooks/*", requirePermission("audiobooks"));
app.use("/api/files/*", requirePermission("files"));
app.use("/api/automations/*", requirePermission("automations"));
app.use("/api/apps/*", requirePermission("apps"));
app.use("/api/chat/*", requirePermission("chat"));

// ── Routes ────────────────────────────────────────────────────────────────────
app.route("/api/auth", auth);
app.route("/api/users", users);
app.route("/api/system", system);
app.route("/api/containers", containers);
app.route("/api/stats/stream", statsStream);
app.route("/api/apps", apps);
app.route("/api/stores", stores);

// Rate-limit the AI chat route: 20 requests per 60 seconds per IP
app.use("/api/chat/*", rateLimit(20, 60_000));
app.route("/api/chat", chat);

// Rate-limit auth endpoints: 10 requests per 60 seconds per IP (brute-force protection)
app.use("/api/auth/*", rateLimit(10, 60_000));
// Rate-limit webhook endpoints: 30 requests per 60 seconds per IP
app.use("/api/webhooks/*", rateLimit(30, 60_000));

app.route("/api/audit-log", auditLog);
app.route("/api/settings", settings);
app.route("/api/media", media);
app.route("/api/metrics", metricsRoute);
app.route("/api/conversations", conversations);
app.route("/api/user-apps", userApps);
app.route("/api/notifications", notifications);
app.route("/api/notification-channels", notificationChannels);
app.route("/api/memories", memories);
app.route("/api/suggestions", suggestionsRoute);
app.route("/api/integrations", integrations);
app.route("/api/widgets", widgets);
app.route("/api/community", community);
app.route("/api/proxy", proxy);
app.route("/api/mdns", mdnsRoute);
app.route("/api/network", network);
app.route("/api/backups", backupsRoute);
app.route("/api/updates", updatesRoute);
app.route("/api/webhooks", webhooks);
app.route("/api/ollama", ollamaRoute);
app.route("/api/ai", aiModelsRoute);
app.route("/api/push", pushRoute);
app.route("/api/storage", storageRoute);
app.route("/api/services", servicesRoute);
app.route("/api/health", healthRoute);
app.route("/api/diagnostics", diagnosticsRoute);
app.route("/api/files", filesRoute);
app.route("/api/optimization", optimizationRoute);
app.route("/api/audiobooks", audiobooksRoute);
app.route("/api/audible", audibleRoute);
app.route("/api/search", searchRoute);
app.route("/api/supervisor", supervisorRoute);

// Rate-limit MCP endpoint: 60 requests per 60 seconds per IP
app.use("/api/mcp/*", rateLimit(60, 60_000));
app.route("/api/mcp", mcp);

// Terminal WebSocket — auth handled inside setupTerminal via bearerAuth
setupTerminal(app, upgradeWebSocket);

app.route("/api/automations", automations);
  app.route("/api/stacks", stacks);
  app.route("/api/apps", creator);
  app.route("/api/evolution", evolution);
  app.route("/api/setup", setupRoutes);
  app.route("/api/agent-loop", agentLoopRoute);
  app.route("/api/tools", toolsRoute);

// ── Global error handler ──────────────────────────────────────────────────────
app.onError((err, c) => {
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
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

// ── Process error handlers ─────────────────────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  // Don't exit — background tasks (Telegram, digest) can have unhandled rejections
  // without corrupting the server. Log with full context.
  errorLog.error("Unhandled rejection", reason);
});

process.on("uncaughtException", (err) => {
  // A synchronous uncaught exception means the process is in an unknown state.
  // Exit and let the process manager (Docker, systemd) restart cleanly.
  errorLog.error("Fatal uncaughtException", err);
  process.exit(1);
});

// ── Terminal daemon auto-spawn ────────────────────────────────────────────────
// When running under the supervisor (TALOME_SUPERVISED=1), daemon lifecycle is
// managed externally. Otherwise, the main server handles it directly.

// isDaemonAlive, spawnDaemon, ensureDaemonRunning imported from terminal-spawn.ts

if (process.env.TALOME_SUPERVISED !== "1") {
  // Self-managed mode: spawn and health-check the daemon
  if (!isDaemonAlive()) {
    spawnDaemon();
  } else {
    daemonLog.info("Already running (found via PID file)");
  }

  // Health check — respawn daemon if it becomes unresponsive
  let daemonHealthFailures = 0;
  setInterval(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) daemonHealthFailures = 0;
      else daemonHealthFailures++;
    } catch {
      daemonHealthFailures++;
    }
    if (daemonHealthFailures >= 3 && !isDaemonAlive()) {
      daemonLog.warn("Health check failed — respawning");
      spawnDaemon();
      daemonHealthFailures = 0;
    }
  }, 30_000).unref();
} else {
  daemonLog.info("Managed by supervisor — skipping self-management");
}

// ── Server ────────────────────────────────────────────────────────────────────
const port = Number(process.env.CORE_PORT) || 4000;

let stopMonitor: (() => void) | undefined;
let stopAgentLoop: (() => void) | undefined;
let stopPrune: (() => void) | undefined;

const server = serve({ fetch: app.fetch, hostname: "::", port }, (info) => {
  startupLog.info(`Talome Core running on http://0.0.0.0:${info.port}`);

  injectWebSocket(server);

  try {
    stopMonitor = startMonitor();
  } catch (err) {
    startupLog.error("startMonitor failed", err);
  }

  try {
    stopAgentLoop = startAgentLoop();
  } catch (err) {
    startupLog.error("startAgentLoop failed", err);
  }

  // Clean up stale HLS + transmux cache from previous server run
  void cleanupStaleHlsOnStartup();
  void cleanupStaleTransmuxOnStartup();

  try {
    startAutomationCron();
  } catch (err) {
    startupLog.error("startAutomationCron failed", err);
  }

  // Start auto-optimize if enabled
  try { startAutoOptimize(); } catch { /* non-fatal */ }

  // Start periodic Docker prune (daily cleanup of stopped containers + dangling images)
  try { stopPrune = startPeriodicPrune(); } catch { /* non-fatal */ }

  // Periodic self-snapshots of talome.db so users can recover from a
  // volume-corruption / rm incident. Silent no-op if disabled via env.
  try { startSelfBackup(); } catch { /* non-fatal */ }

  try {
    startDigestScheduler();
  } catch (err) {
    startupLog.error("startDigestScheduler failed", err);
  }

  try {
    startActivitySummaryScheduler();
  } catch (err) {
    startupLog.error("startActivitySummaryScheduler failed", err);
  }

  try {
    const tokenRow = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "telegram_bot_token"))
      .get();
    if (tokenRow?.value) {
      startTelegramBot(tokenRow.value).then((result) => {
        if (!result.ok) {
          startupLog.error("Telegram bot failed to start", result.error);
        }
      });
    }
  } catch (err) {
    startupLog.error("startTelegramBot failed", err);
  }

  // Auto-start local domains (CoreDNS + Caddy + Avahi) if enabled
  try {
    const localDomainsRow = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "local_domains_enabled"))
      .get();
    // Also check legacy mdns_enabled for backward compat
    const mdnsRow = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "mdns_enabled"))
      .get();
    if (localDomainsRow?.value === "true" || mdnsRow?.value === "true") {
      const baseDomain = db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, "local_domains_base"))
        .get()?.value
        || db.select().from(schema.settings).where(eq(schema.settings.key, "mdns_base_domain")).get()?.value
        || "talome.local";
      enableLocalDomains(baseDomain)
        .then((result) => {
          if (result.ok) startupLog.info(`Local domains active — ${result.proxyRoutes.length} route(s)`);
          else startupLog.error("Local domains failed", result.error);
        })
        .catch((err: unknown) => startupLog.error("Local domains failed", err));
    }
  } catch (err) {
    startupLog.error("Local domains check failed", err);
  }

  // Auto-start Discord bot if token is saved (lazy-load discord.js)
  try {
    const discordRow = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "discord_bot_token"))
      .get();
    if (discordRow?.value) {
      import("./messaging/discord-bot.js").then(({ startDiscordBot }) => {
        startDiscordBot(discordRow.value).then((result: { ok: boolean; error?: string }) => {
          if (!result.ok) {
            startupLog.error("Discord bot failed to start", result.error);
          }
        });
      }).catch((err: unknown) => {
        startupLog.error("Failed to load discord-bot module", err);
      });
    }
  } catch (err) {
    startupLog.error("startDiscordBot failed", err);
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    startupLog.error(`Port ${port} is already in use. Stop the other core process and restart.`);
    return;
  }
  startupLog.error("HTTP server error", err);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function gracefulShutdown(signal: string, exitCode = 0): Promise<void> {
  shutdownLog.info(`${signal} received — draining connections`);

  // Hard-kill after 10 seconds in case drain hangs
  const hardKill = setTimeout(() => {
    shutdownLog.error("Hard kill after 10s timeout");
    process.exit(1);
  }, 10_000);
  hardKill.unref();

  server.close(async () => {
    stopMonitor?.();
    stopAgentLoop?.();
    stopPrune?.();
    stopSelfBackup();
    stopAutomationCron();
    // Kill terminal daemon via PID file
    try {
      const pidFile = join(homedir(), ".talome", "terminal-daemon.pid");
      const pid = Number(readFileSync(pidFile, "utf-8").trim());
      if (pid) process.kill(pid, "SIGTERM");
    } catch { /* daemon already dead or PID file missing */ }
    stopActivitySummaryScheduler();

    // Close the SQLite connection to release WAL locks
    try {
      (db.$client as { close?: () => void }).close?.();
    } catch {
      // best-effort
    }

    shutdownLog.info("Clean exit");
    process.exit(exitCode);
  });

  // Give in-flight requests 5 seconds to complete, then force-close
  setTimeout(() => {
    // closeAllConnections exists on Node http.Server (18.2+) but isn't typed on @hono/node-server's ServerType
    const srv = server as unknown as { closeAllConnections?: () => void };
    srv.closeAllConnections?.();
  }, 5_000);
}

// Register the shutdown handler so evolution-restart.ts can trigger graceful restarts
// without a circular import back to index.ts.
registerShutdownHandler(gracefulShutdown);

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => void gracefulShutdown("SIGINT"));
