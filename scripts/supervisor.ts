#!/usr/bin/env tsx
/**
 * Talome Process Supervisor
 *
 * Unified process manager for core, dashboard, and terminal daemon.
 * Replaces start-core.sh + watchdog.ts with a single TypeScript entry point.
 *
 * Features:
 * - Health-check based monitoring for all 3 processes
 * - Graduated escalation: restart → AI diagnosis → evolution revert → stop
 * - Known-good state tagging via git tags
 * - Works in both dev (tsx watch) and build (compiled node) modes
 * - Works in Docker (no git) and bare metal (git-based revert)
 *
 * Usage:
 *   tsx scripts/supervisor.ts [--mode=dev|build]
 *   node scripts/supervisor.js
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  type ProcessConfig,
  type ProcessName,
  type ProcessState,
  type SupervisorConfig,
  type SupervisorStateSnapshot,
  DEFAULT_SUPERVISOR_CONFIG,
} from "../apps/core/src/supervisor/types.js";
import {
  initEventLog,
  closeEventLog,
  logSupervisorEvent,
  writeNotificationDirect,
  findRecentEvolutionRun,
  markEvolutionRunRolledBack,
  getDiagnosisCountToday,
  pruneOldEvents,
} from "../apps/core/src/supervisor/event-log.js";
import { collectDiagnostics } from "../apps/core/src/supervisor/diagnostics.js";
import { diagnoseProcessCrash } from "../apps/core/src/supervisor/ai-diagnosis.js";
import {
  isGitAvailable,
  recordKnownGood,
  getLastKnownGood,
  revertToKnownGood,
  stashUncommittedChanges,
} from "../apps/core/src/supervisor/known-good.js";

// ── Constants ────────────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const CORE_DIR = join(PROJECT_ROOT, "apps", "core");
const DASHBOARD_DIR = join(PROJECT_ROOT, "apps", "dashboard");
const TALOME_DIR = join(homedir(), ".talome");
const PID_FILE = join(TALOME_DIR, "supervisor.pid");
const STATE_FILE = join(TALOME_DIR, "supervisor-state.json");
const MODE_FILE = join(TALOME_DIR, "server-mode");
const DB_PATH = process.env.DATABASE_PATH || join(CORE_DIR, "data", "talome.db");

const DAEMON_PORT = Number(process.env.TERMINAL_DAEMON_PORT) || 4001;
const CORE_PORT = Number(process.env.CORE_PORT) || 4000;
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT) || 3000;

const EXIT_EVOLUTION_RESTART = 75;
const LOG_BUFFER_SIZE = 200;

const config: SupervisorConfig = { ...DEFAULT_SUPERVISOR_CONFIG };
const startTime = Date.now();

// ── Kill process tree ────────────────────────────────────────────────────────
// Next.js dev spawns a next-server grandchild that holds the port.
// Killing only the direct child orphans the grandchild on the port.

function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    const children = execSyncChild(`pgrep -P ${pid}`, { encoding: "utf-8", timeout: 3000 }).trim();
    for (const childPid of children.split("\n").filter(Boolean)) {
      killTree(parseInt(childPid, 10), signal);
    }
  } catch { /* no children or pgrep failed */ }
  try {
    process.kill(pid, signal);
  } catch { /* already dead */ }
}

// ── State ────────────────────────────────────────────────────────────────────

const processes = new Map<ProcessName, ProcessState>();
const childProcesses = new Map<ProcessName, ChildProcess>();
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;
let stabilityStart: number | null = null;
let shuttingDown = false;

// ── Mode detection ───────────────────────────────────────────────────────────

function detectMode(): "dev" | "build" {
  // CLI arg sets the initial mode by writing to the file — not a permanent override.
  // After startup, the file is the sole source of truth (settings page writes it,
  // switchMode() reads it). This prevents --mode=dev from silently ignoring
  // subsequent mode switches via the dashboard.
  const modeArg = process.argv.find((a) => a.startsWith("--mode="));
  if (modeArg) {
    const cliMode = modeArg.split("=")[1] as "dev" | "build";
    try { writeFileSync(MODE_FILE, cliMode, "utf-8"); } catch { /* ignore */ }
    return cliMode;
  }

  // Server mode file — single source of truth
  try {
    const mode = readFileSync(MODE_FILE, "utf-8").trim();
    if (mode === "dev" || mode === "build") return mode;
  } catch { /* fallback */ }

  return "build";
}

