import { tool } from "ai";
import { z } from "zod";
import {
  listContainers,
  getContainerStats,
  getContainerLogs,
  inspectContainer,
  getSystemStats,
} from "../../docker/client.js";
import type { Container, ContainerStats } from "@talome/types";
import type { ContainerInspect } from "../../docker/client.js";

// ── Types ─────────────────────────────────────────────────────────────────────

const CHECK_TYPES = ["flapping", "memory", "errors", "response_time", "dependencies", "disk", "startup"] as const;
type CheckType = (typeof CHECK_TYPES)[number];

interface HealthIssue {
  severity: "critical" | "warning" | "info";
  category: CheckType;
  title: string;
  detail: string;
  remediation: string;
}

interface ContainerData {
  container: Container;
  inspect: ContainerInspect | null;
  stats: ContainerStats | null;
  logs: string[] | null;
}

interface ContainerReport {
  containerId: string;
  name: string;
  overallStatus: "healthy" | "degraded" | "critical";
  issues: HealthIssue[];
  metrics: {
    cpuPercent?: number;
    memoryPercent?: number;
    memoryUsageMb?: number;
    memoryLimitMb?: number;
    restartCount?: number;
  };
}

type SystemMount = { mount: string; percent: number; usedBytes: number; totalBytes: number };

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchContainerData(container: Container): Promise<ContainerData> {
  const [inspectResult, statsResult, logsResult] = await Promise.allSettled([
    inspectContainer(container.id),
    container.status === "running" ? getContainerStats(container.id) : Promise.reject<ContainerStats>("not running"),
    container.status === "running"
      ? getContainerLogs(container.id, 80).then((raw) => raw.split("\n").filter(Boolean))
      : Promise.reject<string[]>("not running"),
  ]);

  return {
    container,
    inspect: inspectResult.status === "fulfilled" ? inspectResult.value : null,
    stats: statsResult.status === "fulfilled" ? statsResult.value : null,
    logs: logsResult.status === "fulfilled" ? logsResult.value : null,
  };
}

// ── Individual checks ─────────────────────────────────────────────────────────

function runFlappingCheck(data: ContainerData): HealthIssue[] {
  const { inspect, container } = data;
  if (!inspect) return [];
  const issues: HealthIssue[] = [];
  const { restartCount, state } = inspect;

  if (state.status === "restarting") {
    issues.push({
      severity: "critical",
      category: "flapping",
      title: "Crash loop — container is actively restarting",
      detail: `${container.name} is in a restart loop (restart count: ${restartCount}). Docker is continuously trying to bring it back up.`,
      remediation:
        "Check logs with get_container_logs to find the root cause (bad config, missing env var, port conflict). Fix the issue before restarting — looping will not self-heal.",
    });
  } else if (restartCount >= 10) {
    issues.push({
      severity: "critical",
      category: "flapping",
      title: `Crash history: ${restartCount} restarts`,
      detail: `${container.name} has restarted ${restartCount} times — indicates a recurring crash or instability since last deployment.`,
      remediation:
        "Review logs for panic/fatal/OOM errors. Likely causes: misconfiguration, dependency failure, or insufficient resources.",
    });
  } else if (restartCount >= 3) {
    issues.push({
      severity: "warning",
      category: "flapping",
      title: `Elevated restart count (${restartCount})`,
      detail: `${container.name} has restarted ${restartCount} times since last deployment.`,
      remediation: "Monitor closely and check recent logs. May be caused by intermittent upstream dependency failures.",
    });
  }
  return issues;
}

