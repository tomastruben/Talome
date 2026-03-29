import { Hono } from "hono";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";

export const metrics = new Hono();

interface MetricRow {
  timestamp: string;
  cpu: number;
  memory_used: number;
  memory_total: number;
  disk_used: number;
  disk_total: number;
  network_rx: number;
  network_tx: number;
}

const RANGE_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

metrics.get("/", (c) => {
  const range = (c.req.query("range") ?? "24h") as string;
  const rangeMs = RANGE_MS[range] ?? RANGE_MS["24h"];
  const since = new Date(Date.now() - rangeMs).toISOString();

  // For 7d range, downsample to 5-minute buckets
  if (range === "7d") {
    const rows = db.all(sql`
      SELECT
        strftime('%Y-%m-%dT%H:', timestamp) || printf('%02d', (CAST(strftime('%M', timestamp) AS INTEGER) / 5) * 5) || ':00.000Z' as timestamp,
        ROUND(AVG(cpu), 1) as cpu,
        CAST(AVG(memory_used) AS INTEGER) as memory_used,
        CAST(AVG(memory_total) AS INTEGER) as memory_total,
        CAST(AVG(disk_used) AS INTEGER) as disk_used,
        CAST(AVG(disk_total) AS INTEGER) as disk_total,
        CAST(AVG(network_rx) AS INTEGER) as network_rx,
        CAST(AVG(network_tx) AS INTEGER) as network_tx
      FROM metrics
      WHERE timestamp >= ${since}
      GROUP BY strftime('%Y-%m-%dT%H:', timestamp) || printf('%02d', (CAST(strftime('%M', timestamp) AS INTEGER) / 5) * 5)
      ORDER BY timestamp ASC
    `) as MetricRow[];

    return c.json(rows);
  }

  const rows = db.all(sql`
    SELECT timestamp, cpu, memory_used, memory_total, disk_used, disk_total, network_rx, network_tx
    FROM metrics
    WHERE timestamp >= ${since}
    ORDER BY timestamp ASC
  `) as MetricRow[];

  return c.json(rows);
});