function isDocker(): boolean {
  return !isGitAvailable(PROJECT_ROOT) || process.env.DOCKER === "true";
}

// ── Process configuration ────────────────────────────────────────────────────

function buildProcessConfigs(mode: "dev" | "build"): ProcessConfig[] {
  const configs: ProcessConfig[] = [];
  const isDev = mode === "dev";
  const tsxBin = join(CORE_DIR, "node_modules", ".bin", "tsx");

  // Core backend
  if (isDev) {
    configs.push({
      name: "core",
      healthUrl: `http://127.0.0.1:${CORE_PORT}/api/health`,
      command: tsxBin,
      args: ["watch", "--env-file=.env", "src/index.ts"],
      cwd: CORE_DIR,
      detached: false,
      env: { TALOME_SUPERVISED: "1", TALOME_MANAGED: "1", TSX: "1" },
    });
  } else {
    configs.push({
      name: "core",
      healthUrl: `http://127.0.0.1:${CORE_PORT}/api/health`,
      command: process.execPath,
      args: ["--env-file=.env", "dist/index.js"],
      cwd: CORE_DIR,
      detached: false,
      env: { TALOME_SUPERVISED: "1", TALOME_MANAGED: "1" },
    });
  }

  // Dashboard — skip in Docker if standalone dir doesn't exist
  const dashboardStandalone = join(DASHBOARD_DIR, ".next", "standalone", "apps", "dashboard", "server.js");
  const dashboardExists = isDev || existsSync(dashboardStandalone);

  if (dashboardExists) {
    if (isDev) {
      configs.push({
        name: "dashboard",
        healthUrl: `http://127.0.0.1:${DASHBOARD_PORT}`,
        command: join(DASHBOARD_DIR, "node_modules", ".bin", "next"),
        args: ["dev", "--port", String(DASHBOARD_PORT)],
        cwd: DASHBOARD_DIR,
        detached: false,
      });
    } else {
      configs.push({
        name: "dashboard",
        healthUrl: `http://127.0.0.1:${DASHBOARD_PORT}`,
        command: process.execPath,
        args: [dashboardStandalone],
        cwd: DASHBOARD_DIR,
        detached: false,
        env: { PORT: String(DASHBOARD_PORT), HOSTNAME: "0.0.0.0" },
      });
    }
  }

  // Terminal daemon (always detached — managed via health endpoint + PID)
  if (isDev) {
    configs.push({
      name: "terminal_daemon",
      healthUrl: `http://127.0.0.1:${DAEMON_PORT}/health`,
      command: tsxBin,
      args: ["--env-file=.env", "src/terminal-daemon.ts"],
      cwd: CORE_DIR,
      detached: true,
    });
  } else {
    const daemonScript = existsSync(join(CORE_DIR, "dist", "terminal-daemon.js"))
      ? "dist/terminal-daemon.js"
      : "src/terminal-daemon.js";
    configs.push({
      name: "terminal_daemon",
      healthUrl: `http://127.0.0.1:${DAEMON_PORT}/health`,
      command: process.execPath,
      args: ["--env-file=.env", daemonScript],
      cwd: CORE_DIR,
      detached: true,
    });
  }

  return configs;
}

// ── Process state management ─────────────────────────────────────────────────

function createProcessState(cfg: ProcessConfig): ProcessState {
  return {
    config: cfg,
    pid: null,
    status: "stopped",
    consecutiveFailures: 0,
    crashTimestamps: [],
    lastHealthyAt: null,
    startedAt: null,
    backoffMs: config.initialBackoffMs,
    escalationLevel: "restart",
    logBuffer: [],
    restartTimer: null,
    postEvolutionGraceUntil: null,
  };
}

function appendLog(state: ProcessState, line: string): void {
  state.logBuffer.push(line);
  if (state.logBuffer.length > LOG_BUFFER_SIZE) {
    state.logBuffer.shift();
  }
}

// ── Process spawning ─────────────────────────────────────────────────────────

