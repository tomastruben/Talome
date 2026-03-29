/**
 * Library Optimization API — analyze, queue, track, and manage media file conversions.
 */

import { Hono } from "hono";
import { createLogger } from "../utils/logger.js";
import {
  analyzeFile,
  queueOptimization,
  prioritizeJob,
  forceStartJob,
  cancelJob,
  listJobs,
  getJob,
  deleteJob,
  getOptimizationConfig,
  updateOptimizationConfig,
  startAutoOptimize,
  stopAutoOptimize,
  scanAndQueue,
  isAlreadyOptimized,
  getLibraryHealth,
  getScanEntriesByBasenames,
  reprocessFailedJobs,
} from "../media/optimizer.js";
import { hasFfmpeg } from "./files.js";
import { resolveMediaFilePath } from "../utils/media-paths.js";
import type { OptimizationConfig } from "@talome/types";
import { statSync } from "node:fs";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";

const log = createLogger("optimization");

export const optimization = new Hono();

// Allowed roots for security (reuse the same logic as files.ts)
// For now, accept any path that exists — the optimizer only reads/writes media files
function validatePath(path: string): boolean {
  try { statSync(path); return true; } catch { return false; }
}

// ── POST /analyze — probe a file and determine if optimization is needed ──

optimization.post("/analyze", async (c) => {
  const body = await c.req.json<{ path: string }>().catch(() => ({ path: "" }));
  if (!body.path) return c.json({ error: "path required" }, 400);
  if (!hasFfmpeg()) return c.json({ error: "ffmpeg not available" }, 500);

  // Resolve container path → host path if needed
  let resolvedPath = body.path;
  if (!validatePath(resolvedPath)) {
    const hostPath = await resolveMediaFilePath(resolvedPath);
    if (!hostPath) return c.json({ error: "File not found" }, 404);
    resolvedPath = hostPath;
  }

  const analysis = analyzeFile(resolvedPath);
  return c.json(analysis);
});

// ── POST /queue — queue file(s) for conversion ────────────────────────────

optimization.post("/queue", async (c) => {
  const body = await c.req.json<{ paths: string[]; keepOriginal?: boolean; priority?: number }>().catch(() => ({ paths: [] as string[], keepOriginal: undefined as boolean | undefined, priority: undefined as number | undefined }));
  if (!body.paths || body.paths.length === 0) return c.json({ error: "paths required" }, 400);
  if (!hasFfmpeg()) return c.json({ error: "ffmpeg not available" }, 500);

  const keepOrig = body.keepOriginal;
  const priority = body.priority;

  // Resolve container paths → host paths (frontend sends Radarr/Sonarr container paths)
  const resolved: string[] = [];
  for (const p of body.paths) {
    if (validatePath(p)) {
      resolved.push(p);
    } else {
      const hostPath = await resolveMediaFilePath(p);
      if (hostPath) resolved.push(hostPath);
    }
  }

  const opts: { keepOriginal?: boolean; priority?: number } = {};
  if (keepOrig != null) opts.keepOriginal = keepOrig;
  if (priority != null) opts.priority = priority;

  const jobs = resolved.map((p) => ({
    id: queueOptimization(p, Object.keys(opts).length > 0 ? opts : undefined),
    sourcePath: p,
  }));

  return c.json({ jobs });
});

// ── GET /jobs — list jobs with optional status filter ──────────────────────

optimization.get("/jobs", (c) => {
  const status = c.req.query("status");
  const jobs = listJobs(status ? { status } : undefined);
  return c.json({ jobs });
});

// ── GET /jobs/:id — single job detail ─────────────────────────────────────

optimization.get("/jobs/:id", (c) => {
  const job = getJob(c.req.param("id"));
  if (!job) return c.json({ error: "Not found" }, 404);
  return c.json(job);
});

// ── POST /jobs/:id/prioritize — move a queued job to the front ────────────

optimization.post("/jobs/:id/prioritize", (c) => {
  const ok = prioritizeJob(c.req.param("id"));
  if (!ok) return c.json({ error: "Job not found or not queued" }, 404);
  return c.json({ ok: true });
});

// ── POST /jobs/:id/start — force-start a queued job immediately ──────────

optimization.post("/jobs/:id/start", (c) => {
  const ok = forceStartJob(c.req.param("id"));
  if (!ok) return c.json({ error: "Job not found or not queued" }, 404);
  return c.json({ ok: true });
});

// ── POST /jobs/:id/cancel — cancel a running or queued job ────────────────

optimization.post("/jobs/:id/cancel", (c) => {
  cancelJob(c.req.param("id"));
  return c.json({ ok: true });
});

// ── DELETE /jobs/:id — remove a completed/failed job from history ─────────

optimization.delete("/jobs/:id", (c) => {
  deleteJob(c.req.param("id"));
  return c.json({ ok: true });
});

// ── POST /scan — scan a directory, return counts (skips already-optimized) ──