function runStartupCheck(data: ContainerData): HealthIssue[] {
  const { inspect, container } = data;
  if (!inspect) return [];
  const issues: HealthIssue[] = [];
  const { restartCount, state } = inspect;

  if (state.status === "created") {
    issues.push({
      severity: "warning",
      category: "startup",
      title: "Container was created but never started",
      detail: `${container.name} is in 'created' state — it exists but has never been run.`,
      remediation: "Start it with start_container or restart_app.",
    });
    return issues;
  }

  const startedAt = new Date(state.startedAt).getTime();
  const uptimeSec = (Date.now() - startedAt) / 1000;

  // Very short uptime combined with prior restarts = likely still crash-looping
  if (uptimeSec < 90 && restartCount > 0) {
    issues.push({
      severity: "warning",
      category: "startup",
      title: `Unstable start — only up for ${Math.round(uptimeSec)}s after ${restartCount} restart(s)`,
      detail: `${container.name} has been running for only ${Math.round(uptimeSec)}s since its last restart. Prior restart count: ${restartCount}.`,
      remediation:
        "Wait for the container to stabilise (60–120s), then check logs if it crashes again.",
    });
  }

  // Running for a long time but with very high restart count = historically flapping
  if (uptimeSec > 3600 && restartCount >= 5) {
    issues.push({
      severity: "info",
      category: "startup",
      title: `Historically unstable (${restartCount} past restarts, stable for ${Math.round(uptimeSec / 3600)}h now)`,
      detail: `${container.name} has accumulated ${restartCount} restarts but has been stable for the last ${Math.round(uptimeSec / 3600)} hour(s).`,
      remediation: "Currently stable — no action needed. Consider investigating root cause to prevent recurrence.",
    });
  }
  return issues;
}

function runMemoryCheck(data: ContainerData): HealthIssue[] {
  const { stats, container } = data;
  if (!stats) return [];
  const issues: HealthIssue[] = [];
  const { memoryUsageMb, memoryLimitMb } = stats;

  // Skip containers with no effective memory limit (limit > 32GB is "unlimited")
  if (memoryLimitMb <= 0 || memoryLimitMb > 32768) return issues;

  const percent = (memoryUsageMb / memoryLimitMb) * 100;

  if (percent > 92) {
    issues.push({
      severity: "critical",
      category: "memory",
      title: `Memory near OOM limit (${Math.round(percent)}% — ${memoryUsageMb}MB / ${memoryLimitMb}MB)`,
      detail: `${container.name} is using ${memoryUsageMb}MB of its ${memoryLimitMb}MB limit. The OOM killer may terminate it at any moment.`,
      remediation:
        "Increase the memory limit immediately via set_resource_limits. If usage keeps climbing despite limits, the container may have a memory leak.",
    });
  } else if (percent > 80) {
    issues.push({
      severity: "warning",
      category: "memory",
      title: `High memory usage (${Math.round(percent)}% — ${memoryUsageMb}MB / ${memoryLimitMb}MB)`,
      detail: `${container.name} is consuming ${Math.round(percent)}% of its configured memory limit.`,
      remediation:
        "Consider increasing the limit via set_resource_limits if usage is trending upward, or investigate for a memory leak.",
    });
  }
  return issues;
}

function runErrorsCheck(data: ContainerData): HealthIssue[] {
  const { logs, container } = data;
  if (!logs || logs.length === 0) return [];
  const issues: HealthIssue[] = [];

  const oomPattern = /\b(out of memory|oom.?kill|memory limit exceeded|killed process)\b/i;
  const errorPattern = /\b(error|fatal|exception|panic|critical)\b/i;

  const oomLines = logs.filter((l) => oomPattern.test(l));
  const errorLines = logs.filter((l) => errorPattern.test(l));
  const errorRate = logs.length > 0 ? (errorLines.length / logs.length) * 100 : 0;

  if (oomLines.length > 0) {
    issues.push({
      severity: "critical",
      category: "errors",
      title: "OOM kill events detected in logs",
      detail: `${container.name} logs show out-of-memory events. Latest: "${oomLines[oomLines.length - 1]?.slice(0, 140)}"`,
      remediation:
        "Container is being killed by the OOM killer. Increase the memory limit with set_resource_limits immediately.",
    });
  } else if (errorLines.length > 15 || errorRate > 30) {
    issues.push({
      severity: "critical",
      category: "errors",
      title: `High error rate in recent logs (${errorLines.length} of ${logs.length} lines)`,
      detail: `${container.name} has ${errorLines.length} error/fatal/panic lines in the last ${logs.length} log entries. Latest: "${errorLines[errorLines.length - 1]?.slice(0, 140)}"`,
      remediation:
        "Get full logs with get_container_logs and diagnose the root cause. Do not restart blindly — fix the underlying issue first.",
    });
  } else if (errorLines.length > 4) {
    issues.push({
      severity: "warning",
      category: "errors",
      title: `Elevated error count in logs (${errorLines.length} of ${logs.length} lines)`,
      detail: `${container.name} has ${errorLines.length} error-level log entries in the most recent ${logs.length} lines.`,
      remediation:
        "Use get_container_logs to review patterns. May be transient or caused by a dependency being temporarily unavailable.",
    });
  }
  return issues;
}