function spawnManagedProcess(name: ProcessName): void {
  const state = processes.get(name);
  if (!state || shuttingDown) return;

  const cfg = state.config;
  const env = { ...process.env, ...cfg.env };

  console.log(`[supervisor] Starting ${name}: ${cfg.command} ${cfg.args.join(" ")}`);

  try {
    const child = spawn(cfg.command, cfg.args, {
      cwd: cfg.cwd,
      env,
      stdio: cfg.detached ? "ignore" : ["ignore", "pipe", "pipe"],
      detached: cfg.detached,
    });

    if (cfg.detached) {
      child.unref();
    }

    state.pid = child.pid ?? null;
    state.status = "starting";
    state.startedAt = Date.now();

    childProcesses.set(name, child);

    // Capture stdout/stderr for non-detached processes
    if (!cfg.detached) {
      child.stdout?.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          if (line.trim()) {
            appendLog(state, line);
            // Forward to supervisor stdout
            process.stdout.write(`[${name}] ${line}\n`);
          }
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          if (line.trim()) {
            appendLog(state, line);
            process.stderr.write(`[${name}] ${line}\n`);
          }
        }
      });

      child.on("exit", (code, signal) => {
        if (shuttingDown || switching) return;
        handleProcessExit(name, code, signal);
      });

      child.on("error", (err) => {
        console.error(`[supervisor] ${name} spawn error:`, err.message);
        if (!shuttingDown) {
          state.status = "crashed";
          scheduleRestart(name);
        }
      });
    }

    logSupervisorEvent(name, "restart", {
      severity: "info",
      actionTaken: "spawned",
    });
  } catch (err) {
    console.error(`[supervisor] Failed to spawn ${name}:`, err);
    state.status = "crashed";
    scheduleRestart(name);
  }
}

// ── Process exit handling ────────────────────────────────────────────────────

function handleProcessExit(name: ProcessName, code: number | null, signal: string | null): void {
  const state = processes.get(name);
  if (!state) return;

  state.pid = null;
  childProcesses.delete(name);

  // Evolution restart — check if mode changed, trigger full switch if so
  if (code === EXIT_EVOLUTION_RESTART) {
    let fileMode: "dev" | "build" = "build";
    try {
      const m = readFileSync(MODE_FILE, "utf-8").trim();
      if (m === "dev" || m === "build") fileMode = m;
    } catch { /* use default */ }

    const currentMode = state.config.env?.TSX === "1" ? "dev" : "build";
    if (fileMode !== currentMode) {
      console.log(`[supervisor] ${name} exit 75 — mode changed to ${fileMode}, switching all processes`);
      void switchMode();
      return;
    }

    console.log(`[supervisor] ${name} requested evolution restart (exit 75)`);
    state.status = "starting";
    state.backoffMs = config.initialBackoffMs;
    state.escalationLevel = "restart";
    state.postEvolutionGraceUntil = Date.now() + 60_000;
    setTimeout(() => spawnManagedProcess(name), 1000);
    return;
  }

  // Clean exit — still restart. The supervisor keeps all processes running
  // unless it's shutting down itself (checked via `shuttingDown` above).
  // A SIGTERM to a child triggers graceful shutdown → exit 0, but we want
  // the supervisor to bring it back since it wasn't an intentional stop.
  if (code === 0 && !signal) {
    console.log(`[supervisor] ${name} exited (code 0) — restarting`);
    state.status = "starting";
    setTimeout(() => spawnManagedProcess(name), config.initialBackoffMs);
    return;
  }

  // Crash
  console.error(`[supervisor] ${name} crashed (code=${code}, signal=${signal})`);
  state.status = "crashed";
  state.crashTimestamps.push(Date.now());
  // Keep only last 10 crash timestamps
  if (state.crashTimestamps.length > 10) state.crashTimestamps.shift();

  logSupervisorEvent(name, "crash", {
    severity: "warning",
    exitCode: code,
    signal: signal,
    crashLog: state.logBuffer.slice(-50).join("\n"),
  });

  // Reset stability tracking
  stabilityStart = null;

  // Run escalation
  void handleEscalation(name, code, signal);
}

// ── Escalation state machine ─────────────────────────────────────────────────

