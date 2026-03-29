import { listContainers, getSystemStats, checkInterContainerConnectivity, type ContainerPair } from "./docker/client.js";
import { verifyTalomeNetworkAttachments } from "./docker/talome-network.js";
import { writeAuditEntry } from "./db/audit.js";
import { writeNotification } from "./db/notifications.js";
import { refreshAppStatuses } from "./stores/lifecycle.js";
import { fireTrigger } from "./automation/engine.js";
import { maybeCheckUpdates } from "./stores/update-checker.js";
import { generateSuggestions } from "./evolution/suggest.js";
import { maybeAutoExecute } from "./evolution/auto-execute.js";
import { getSetting, setSetting } from "./utils/settings.js";
import { db } from "./db/index.js";
import { sql } from "drizzle-orm";
import { backupAppTool } from "./ai/tools/backup-tools.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "./utils/logger.js";

const log = createLogger("monitor");

let previousContainerStates = new Map<string, string>();

// Deduplicate notifications: track last time we fired each alert key
// so we don't spam a new notification every 60s for a persistent issue.
const lastNotified = new Map<string, number>();
const NOTIFY_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours between repeats

function shouldNotify(key: string): boolean {
  const last = lastNotified.get(key) ?? 0;
  if (Date.now() - last > NOTIFY_COOLDOWN_MS) {
    lastNotified.set(key, Date.now());
    return true;
  }
  return false;
}

// ── Disk notification state ──────────────────────────────────────────────────
// Uses threshold-crossing detection: only notify when disk enters a new state
// (normal → warning, warning → critical). For persistent conditions, send
// reminders at a much longer interval. Cooldowns are persisted to DB to
// survive server restarts.

type DiskState = "normal" | "warning" | "critical";
let lastDiskState: DiskState | null = null; // null = unknown on first run

const DISK_WARNING_REMINDER_MS = 6 * 60 * 60 * 1000;  // 6h between warning reminders
const DISK_CRITICAL_REMINDER_MS = 2 * 60 * 60 * 1000; // 2h between critical reminders

function getDiskState(pct: number): DiskState {
  if (pct > 90) return "critical";
  if (pct > 80) return "warning";
  return "normal";
}

function getPersistedTimestamp(key: string): number {
  const raw = getSetting(key);
  return raw ? parseInt(raw, 10) || 0 : 0;
}

function persistTimestamp(key: string): void {
  setSetting(key, String(Date.now()));
}

async function checkContainerHealth() {
  try {
    const containers = await listContainers();
    const currentStates = new Map<string, string>();
    const stoppedNames: string[] = [];

    for (const c of containers) {
      currentStates.set(c.name, c.status);
      const prev = previousContainerStates.get(c.name);

      if (prev && prev === "running" && c.status !== "running") {
        stoppedNames.push(c.name);
        writeAuditEntry(
          `Container down: ${c.name}`,
          "modify",
          `${c.name} changed from ${prev} to ${c.status}`,
        );
        writeNotification(
          "critical",
          `${c.name} stopped`,
          `Container changed from running to ${c.status}.`,
          c.name,
        );
        void fireTrigger("container_stopped", { containerId: c.id, containerName: c.name });
        // Reset cooldown so the next transition fires immediately
        lastNotified.delete(`container:${c.name}`);
      }
    }

    previousContainerStates = currentStates;

    // When a container transitions away from running, check if any remaining
    // running containers in the same compose stacks still have connectivity
    // to their siblings. This detects "connectivity_broken" scenarios.
    if (stoppedNames.length > 0) {
      void checkConnectivityForStoppedContainers(containers, stoppedNames);
    }
  } catch (err) {
    log.error("checkContainerHealth error", err);
  }
}

/**
 * When containers stop, probe connectivity between their still-running
 * compose siblings to detect network-level breakage.
 */