optimization.post("/scan", async (c) => {
  const body = await c.req.json().catch((err) => { log.debug("scan body parse failed", err); return {}; }) as { path?: string; paths?: string[]; queueJobs?: boolean };
  const paths = body.paths ?? (body.path ? [body.path] : []);
  if (paths.length === 0) return c.json({ error: "path or paths required" }, 400);
  if (!hasFfmpeg()) return c.json({ error: "ffmpeg not available" }, 500);

  try {
    let totalScanned = 0, totalQueued = 0, totalSkipped = 0;
    const totalBreakdown = { transmux: 0, audioReencode: 0, fullTranscode: 0 };
    const shouldQueue = body.queueJobs !== false;

    for (const p of paths) {
      const result = await scanAndQueue(p, shouldQueue);
      totalScanned += result.scanned;
      totalQueued += result.queued;
      totalSkipped += result.skipped;
      totalBreakdown.transmux += result.breakdown.transmux;
      totalBreakdown.audioReencode += result.breakdown.audioReencode;
      totalBreakdown.fullTranscode += result.breakdown.fullTranscode;
    }

    return c.json({
      scanned: totalScanned,
      queued: totalQueued,
      skipped: totalSkipped,
      breakdown: totalBreakdown,
      lastScanAt: new Date().toISOString(),
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Scan failed" }, 500);
  }
});

// ── GET /health — library health summary from persistent scan cache ───────

optimization.get("/health", async (c) => {
  const type = c.req.query("type") as "movies" | "tv" | undefined;
  if (type === "movies" || type === "tv") {
    // Filter health by directories that fall under tagged root paths
    const { getTaggedMediaRootPaths } = await import("../utils/media-paths.js");
    const tagged = await getTaggedMediaRootPaths();
    const roots = tagged.filter((t) => t.source === type).map((t) => t.path);
    return c.json(getLibraryHealth(roots));
  }
  return c.json(getLibraryHealth());
});

// ── GET /scan-paths — get media root folders from Radarr/Sonarr ───────────

optimization.get("/scan-paths", async (c) => {
  try {
    const { getTaggedMediaRootPaths } = await import("../utils/media-paths.js");
    const tagged = await getTaggedMediaRootPaths();
    // Return both tagged and flat paths for backwards compat
    return c.json({ paths: tagged.map((t) => t.path), tagged });
  } catch {
    return c.json({ paths: [], tagged: [] });
  }
});

// ── POST /scan-status — get scan entries for specific file basenames ───────

optimization.post("/scan-status", async (c) => {
  const body = await c.req.json<{ basenames: string[] }>().catch(() => ({ basenames: [] }));
  if (!body.basenames?.length) return c.json({ entries: {} });
  return c.json({ entries: getScanEntriesByBasenames(body.basenames) });
});

// ── POST /reprocess-failed — clear and re-queue failed jobs ────────────────

optimization.post("/reprocess-failed", async (c) => {
  const body = await c.req.json().catch((err) => { log.debug("reprocess body parse failed", err); return {}; }) as { errorPattern?: string };
  const result = reprocessFailedJobs(body.errorPattern);
  return c.json(result);
});

// ── GET /hdr-audit — find incorrectly converted HDR files ────────────────

optimization.get("/hdr-audit", async (c) => {
  const { execSync } = await import("node:child_process");
  const completed = db
    .select()
    .from(schema.optimizationJobs)
    .where(eq(schema.optimizationJobs.status, "completed"))
    .all();

  const incorrect: Array<{ id: string; file: string; codec: string; transfer: string }> = [];

  for (const job of completed) {
    if (!job.targetPath) continue;
    try {
      const out = execSync(
        `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,pix_fmt,color_transfer -print_format json "${job.targetPath}"`,
        { timeout: 5000 },
      ).toString();
      const data = JSON.parse(out);
      const s = data.streams?.[0];
      if (!s) continue;
      // H.264 output from an HDR source → incorrectly transcoded (should have been remuxed as HEVC)
      if (s.codec_name === "h264" && (s.color_transfer === "smpte2084" || s.color_transfer === "arib-std-b67" || s.pix_fmt?.includes("10"))) {
        incorrect.push({ id: job.id, file: job.targetPath.split("/").pop() ?? "", codec: s.codec_name, transfer: s.color_transfer ?? "" });
      }
      // HEVC but 10-bit with HDR that was just copied — check if player can handle it
      // These are fine now (player routes to HLS), but flag them for user awareness
    } catch { /* file not found or probe failed */ }
  }

  return c.json({ count: incorrect.length, files: incorrect });
});

// ── GET /config — get optimization settings ───────────────────────────────

optimization.get("/config", (c) => {
  return c.json(getOptimizationConfig());
});

// ── POST /config — update optimization settings ───────────────────────────

optimization.post("/config", async (c) => {
  const body = await c.req.json<Partial<OptimizationConfig>>().catch((err) => { log.debug("config body parse failed", err); return {}; });
  updateOptimizationConfig(body);

  // Toggle auto-optimize
  const config = getOptimizationConfig();
  if (config.autoOptimize) startAutoOptimize();
  else stopAutoOptimize();

  return c.json({ ok: true });
});