async function handleEscalation(
  name: ProcessName,
  exitCode: number | null,
  exitSignal: string | null,
): Promise<void> {
  const state = processes.get(name);
  if (!state || shuttingDown) return;

  const recentCrashes = state.crashTimestamps.filter(
    (t) => Date.now() - t < config.crashWindowMs,
  );
  const crashCount = recentCrashes.length;

  // In dev mode, never escalate beyond simple restart. File-change crashes
  // are expected (tsx watch kills + restarts on every save). The developer
  // fixes the issue and tsx auto-retries. Revert/diagnosis would destroy
  // their in-progress work.
  const isDev = detectMode() === "dev";

  const inGracePeriod = state.postEvolutionGraceUntil != null && Date.now() < state.postEvolutionGraceUntil;
  if (inGracePeriod) {
    console.log(`[supervisor] ${name} crashed during post-evolution grace period — restart only`);
  }

  // ── Level 1: Simple restart with backoff ─────────────────────────────────
  if (isDev || inGracePeriod || crashCount < config.crashesBeforeDiagnosis) {
    state.escalationLevel = "restart";
    scheduleRestart(name);
    return;
  }

  // ── Level 2: Check for evolution change, then AI diagnose ────────────────
  if (crashCount < config.crashesBeforeRevert) {
    state.escalationLevel = "diagnose";

    // Check for recent evolution run — only revert if uncommitted changes exist
    const evolutionRun = findRecentEvolutionRun();
    if (evolutionRun && config.autoRevertEnabled && isGitAvailable(PROJECT_ROOT)) {
      console.log(`[supervisor] Recent evolution run detected: ${evolutionRun.task}`);
      const stashRef = stashUncommittedChanges(PROJECT_ROOT);

      if (stashRef) {
        markEvolutionRunRolledBack(evolutionRun.id);
        logSupervisorEvent(name, "revert", {
          severity: "critical",
          revertTarget: stashRef,
          actionTaken: `Reverted evolution run: ${evolutionRun.task}`,
        });
        writeNotificationDirect(
          "critical",
          `Auto-reverted: ${name} crash after evolution change`,
          `Stashed changes from "${evolutionRun.task}" to recover stability. Stash ref: ${stashRef}`,
        );
        scheduleRestart(name);
        return;
      }
      // Clean tree — crash is in committed code, stashing won't help. Fall through to diagnosis.
      console.log(`[supervisor] Working tree clean — crash is in committed code, proceeding to diagnosis`);
    }

    // AI diagnosis
    const diagnosesToday = getDiagnosisCountToday(name);
    if (diagnosesToday < config.maxDiagnosesPerDay) {
      try {
        const bundle = collectDiagnostics(
          name, exitCode, exitSignal, crashCount,
          state.logBuffer, PROJECT_ROOT, DB_PATH,
        );
        const diagnosis = await diagnoseProcessCrash(bundle, PROJECT_ROOT, DB_PATH);

        logSupervisorEvent(name, "diagnosis", {
          severity: "warning",
          diagnosis: `${diagnosis.rootCause} (confidence: ${diagnosis.confidence}, action: ${diagnosis.recommendedAction})`,
          costUsd: diagnosis.costUsd,
          actionTaken: diagnosis.recommendedAction,
        });

        // Act on high-confidence recommendations
        if (diagnosis.confidence >= 0.7 && diagnosis.recommendedAction === "revert_evolution") {
          const stashRef = stashUncommittedChanges(PROJECT_ROOT);
          if (stashRef) {
            writeNotificationDirect(
              "warning",
              `AI diagnosed ${name} crash — reverted changes`,
              `Root cause: ${diagnosis.rootCause}. Changes stashed: ${stashRef}`,
            );
          }
        } else if (diagnosis.confidence >= 0.7 && diagnosis.recommendedAction === "revert_uncommitted") {
          const stashRef = stashUncommittedChanges(PROJECT_ROOT);
          if (stashRef) {
            writeNotificationDirect(
              "warning",
              `AI diagnosed ${name} crash — stashed uncommitted changes`,
              `Root cause: ${diagnosis.rootCause}. Changes stashed: ${stashRef}`,
            );
          }
        } else {
          // Notify user with diagnosis
          writeNotificationDirect(
            "warning",
            `AI diagnosed ${name} crash`,
            `Root cause: ${diagnosis.rootCause}\nRecommended action: ${diagnosis.recommendedAction}\nConfidence: ${Math.round(diagnosis.confidence * 100)}%`,
          );
        }
      } catch (err) {
        console.error("[supervisor] AI diagnosis failed:", err);
      }
    }

    scheduleRestart(name);
    return;
  }

  // ── Level 3: Revert to known-good or stop ────────────────────────────────
  if (config.autoRevertEnabled && isGitAvailable(PROJECT_ROOT)) {
    state.escalationLevel = "revert";
    const tag = getLastKnownGood(PROJECT_ROOT);

    if (tag) {
      console.log(`[supervisor] Reverting to known-good: ${tag}`);
      const reverted = revertToKnownGood(PROJECT_ROOT, tag);

      if (reverted) {
        logSupervisorEvent(name, "revert", {
          severity: "critical",
          revertTarget: tag,
          actionTaken: "Reverted to last known-good state",
        });
        writeNotificationDirect(
          "critical",
          `${name} crash loop — reverted to known-good state`,
          `After ${crashCount} crashes in ${Math.round(config.crashWindowMs / 60000)} minutes, reverted to ${tag}. Manual review recommended.`,
        );
        // Reset crash history after revert
        state.crashTimestamps = [];
        state.backoffMs = config.initialBackoffMs;
        scheduleRestart(name);
        return;
      }
    }
  }

  // ── Level 4: Give up — stop and notify ───────────────────────────────────
  state.escalationLevel = "stopped";
  state.status = "stopped";

  logSupervisorEvent(name, "escalation", {
    severity: "critical",
    actionTaken: "stopped",
    crashLog: state.logBuffer.slice(-100).join("\n"),
  });
  writeNotificationDirect(
    "critical",
    `${name} requires manual intervention`,
    `Process crashed ${crashCount} times in ${Math.round(config.crashWindowMs / 60000)} minutes. Automatic recovery exhausted. Check logs and restart manually.`,
  );

  console.error(`[supervisor] ${name} — manual intervention required (${crashCount} crashes)`);
}