async function checkConnectivityForStoppedContainers(
  allContainers: Awaited<ReturnType<typeof listContainers>>,
  stoppedNames: string[],
) {
  try {
    // Group containers by compose project
    const projectGroups = new Map<string, string[]>();
    for (const c of allContainers) {
      const project = c.labels["com.docker.compose.project"];
      if (!project) continue;
      const group = projectGroups.get(project) ?? [];
      group.push(c.name);
      projectGroups.set(project, group);
    }

    // Find compose projects affected by stopped containers
    const pairs: ContainerPair[] = [];
    for (const stoppedName of stoppedNames) {
      const stopped = allContainers.find((c) => c.name === stoppedName);
      if (!stopped) continue;
      const project = stopped.labels["com.docker.compose.project"];
      if (!project) continue;

      const siblings = (projectGroups.get(project) ?? []).filter((name) => {
        const c = allContainers.find((ct) => ct.name === name);
        return c && c.status === "running" && name !== stoppedName;
      });

      // Build pairs: each running sibling tries to reach each other running sibling
      for (let i = 0; i < siblings.length; i++) {
        for (let j = i + 1; j < siblings.length; j++) {
          pairs.push({ from: siblings[i], to: siblings[j] });
        }
      }
    }

    if (pairs.length === 0) return;

    // Cap at 10 pairs to avoid blocking
    const capped = pairs.slice(0, 10);
    const report = await checkInterContainerConnectivity(capped);

    for (const result of report.results) {
      if (!result.reachable && shouldNotify(`connectivity:${result.from}:${result.to}`)) {
        writeNotification(
          "warning",
          `Connectivity broken: ${result.from} → ${result.to}`,
          `${result.from} cannot reach ${result.to}${result.dnsResolvable ? " (DNS resolves but TCP unreachable)" : " (DNS resolution failed)"}.${result.error ? ` Error: ${result.error}` : ""}`,
          result.from,
        );
        void fireTrigger("container_stopped", {
          containerId: result.from,
          containerName: result.from,
          connectivityBroken: true,
          unreachableTarget: result.to,
        });
      }
    }
  } catch (err) {
    log.error("checkConnectivityForStoppedContainers error", err);
  }
}

async function checkDiskUsage() {
  try {
    const stats = await getSystemStats();
    const pct = stats.disk.percent;
    const currentState = getDiskState(pct);

    // On first run after restart, initialize state without notifying — the
    // persisted reminder timestamp still applies so we don't re-alert immediately.
    if (lastDiskState === null) {
      lastDiskState = currentState;
      return;
    }

    // Detect state escalations (normal→warning, normal→critical, warning→critical)
    const isEscalation =
      (lastDiskState === "normal" && currentState !== "normal") ||
      (lastDiskState === "warning" && currentState === "critical");

    // For persistent conditions, send a reminder after a long interval
    const reminderMs =
      currentState === "critical"
        ? DISK_CRITICAL_REMINDER_MS
        : DISK_WARNING_REMINDER_MS;
    const cooldownKey = `_monitor_disk_${currentState}`;
    const lastNotifiedAt = getPersistedTimestamp(cooldownKey);
    const isReminder =
      currentState !== "normal" && Date.now() - lastNotifiedAt > reminderMs;

    if (currentState === "critical" && (isEscalation || isReminder)) {
      writeAuditEntry("Disk usage critical", "modify", `Disk at ${pct}%`);
      writeNotification(
        "critical",
        "Disk usage critical",
        `Disk is at ${pct}%. Free up space soon to avoid service interruptions.`,
      );
      persistTimestamp(cooldownKey);
      void fireTrigger("disk_usage_exceeds", { mountPath: "/", pct });
    } else if (currentState === "warning" && (isEscalation || isReminder)) {
      writeNotification(
        "warning",
        "Disk usage high",
        `Disk is at ${pct}%. Consider freeing space.`,
      );
      persistTimestamp(cooldownKey);
      void fireTrigger("disk_usage_exceeds", { mountPath: "/", pct });
    }

    lastDiskState = currentState;
  } catch (err) {
    log.error("checkDiskUsage error", err);
  }
}

// ── CPU & Memory threshold alerts ────────────────────────────────────────────

interface AlertThresholds {
  cpu?: { warning: number; critical: number };
  memory?: { warning: number; critical: number };
}

type MetricState = "normal" | "warning" | "critical";
let lastCpuState: MetricState | null = null;
let lastMemoryState: MetricState | null = null;

const CPU_REMINDER_MS = 30 * 60 * 1000;    // 30min — CPU spikes are often transient
const MEMORY_REMINDER_MS = 60 * 60 * 1000; // 1h

function getThresholds(): AlertThresholds {
  const raw = getSetting("alert_thresholds");
  if (!raw) return {};
  try { return JSON.parse(raw) as AlertThresholds; } catch { return {}; }
}

function getMetricState(pct: number, threshold: { warning: number; critical: number }): MetricState {
  if (pct >= threshold.critical) return "critical";
  if (pct >= threshold.warning) return "warning";
  return "normal";
}

