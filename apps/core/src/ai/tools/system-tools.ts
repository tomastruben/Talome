import { tool } from "ai";
import { z } from "zod";
import { getSystemStats } from "../../docker/client.js";
import { listContainers } from "../../docker/client.js";
import { db } from "../../db/index.js";
import { sql } from "drizzle-orm";

export const getSystemStatsTool = tool({
  description: "Get current system statistics including CPU, memory, disk, and network usage",
  inputSchema: z.object({}),
  execute: async () => {
    const stats = await getSystemStats();
    return stats;
  },
});

export const getDiskUsageTool = tool({
  description: "Get detailed disk usage information per mount point",
  inputSchema: z.object({}),
  execute: async () => {
    const stats = await getSystemStats();
    return {
      total: {
        usedBytes: stats.disk.usedBytes,
        totalBytes: stats.disk.totalBytes,
        percent: stats.disk.percent,
      },
      mounts: stats.disk.mounts,
    };
  },
});

export const getSystemHealthTool = tool({
  description:
    "Check the health of Talome core services: database connectivity, Docker daemon availability, and process uptime. Use this when the user asks if the server is healthy or why something isn't working.",
  inputSchema: z.object({}),
  execute: async () => {
    const checks: Record<string, "ok" | "error"> = {};

    try {
      db.get(sql`SELECT 1`);
      checks.db = "ok";
    } catch {
      checks.db = "error";
    }

    try {
      await listContainers();
      checks.docker = "ok";
    } catch {
      checks.docker = "error";
    }

    const healthy = Object.values(checks).every((v) => v === "ok");
    return {
      status: healthy ? "ok" : "degraded",
      checks,
      uptime: process.uptime(),
      uptimeHuman: formatUptime(process.uptime()),
    };
  },
});

export const getMetricsHistoryTool = tool({
  description:
    "Get historical system metrics (CPU, memory, disk, network) over a time range. Use this when the user asks about trends, history, or past performance.",
  inputSchema: z.object({
    range: z
      .enum(["1h", "6h", "24h", "7d"])
      .default("24h")
      .describe("Time range to query"),
    metric: z
      .enum(["cpu", "memory", "disk", "network", "all"])
      .default("all")
      .describe("Which metric to return"),
  }),
  execute: async ({ range, metric }) => {
    const rangeMs: Record<string, number> = {
      "1h": 3600000,
      "6h": 21600000,
      "24h": 86400000,
      "7d": 604800000,
    };
    const since = new Date(Date.now() - (rangeMs[range] ?? 86400000)).toISOString();
    const rows = db.all(sql`
      SELECT timestamp, cpu, memory_used, memory_total, disk_used, disk_total, network_rx, network_tx
      FROM metrics WHERE timestamp >= ${since} ORDER BY timestamp ASC
    `) as { timestamp: string; cpu: number; memory_used: number; memory_total: number; disk_used: number; disk_total: number; network_rx: number; network_tx: number }[];

    if (rows.length === 0) return { message: "No metrics data available for this range. Metrics are collected every 60 seconds.", points: [] };

    const format = (r: typeof rows[0]) => {
      const point: Record<string, unknown> = { timestamp: r.timestamp };
      if (metric === "all" || metric === "cpu") point.cpu = r.cpu;
      if (metric === "all" || metric === "memory") {
        point.memoryUsedMB = Math.round(r.memory_used / 1048576);
        point.memoryTotalMB = Math.round(r.memory_total / 1048576);
        point.memoryPercent = Math.round((r.memory_used / r.memory_total) * 1000) / 10;
      }
      if (metric === "all" || metric === "disk") {
        point.diskUsedGB = Math.round(r.disk_used / 1073741824 * 10) / 10;
        point.diskTotalGB = Math.round(r.disk_total / 1073741824 * 10) / 10;
        point.diskPercent = r.disk_total > 0 ? Math.round((r.disk_used / r.disk_total) * 1000) / 10 : 0;
      }
      if (metric === "all" || metric === "network") {
        point.networkRxKBps = Math.round(r.network_rx / 1024);
        point.networkTxKBps = Math.round(r.network_tx / 1024);
      }
      return point;
    };

    return {
      range,
      pointCount: rows.length,
      points: rows.map(format),
    };
  },
});

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  return parts.length > 0 ? parts.join(" ") : "< 1m";
}