// ── Restart scheduling ───────────────────────────────────────────────────────

function scheduleRestart(name: ProcessName): void {
  const state = processes.get(name);
  if (!state || shuttingDown) return;

  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
  }

  const delay = state.backoffMs;
  console.log(`[supervisor] Restarting ${name} in ${delay}ms`);

  state.restartTimer = setTimeout(() => {
    state.restartTimer = null;
    if (!shuttingDown) {
      spawnManagedProcess(name);
    }
  }, delay);

  // Exponential backoff
  state.backoffMs = Math.min(state.backoffMs * config.backoffMultiplier, config.maxBackoffMs);
}

// ── Health checking ──────────────────────────────────────────────────────────

async function checkHealth(name: ProcessName): Promise<boolean> {
  const state = processes.get(name);
  if (!state) return false;

  try {
    const res = await fetch(state.config.healthUrl, {
      signal: AbortSignal.timeout(config.healthCheckTimeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function runHealthChecks(): Promise<void> {
  if (shuttingDown) return;

  let allHealthy = true;

  for (const [name, state] of processes) {
    if (state.status === "stopped") continue;

    // Skip during startup grace period
    if (state.startedAt && Date.now() - state.startedAt < config.startupGraceMs) {
      continue;
    }

    const healthy = await checkHealth(name);

    if (healthy) {
      if (state.consecutiveFailures > 0) {
        console.log(`[supervisor] ${name} recovered after ${state.consecutiveFailures} failures`);
      }
      state.consecutiveFailures = 0;
      state.lastHealthyAt = Date.now();

      // Reset backoff and escalation on sustained health
      if (state.status !== "healthy") {
        state.status = "healthy";
        state.backoffMs = config.initialBackoffMs;
        state.escalationLevel = "restart";
        state.postEvolutionGraceUntil = null;
      }
    } else {
      state.consecutiveFailures++;
      allHealthy = false;

      if (state.consecutiveFailures >= config.failuresForUnhealthy) {
        if (state.status !== "unhealthy" && state.status !== "crashed") {
          console.warn(`[supervisor] ${name} is unhealthy (${state.consecutiveFailures} failures)`);
          state.status = "unhealthy";

          logSupervisorEvent(name, "health_fail", {
            severity: "warning",
            actionTaken: "detected_unhealthy",
          });
        }

        // For detached processes (terminal daemon), we need to respawn
        if (state.config.detached && state.consecutiveFailures >= config.failuresForUnhealthy + 2) {
          console.log(`[supervisor] Respawning detached process: ${name}`);
          state.consecutiveFailures = 0;
          spawnManagedProcess(name);
        }
      }
    }
  }

  // Known-good tagging: all processes healthy for stability window
  if (allHealthy && !isDocker()) {
    if (!stabilityStart) {
      stabilityStart = Date.now();
    } else if (Date.now() - stabilityStart >= config.stabilityWindowMs) {
      recordKnownGood(PROJECT_ROOT);
      stabilityStart = Date.now(); // Reset to avoid constant tagging
    }
  } else {
    stabilityStart = null;
  }

  // Write state file for dashboard API
  writeStateFile();
}

// ── Mode switch (SIGUSR1) ────────────────────────────────────────────────────

let switching = false;

async function switchMode(): Promise<void> {
  if (switching || shuttingDown) return;
  switching = true;
  // Read mode from file directly — CLI arg is for initial startup only.
  // The API writes the file, so switchMode must read it, not detectMode().
  let newMode: "dev" | "build" = "dev";
  try {
    const m = readFileSync(MODE_FILE, "utf-8").trim();
    if (m === "dev" || m === "build") newMode = m;
  } catch { /* default to dev */ }
  console.log(`[supervisor] Mode switch → ${newMode}`);

  if (newMode === "build") {
    console.log("[supervisor] Building...");
    try {
      const { execSync } = await import("node:child_process");
      execSync("pnpm build", { cwd: PROJECT_ROOT, stdio: "inherit", timeout: 300_000 });
    } catch {
      console.error("[supervisor] Build failed — reverting to dev");
      writeFileSync(MODE_FILE, "dev", "utf-8");
      switching = false;
      return;
    }
  }

  const stops: Promise<void>[] = [];
  for (const [, state] of processes) {
    if (state.restartTimer) { clearTimeout(state.restartTimer); state.restartTimer = null; }
    const child = childProcesses.get(state.config.name);
    if (child && !child.killed) {
      stops.push(new Promise<void>((r) => {
        const t = setTimeout(() => {
          if (child.pid) killTree(child.pid, "SIGKILL");
          try { child.kill("SIGKILL"); } catch {}
          r();
        }, 10_000);
        child.once("exit", () => { clearTimeout(t); r(); });
        if (child.pid) killTree(child.pid, "SIGTERM");
        try { child.kill("SIGTERM"); } catch { r(); }
      }));
    }
  }
  await Promise.all(stops);

  // Wait for ports to actually be free before spawning new processes.
  // Both the core (port 4000) and dashboard (port 3000) need their ports released.
  // Simply sleeping isn't reliable — the core's graceful shutdown can take 5+ seconds
  // and the kernel may hold ports in TIME_WAIT after that.
  const portsToCheck = [CORE_PORT, DASHBOARD_PORT];
  const portFreeTimeout = 15_000;
  const portCheckStart = Date.now();
  for (const port of portsToCheck) {
    while (Date.now() - portCheckStart < portFreeTimeout) {
      try {
        const net = await import("node:net");
        const free = await new Promise<boolean>((resolve) => {
          const srv = net.createServer();
          srv.once("error", () => resolve(false));
          srv.listen(port, () => { srv.close(() => resolve(true)); });
        });
        if (free) break;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log(`[supervisor] Ports released in ${Date.now() - portCheckStart}ms`);

  const configs = buildProcessConfigs(newMode);
  processes.clear();
  childProcesses.clear();
  for (const cfg of configs) processes.set(cfg.name, createProcessState(cfg));
  for (const name of processes.keys()) spawnManagedProcess(name);

  console.log(`[supervisor] Restarted in ${newMode} mode`);
  switching = false;
}

// ── State file for dashboard API ─────────────────────────────────────────────

function writeStateFile(): void {
  const snapshot: SupervisorStateSnapshot = {
    processes: {} as SupervisorStateSnapshot["processes"],
    lastKnownGoodTag: isDocker() ? null : getLastKnownGood(PROJECT_ROOT),
    uptime: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  };

  for (const [name, state] of processes) {
    snapshot.processes[name] = {
      pid: state.pid,
      status: state.status,
      escalationLevel: state.escalationLevel,
      consecutiveFailures: state.consecutiveFailures,
      lastHealthyAt: state.lastHealthyAt,
      startedAt: state.startedAt,
      totalCrashes: state.crashTimestamps.length,
    };
  }

  try {
    writeFileSync(STATE_FILE, JSON.stringify(snapshot, null, 2));
  } catch {
    // Non-fatal
  }
}

// ── Graceful shutdown ────────────────────────────────────────────────────────

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[supervisor] ${signal} received — shutting down all processes…`);

  // Stop health checks
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }

  // Cancel pending restart timers
  for (const state of processes.values()) {
    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
  }

  // Send SIGTERM to non-detached children
  const killPromises: Promise<void>[] = [];
  for (const [name, child] of childProcesses) {
    const state = processes.get(name);
    if (state?.config.detached) {
      // Kill detached processes via PID
      if (state.pid) {
        try {
          process.kill(state.pid, "SIGTERM");
          console.log(`[supervisor] Sent SIGTERM to ${name} (pid ${state.pid})`);
        } catch { /* already dead */ }
      }
    } else {
      killPromises.push(
        new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (child.pid) killTree(child.pid, "SIGKILL");
            try { child.kill("SIGKILL"); } catch { /* ignore */ }
            resolve();
          }, 10_000);

          child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });

          if (child.pid) killTree(child.pid, "SIGTERM");
          try { child.kill("SIGTERM"); } catch { /* ignore */ }
          console.log(`[supervisor] Sent SIGTERM to ${name}`);
        }),
      );
    }
  }

  await Promise.all(killPromises);

  // Cleanup
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  try { unlinkSync(STATE_FILE); } catch { /* ignore */ }
  closeEventLog();
  pruneOldEvents();

  console.log("[supervisor] Clean shutdown complete");
  process.exit(0);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = detectMode();
  console.log(`[supervisor] Starting in ${mode} mode (pid ${process.pid})`);
  console.log(`[supervisor] Project root: ${PROJECT_ROOT}`);
  console.log(`[supervisor] Docker: ${isDocker()}, Git: ${isGitAvailable(PROJECT_ROOT)}`);

  // Ensure .talome directory exists
  mkdirSync(TALOME_DIR, { recursive: true });

  // Write PID file
  writeFileSync(PID_FILE, String(process.pid), "utf-8");

  // Initialize event log (direct SQLite)
  initEventLog(DB_PATH);

  // Disable auto-revert in Docker (image IS the known-good state)
  if (isDocker()) {
    config.autoRevertEnabled = false;
  }

  // Create RAM disk for HLS temp segments (survives reboots via supervisor)
  if (process.platform === "darwin" && !isDocker()) {
    try {
      const { execSync } = await import("node:child_process");
      if (!existsSync("/Volumes/TalomeHLS")) {
        console.log("[supervisor] Creating 2GB RAM disk for HLS temp...");
        const dev = execSync("hdiutil attach -nomount ram://4194304", { encoding: "utf-8" }).trim();
        execSync(`diskutil erasevolume HFS+ TalomeHLS ${dev}`, { stdio: "ignore" });
        console.log("[supervisor] RAM disk ready: /Volumes/TalomeHLS");
      }
    } catch (err) {
      console.warn("[supervisor] RAM disk creation failed (non-fatal):", err instanceof Error ? err.message : err);
    }
  }

  // Build and initialize process configs
  const processConfigs = buildProcessConfigs(mode);
  for (const cfg of processConfigs) {
    processes.set(cfg.name, createProcessState(cfg));
  }

  // Signal handlers
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGUSR1", () => void switchMode());
  process.on("unhandledRejection", (reason) => {
    console.error("[supervisor] unhandledRejection:", reason);
  });

  // Spawn all processes
  for (const name of processes.keys()) {
    spawnManagedProcess(name);
  }

  // Start health check loop
  healthCheckInterval = setInterval(() => {
    void runHealthChecks();
  }, config.healthCheckIntervalMs);

  // Prune old events periodically (every 6 hours)
  setInterval(() => pruneOldEvents(), 6 * 60 * 60 * 1000).unref();

  console.log(`[supervisor] Monitoring ${processes.size} processes`);
}

void main();