async function checkMetricThresholds() {
  try {
    const thresholds = getThresholds();
    if (!thresholds.cpu && !thresholds.memory) return; // No thresholds configured

    const stats = await getSystemStats();

    // ── CPU ─────────────────────────────────────────────
    if (thresholds.cpu) {
      const cpuPct = stats.cpu.usage;
      const cpuState = getMetricState(cpuPct, thresholds.cpu);

      if (lastCpuState === null) {
        lastCpuState = cpuState;
      } else {
        const isEscalation =
          (lastCpuState === "normal" && cpuState !== "normal") ||
          (lastCpuState === "warning" && cpuState === "critical");
        const cooldownKey = `_monitor_cpu_${cpuState}`;
        const lastAt = getPersistedTimestamp(cooldownKey);
        const isReminder = cpuState !== "normal" && Date.now() - lastAt > CPU_REMINDER_MS;

        if (cpuState === "critical" && (isEscalation || isReminder)) {
          writeNotification("critical", "CPU usage critical", `CPU is at ${cpuPct.toFixed(1)}%.`);
          persistTimestamp(cooldownKey);
        } else if (cpuState === "warning" && (isEscalation || isReminder)) {
          writeNotification("warning", "CPU usage high", `CPU is at ${cpuPct.toFixed(1)}%.`);
          persistTimestamp(cooldownKey);
        }
        lastCpuState = cpuState;
      }
    }

    // ── Memory ──────────────────────────────────────────
    if (thresholds.memory) {
      const memPct = stats.memory.totalBytes > 0
        ? (stats.memory.usedBytes / stats.memory.totalBytes) * 100
        : 0;
      const memState = getMetricState(memPct, thresholds.memory);

      if (lastMemoryState === null) {
        lastMemoryState = memState;
      } else {
        const isEscalation =
          (lastMemoryState === "normal" && memState !== "normal") ||
          (lastMemoryState === "warning" && memState === "critical");
        const cooldownKey = `_monitor_memory_${memState}`;
        const lastAt = getPersistedTimestamp(cooldownKey);
        const isReminder = memState !== "normal" && Date.now() - lastAt > MEMORY_REMINDER_MS;

        if (memState === "critical" && (isEscalation || isReminder)) {
          writeNotification("critical", "Memory usage critical", `Memory is at ${memPct.toFixed(1)}%.`);
          persistTimestamp(cooldownKey);
        } else if (memState === "warning" && (isEscalation || isReminder)) {
          writeNotification("warning", "Memory usage high", `Memory is at ${memPct.toFixed(1)}%.`);
          persistTimestamp(cooldownKey);
        }
        lastMemoryState = memState;
      }
    }
  } catch (err) {
    log.error("checkMetricThresholds error", err);
  }
}

async function persistMetrics() {
  try {
    const stats = await getSystemStats();
    const now = new Date().toISOString();
    db.run(sql`INSERT INTO metrics (timestamp, cpu, memory_used, memory_total, disk_used, disk_total, network_rx, network_tx) VALUES (${now}, ${stats.cpu.usage}, ${stats.memory.usedBytes}, ${stats.memory.totalBytes}, ${stats.disk.usedBytes}, ${stats.disk.totalBytes}, ${stats.network.rxBytesPerSec}, ${stats.network.txBytesPerSec})`);

    // Prune old metrics (keep 7 days by default)
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    db.run(sql`DELETE FROM metrics WHERE timestamp < ${cutoff}`);
  } catch (err) {
    log.error("persistMetrics error", err);
  }
}

// ── Backup scheduler ──────────────────────────────────────────────────────────

function cronMatchesNow(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = parts;
  const now = new Date();
  const min = now.getMinutes();
  const hour = now.getHours();
  const dom = now.getDate();
  const mon = now.getMonth() + 1;
  const dow = now.getDay();

  function matches(expr: string, value: number): boolean {
    if (expr === "*") return true;
    if (expr.startsWith("*/")) {
      const step = parseInt(expr.slice(2), 10);
      return step > 0 && value % step === 0;
    }
    return expr.split(",").some((part) => {
      if (part.includes("-")) {
        const [lo, hi] = part.split("-").map(Number);
        return value >= lo && value <= hi;
      }
      return parseInt(part, 10) === value;
    });
  }

  return (
    matches(minExpr, min) &&
    matches(hourExpr, hour) &&
    matches(domExpr, dom) &&
    matches(monExpr, mon) &&
    matches(dowExpr, dow)
  );
}

