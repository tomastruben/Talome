import { Hono } from "hono";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { db, schema } from "../db/index.js";
import { desc } from "drizzle-orm";
import { serverError } from "../middleware/request-logger.js";

const TALOME_DIR = join(homedir(), ".talome");

const supervisor = new Hono();

supervisor.get("/status", (c) => {
  try {
    const data = readFileSync(join(TALOME_DIR, "supervisor-state.json"), "utf-8");
    return c.json(JSON.parse(data));
  } catch {
    return c.json({ error: "Supervisor not running" }, 404);
  }
});

supervisor.get("/events", (c) => {
  try {
    const events = db.select().from(schema.supervisorEvents)
      .orderBy(desc(schema.supervisorEvents.createdAt)).limit(50).all();
    return c.json(events);
  } catch {
    return c.json([]);
  }
});

supervisor.get("/mode", (c) => {
  try {
    let mode = "build";
    try {
      const m = readFileSync(join(TALOME_DIR, "server-mode"), "utf-8").trim();
      if (m === "dev" || m === "build") mode = m;
    } catch { /* default */ }
    const active = process.env.TSX === "1" ? "dev" : "build";
    const managed = process.env.TALOME_MANAGED === "1";
    return c.json({ mode, active, managed });
  } catch {
    return c.json({ mode: "build", active: "build", managed: false });
  }
});

supervisor.post("/mode", async (c) => {
  const body = await c.req.json<{ mode: string }>();
  if (body.mode !== "dev" && body.mode !== "build") {
    return c.json({ error: "Invalid mode" }, 400);
  }
  writeFileSync(join(TALOME_DIR, "server-mode"), body.mode, "utf-8");
  try {
    const pid = parseInt(readFileSync(join(TALOME_DIR, "supervisor.pid"), "utf-8").trim(), 10);
    process.kill(pid, "SIGUSR1");
    return c.json({ ok: true, mode: body.mode });
  } catch {
    return c.json({ ok: true, mode: body.mode, message: "Restart supervisor to apply" });
  }
});

// POST /api/supervisor/restart — restart one or all services
supervisor.post("/restart", async (c) => {
  const body = await c.req.json<{ service?: string }>().catch(() => ({ service: undefined }));
  const service = body.service;

  try {
    const stateJson = readFileSync(join(TALOME_DIR, "supervisor-state.json"), "utf-8");
    const state = JSON.parse(stateJson) as {
      processes: Record<string, { pid: number | null; status: string }>;
    };

    if (service && service !== "core") {
      // Restart a specific non-core service by killing it — supervisor respawns
      const proc = state.processes[service];
      if (!proc?.pid) return c.json({ error: `${service} not running` }, 404);
      process.kill(proc.pid, "SIGKILL");
      return c.json({ ok: true, restarted: service });
    }

    if (service === "core") {
      // Kill the core process so the supervisor detects the exit and respawns.
      // process.exit(0) doesn't work in tsx watch mode (tsx catches it internally).
      const corePid = state.processes.core?.pid;
      if (corePid) {
        setTimeout(() => { try { process.kill(corePid, "SIGKILL"); } catch {} }, 100);
      } else {
        setTimeout(() => process.exit(1), 100);
      }
      return c.json({ ok: true, restarted: "core" });
    }

    // Restart all — kill all services, supervisor respawns them
    for (const [, proc] of Object.entries(state.processes)) {
      if (proc.pid) {
        try { process.kill(proc.pid, "SIGKILL"); } catch { /* already dead */ }
      }
    }
    return c.json({ ok: true, restarted: "all" });
  } catch (err) {
    return serverError(c, err, { message: "Supervisor not running" });
  }
});

export { supervisor };