async function runResponseTimeCheck(data: ContainerData): Promise<HealthIssue[]> {
  const { container } = data;
  const issues: HealthIssue[] = [];

  const tcpPorts = container.ports
    .filter((p) => p.protocol === "tcp" && p.host > 0)
    .map((p) => p.host)
    .filter((p, i, arr) => arr.indexOf(p) === i)
    .slice(0, 2); // probe at most 2 ports to keep tool fast

  if (tcpPorts.length === 0) return issues;

  const probes = await Promise.allSettled(
    tcpPorts.map(async (port) => {
      const start = Date.now();
      try {
        const res = await fetch(`http://localhost:${port}/`, {
          signal: AbortSignal.timeout(6000),
        });
        return { port, latencyMs: Date.now() - start, statusCode: res.status, error: null };
      } catch (err: unknown) {
        return {
          port,
          latencyMs: Date.now() - start,
          statusCode: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  for (const result of probes) {
    if (result.status !== "fulfilled") continue;
    const { port, latencyMs, statusCode, error } = result.value;

    // Connection refused means nothing is listening — not a latency issue
    if (error?.includes("ECONNREFUSED")) continue;

    if (error && latencyMs >= 5900) {
      // Timed out
      issues.push({
        severity: "critical",
        category: "response_time",
        title: `Timeout on port ${port} (no response in 6s)`,
        detail: `${container.name} did not respond on port ${port} within 6 seconds. This indicates the service is hanging or severely overloaded.`,
        remediation:
          "Check CPU and memory stats. Restart the container if it is hung. Review logs for deadlocks or blocking operations.",
      });
    } else if (latencyMs > 3000) {
      issues.push({
        severity: "critical",
        category: "response_time",
        title: `Very slow response on port ${port} (${latencyMs}ms)`,
        detail: `${container.name} took ${latencyMs}ms to respond on port ${port}${statusCode ? ` (HTTP ${statusCode})` : ""}.`,
        remediation:
          "Service is severely degraded. Check CPU/memory, look for slow database queries, or consider restarting.",
      });
    } else if (latencyMs > 1500) {
      issues.push({
        severity: "warning",
        category: "response_time",
        title: `Slow response on port ${port} (${latencyMs}ms)`,
        detail: `${container.name} responded in ${latencyMs}ms on port ${port}${statusCode ? ` (HTTP ${statusCode})` : ""}.`,
        remediation: "Monitor for trend. High latency may indicate load, disk I/O bottlenecks, or an upstream dependency issue.",
      });
    }
  }
  return issues;
}

function runDependencyCheck(data: ContainerData, allContainers: Container[]): HealthIssue[] {
  const { inspect, container } = data;
  if (!inspect) return [];
  const issues: HealthIssue[] = [];

  const project = inspect.labels["com.docker.compose.project"];
  if (!project) return issues;

  const siblings = allContainers.filter(
    (c) => c.id !== container.id && c.labels["com.docker.compose.project"] === project,
  );

  const stopped = siblings.filter((c) => c.status !== "running");
  if (stopped.length === 0) return issues;

  const names = stopped.map((c) => `${c.name} (${c.status})`).join(", ");
  issues.push({
    severity: "warning",
    category: "dependencies",
    title: `${stopped.length} stack service(s) not running`,
    detail: `${container.name} is part of compose project '${project}', but ${stopped.length} sibling service(s) are not running: ${names}`,
    remediation: `Start the stopped services: ${stopped.map((c) => c.name).join(", ")}. Use start_container or restart_app for the affected app.`,
  });
  return issues;
}

function runDiskCheck(data: ContainerData, systemMounts: SystemMount[]): HealthIssue[] {
  const { inspect, container } = data;
  if (!inspect) return [];
  const issues: HealthIssue[] = [];

  // Check bind mounts and named volume paths (both have a host source path)
  const mountsToCheck = inspect.mounts.filter((m) => m.source && m.source.startsWith("/"));

  const seen = new Set<string>();

  for (const mount of mountsToCheck) {
    // Find the filesystem this mount's source lives on (longest matching prefix)
    const fs = systemMounts
      .filter((sm) => mount.source.startsWith(sm.mount))
      .sort((a, b) => b.mount.length - a.mount.length)[0];

    if (!fs || seen.has(fs.mount)) continue;
    seen.add(fs.mount);

    if (fs.percent > 92) {
      issues.push({
        severity: "critical",
        category: "disk",
        title: `Filesystem critically full — ${fs.percent}% used (${fs.mount})`,
        detail: `${container.name} volume '${mount.destination}' (host: ${mount.source}) is on '${fs.mount}' which is ${fs.percent}% full. Writes will fail soon.`,
        remediation:
          "Free space immediately: prune Docker images (docker image prune -a), remove old logs, or expand the volume/filesystem.",
      });
    } else if (fs.percent > 80) {
      issues.push({
        severity: "warning",
        category: "disk",
        title: `Filesystem running low — ${fs.percent}% used (${fs.mount})`,
        detail: `${container.name} volume '${mount.destination}' (host: ${mount.source}) is on '${fs.mount}' which is ${fs.percent}% full.`,
        remediation: "Plan disk expansion before reaching 90%. Consider pruning unused Docker images or archiving old data.",
      });
    }
  }
  return issues;
}

// ── Per-container analysis ────────────────────────────────────────────────────

async function analyzeContainer(
  data: ContainerData,
  checksToRun: Set<CheckType>,
  allContainers: Container[],
  systemMounts: SystemMount[],
): Promise<ContainerReport> {
  const { container, inspect, stats } = data;

  const checkResults = await Promise.allSettled([
    checksToRun.has("flapping") ? Promise.resolve(runFlappingCheck(data)) : Promise.resolve([]),
    checksToRun.has("startup") ? Promise.resolve(runStartupCheck(data)) : Promise.resolve([]),
    checksToRun.has("memory") ? Promise.resolve(runMemoryCheck(data)) : Promise.resolve([]),
    checksToRun.has("errors") ? Promise.resolve(runErrorsCheck(data)) : Promise.resolve([]),
    checksToRun.has("response_time") && container.status === "running"
      ? runResponseTimeCheck(data)
      : Promise.resolve([]),
    checksToRun.has("dependencies") ? Promise.resolve(runDependencyCheck(data, allContainers)) : Promise.resolve([]),
    checksToRun.has("disk") ? Promise.resolve(runDiskCheck(data, systemMounts)) : Promise.resolve([]),
  ]);

  const issues = checkResults
    .filter((r): r is PromiseFulfilledResult<HealthIssue[]> => r.status === "fulfilled")
    .flatMap((r) => r.value);

  const hasCritical = issues.some((i) => i.severity === "critical");
  const hasWarning = issues.some((i) => i.severity === "warning");
  const overallStatus: ContainerReport["overallStatus"] = hasCritical
    ? "critical"
    : hasWarning
      ? "degraded"
      : "healthy";

  const metrics: ContainerReport["metrics"] = {};
  if (stats) {
    metrics.cpuPercent = stats.cpuPercent;
    metrics.memoryUsageMb = stats.memoryUsageMb;
    metrics.memoryLimitMb = stats.memoryLimitMb;
    if (stats.memoryLimitMb > 0 && stats.memoryLimitMb <= 32768) {
      metrics.memoryPercent = Math.round((stats.memoryUsageMb / stats.memoryLimitMb) * 1000) / 10;
    }
  }
  if (inspect) {
    metrics.restartCount = inspect.restartCount;
  }

  return { containerId: container.id, name: container.name, overallStatus, issues, metrics };
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const analyzeServiceHealthTool = tool({
  description: `Run a comprehensive health scan across one or more containers, detecting:
- **Flapping**: services caught in crash loops or with a high restart count
- **Memory leaks**: containers approaching or exceeding their memory limit
- **Error rate spikes**: logs with high concentrations of error/fatal/panic lines, including OOM kills
- **Response time degradation**: HTTP probing of exposed ports to detect slow or hanging services
- **Dependency failures**: stopped siblings within the same Docker Compose stack
- **Disk pressure**: volumes on filesystems that are nearly or critically full
- **Startup anomalies**: containers stuck in 'created' state or that recently crashed on startup

Returns a structured per-container report sorted by severity with actionable remediation for each issue.

After calling: Lead with the overall verdict (e.g. "2 containers are critical, 1 degraded, 8 healthy."). For each problem container, name it, state the issue, and give the top remediation action. Offer to execute fixes (restart, increase limits, check logs) directly.`,
  inputSchema: z.object({
    containerIds: z
      .array(z.string())
      .optional()
      .describe(
        "Specific container IDs or names to scan. Omit to scan all containers (running and stopped).",
      ),
    checks: z
      .array(z.enum(CHECK_TYPES))
      .optional()
      .describe(
        "Subset of checks to run. Omit to run all: flapping, memory, errors, response_time, dependencies, disk, startup.",
      ),
  }),
  execute: async ({ containerIds, checks }) => {
    // ── Gather baseline data in parallel ──────────────────────────────────────
    const [allContainers, systemStats] = await Promise.all([
      listContainers(),
      getSystemStats(),
    ]);

    const targets = containerIds?.length
      ? allContainers.filter(
          (c) => containerIds.includes(c.id) || containerIds.includes(c.name),
        )
      : allContainers;

    if (targets.length === 0) {
      return {
        success: false,
        error: containerIds?.length
          ? `No containers found matching: ${containerIds.join(", ")}`
          : "No containers found.",
      };
    }

    const checksToRun = new Set<CheckType>(checks?.length ? checks : CHECK_TYPES);

    // Flatten disk mounts for the disk check
    const systemMounts: SystemMount[] = (systemStats.disk.mounts ?? []).map((m: any) => ({
      mount: m.mount as string,
      percent: m.percent as number,
      usedBytes: m.usedBytes as number,
      totalBytes: m.totalBytes as number,
    }));

    // ── Fetch per-container data concurrently ─────────────────────────────────
    const containerDataResults = await Promise.allSettled(
      targets.map((c) => fetchContainerData(c)),
    );

    const containerDataList = containerDataResults
      .filter((r): r is PromiseFulfilledResult<ContainerData> => r.status === "fulfilled")
      .map((r) => r.value);

    // ── Analyse each container ────────────────────────────────────────────────
    const reports = await Promise.all(
      containerDataList.map((data) =>
        analyzeContainer(data, checksToRun, allContainers, systemMounts),
      ),
    );

    // Sort: critical → degraded → healthy
    const statusOrder = { critical: 0, degraded: 1, healthy: 2 } as const;
    reports.sort((a, b) => statusOrder[a.overallStatus] - statusOrder[b.overallStatus]);

    const criticalCount = reports.filter((r) => r.overallStatus === "critical").length;
    const degradedCount = reports.filter((r) => r.overallStatus === "degraded").length;
    const healthyCount = reports.filter((r) => r.overallStatus === "healthy").length;
    const overallStatus = criticalCount > 0 ? "critical" : degradedCount > 0 ? "degraded" : "healthy";

    const checksRun = [...checksToRun];

    return {
      success: true,
      scannedAt: new Date().toISOString(),
      checksRun,
      summary: {
        total: reports.length,
        critical: criticalCount,
        degraded: degradedCount,
        healthy: healthyCount,
        overallStatus,
      },
      reports,
    };
  },
});