async function executeScheduledBackup(appId: string, scheduleId: string) {
  const execute = backupAppTool.execute;
  if (!execute) {
    log.error("backupAppTool.execute not available");
    return;
  }
  try {
    const result = await execute(
      { appId, stopFirst: false, triggeredBy: "schedule" as const },
      { toolCallId: randomUUID(), messages: [], abortSignal: undefined as unknown as AbortSignal },
    );
    const success = typeof result === "object" && result !== null && "success" in result && result.success;
    if (success) {
      const sizeMb = "sizeMb" in result ? result.sizeMb : "?";
      writeNotification("info", "Backup completed", `${appId} backed up successfully (${sizeMb} MB)`);
    } else {
      const error = typeof result === "object" && result !== null && "error" in result ? result.error : "Unknown error";
      writeNotification("warning", "Backup failed", `${appId}: ${error}`);
      log.error(`Scheduled backup failed for ${appId}`, error);
    }
  } catch (err) {
    writeNotification("warning", "Backup failed", `${appId}: ${err instanceof Error ? err.message : String(err)}`);
    log.error(`Scheduled backup error for ${appId}`, err);
  }
}

async function checkBackupSchedules() {
  try {
    const schedules = db.all(sql`SELECT * FROM backup_schedules WHERE enabled = 1`) as Array<{
      id: string;
      app_id: string | null;
      cron: string;
      last_run_at: string | null;
    }>;

    for (const schedule of schedules) {
      if (!cronMatchesNow(schedule.cron)) continue;

      // Prevent running more than once per minute
      if (schedule.last_run_at) {
        const lastRun = new Date(schedule.last_run_at).getTime();
        if (Date.now() - lastRun < 59_000) continue;
      }

      // Mark as run
      db.run(sql`UPDATE backup_schedules SET last_run_at = ${new Date().toISOString()} WHERE id = ${schedule.id}`);

      // Fire automation trigger for any wired automations
      void fireTrigger("schedule", { scheduleId: schedule.id, type: "backup", appId: schedule.app_id });

      // Execute backups directly — don't rely on an automation being wired up
      if (schedule.app_id) {
        void executeScheduledBackup(schedule.app_id, schedule.id);
      } else {
        // All-apps backup: back up each installed app sequentially
        const apps = db.all(sql`SELECT app_id FROM installed_apps`) as Array<{ app_id: string }>;
        void (async () => {
          for (const app of apps) {
            await executeScheduledBackup(app.app_id, schedule.id);
          }
        })();
      }
    }
  } catch (err) {
    log.error("checkBackupSchedules error", err);
  }
}

// ── Evolution auto-scan ──────────────────────────────────────────────────────

let lastEvolutionScan = Date.now(); // defer first scan — don't hit the API on every restart
const EVOLUTION_SCAN_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

async function maybeRunEvolutionScan() {
  if (getSetting("evolution_auto_scan") === "false") return;
  if (Date.now() - lastEvolutionScan < EVOLUTION_SCAN_INTERVAL) return;
  lastEvolutionScan = Date.now();
  try {
    const { signalsFound, suggestionsCreated } = await generateSuggestions();
    if (suggestionsCreated > 0) {
      writeNotification(
        "info",
        `${suggestionsCreated} improvement${suggestionsCreated > 1 ? "s" : ""} suggested`,
        `Analyzed ${signalsFound} signals from the last 7 days.`,
        "evolution",
      );
    }
  } catch (err: unknown) {
    // Reduce noise for known API errors (credit exhaustion, rate limits)
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("credit balance") || msg.includes("rate limit")) {
      log.warn(`Evolution scan skipped: ${msg.split("\n")[0]}`);
    } else {
      log.error("Evolution scan error", err);
    }
  }
}

async function repairNetworkAttachments() {
  try {
    const { repaired } = await verifyTalomeNetworkAttachments();
    if (repaired.length > 0) {
      log.info(`Repaired talome network for: ${repaired.join(", ")}`);
    }
  } catch (err) {
    // Network repair is best-effort — don't block other checks
    log.error("repairNetworkAttachments error", err);
  }
}

async function runChecks() {
  await Promise.allSettled([
    checkContainerHealth(),
    checkDiskUsage(),
    checkMetricThresholds(),
    refreshAppStatuses(),
    persistMetrics(),
    checkBackupSchedules(),
    repairNetworkAttachments(),
  ]);
  // Non-async, runs on its own 6h cadence internally
  maybeCheckUpdates();
  // Evolution scan runs on its own 6h cadence
  void maybeRunEvolutionScan();
  // Auto-execute eligible suggestions (checks its own settings + cadence)
  void maybeAutoExecute();
}

export function startMonitor(intervalMs = 60_000) {
  runChecks();
  const timer = setInterval(runChecks, intervalMs);
  return () => clearInterval(timer);
}
