/**
 * API Routes — /api/setup/*
 *
 * Health score, setup runs, manual trigger, Claude Code delegation, SSE streaming, config.
 */

import { Hono } from "hono";
import { writeFile } from "node:fs/promises";
import { computeHealthScore } from "../setup/health-score.js";
import { startSetupRun, isSetupRunning, pauseSetup, getSetupRun, listSetupRuns } from "../setup/loop.js";
import { addSetupListener } from "../setup/setup-emitter.js";
import { getRecentAttempts } from "../setup/results-log.js";
import { getSetting } from "../utils/settings.js";
import { setSetting } from "../utils/settings.js";

const TERMINAL_DAEMON_PORT = Number(process.env.TERMINAL_DAEMON_PORT) || 4001;

export const setupRoutes = new Hono();

// ── Health score ────────────────────────────────────────────────────────────

setupRoutes.get("/health-score", async (c) => {
  const score = await computeHealthScore();
  return c.json(score);
});

// ── Runs ────────────────────────────────────────────────────────────────────

setupRoutes.get("/runs", (c) => {
  const limit = Number(c.req.query("limit")) || 20;
  return c.json(listSetupRuns(limit));
});

setupRoutes.get("/runs/:id", (c) => {
  const run = getSetupRun(c.req.param("id"));
  if (!run) return c.json({ error: "Run not found" }, 404);
  return c.json(run);
});

// ── Start / pause ───────────────────────────────────────────────────────────

setupRoutes.post("/start", async (c) => {
  if (isSetupRunning()) {
    return c.json({ error: "A setup run is already in progress" }, 409);
  }
  try {
    const runId = await startSetupRun("manual");
    return c.json({ runId, status: "started" });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed to start" }, 500);
  }
});

setupRoutes.post("/pause/:id", (c) => {
  pauseSetup(c.req.param("id"));
  return c.json({ status: "pause_requested" });
});

// ── Delegate to Claude Code ─────────────────────────────────────────────────

setupRoutes.post("/delegate", async (c) => {
  // Compute current health to build context
  const health = await computeHealthScore();

  const lines = [
    "# Server Setup — Configure Apps",
    "",
    "You are configuring a Talome home server. Use the available MCP tools to bring every app to 100% health.",
    "",
    `## Current Health Score: ${health.overall}%`,
    `${health.configured}/${health.total} apps fully configured.`,
    "",
  ];

  for (const app of health.apps) {
    if (app.score === 100) {
      lines.push(`- **${app.name}**: 100% OK`);
    } else {
      lines.push(`- **${app.name}**: ${app.score}% — ${app.issues.join(", ")}`);
    }
  }

  lines.push(
    "",
    "## Strategy",
    "",
    "For each app that needs attention:",
    "1. **Arr apps** (Sonarr, Radarr, Readarr, Prowlarr): Read `config/config.xml` via `read_app_config_file` to extract `<ApiKey>`, then `set_setting` for the key and URL, then `test_app_connectivity`",
    "2. **Jellyfin**: Use `jellyfin_create_api_key` to generate a key, set URL and key",
    "3. **qBittorrent**: Check container logs for temp password, or try default creds (admin/adminadmin)",
    "4. **Overseerr**: Check `/api/v1/status` — if initialized, extract API key; if not, set URL only",
    "5. **User-provided key apps** (Home Assistant, Audiobookshelf, Pi-hole, Vaultwarden): Set URL from container port, note that API key requires user action",
    "",
    "After configuring keys and URLs, use `wire_apps` to connect related services (e.g. Sonarr → qBittorrent, Sonarr → Prowlarr).",
    "",
    "Work through apps in dependency order: Prowlarr → qBittorrent → Jellyfin → Sonarr/Radarr/Readarr → Overseerr.",
    "After each change, use `test_app_connectivity` to verify it worked.",
  );

  const taskPrompt = lines.join("\n");
  const sessionName = "setup-configure";
  const promptFile = "/tmp/talome-prompt-setup.md";

  await writeFile(promptFile, taskPrompt, "utf-8");

  // Create terminal session via daemon
  try {
    await fetch(`http://127.0.0.1:${TERMINAL_DAEMON_PORT}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: sessionName }),
    });
  } catch {
    // Daemon may not be running — frontend handles gracefully
  }

  const command = `cd "${process.cwd()}" && env -u ANTHROPIC_API_KEY claude --dangerously-skip-permissions "$(cat ${promptFile})"`;

  return c.json({
    sessionName: `sess_${sessionName}`,
    command,
    taskPrompt,
  });
});

// ── Recent attempts ─────────────────────────────────────────────────────────

setupRoutes.get("/attempts", (c) => {
  const limit = Number(c.req.query("limit")) || 20;
  return c.json(getRecentAttempts(limit));
});

// ── SSE stream ──────────────────────────────────────────────────────────────

setupRoutes.get("/stream", (c) => {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: string) => {
        try { controller.enqueue(encoder.encode(`data: ${data}\n\n`)); } catch { /* closed */ }
      };

      // Send initial state
      send(JSON.stringify({ type: "connected", running: isSetupRunning() }));

      const unsubscribe = addSetupListener((event) => {
        send(JSON.stringify(event));
      });

      // Clean up when client disconnects — the stream will error on enqueue
      // and the catch above silently swallows it. We rely on the browser
      // closing the connection to trigger cleanup via the cancel callback.
      return () => unsubscribe();
    },
    cancel() {
      // Listener cleanup is handled in start's return
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// ── Config ──────────────────────────────────────────────────────────────────

setupRoutes.get("/config", (c) => {
  const autoConfigureRaw = getSetting("setup_auto_configure");
  const excludedRaw = getSetting("setup_excluded_apps");
  return c.json({
    autoConfigureEnabled: autoConfigureRaw === "true" || autoConfigureRaw === "1",
    excludedApps: excludedRaw ? JSON.parse(excludedRaw) as string[] : [],
  });
});

setupRoutes.put("/config", async (c) => {
  const body = await c.req.json<{
    autoConfigureEnabled?: boolean;
    excludedApps?: string[];
  }>();

  if (body.autoConfigureEnabled !== undefined) {
    setSetting("setup_auto_configure", body.autoConfigureEnabled ? "true" : "false");
  }
  if (body.excludedApps !== undefined) {
    setSetting("setup_excluded_apps", JSON.stringify(body.excludedApps));
  }

  return c.json({ status: "ok" });
});
