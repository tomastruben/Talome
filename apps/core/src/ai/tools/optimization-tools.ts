import { tool } from "ai";
import { z } from "zod";
import {
  analyzeFile,
  queueOptimization,
  cancelJob,
  listJobs,
  getOptimizationConfig,
  updateOptimizationConfig,
  scanAndQueue,
  getLibraryHealth,
  startAutoOptimize,
  stopAutoOptimize,
  reprocessFailedJobs,
} from "../../media/optimizer.js";
import { hasFfmpeg } from "../../routes/files.js";
import { resolveMediaFilePath } from "../../utils/media-paths.js";
import { getSystemStats } from "../../docker/client.js";
import { db } from "../../db/index.js";
import * as schema from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { statSync } from "node:fs";

function validatePath(path: string): boolean {
  try { statSync(path); return true; } catch { return false; }
}

export const analyzeMediaFileTool = tool({
  description: "Analyze a media file to determine if it needs optimization. Returns codec info, container format, and whether conversion is needed. Accepts both host paths and Radarr/Sonarr container paths.",
  inputSchema: z.object({
    path: z.string().describe("Path to the media file to analyze"),
  }),
  execute: async ({ path }) => {
    if (!hasFfmpeg()) return { error: "ffmpeg not available" };
    let resolvedPath = path;
    if (!validatePath(resolvedPath)) {
      const hostPath = await resolveMediaFilePath(resolvedPath);
      if (!hostPath) return { error: "File not found" };
      resolvedPath = hostPath;
    }
    const analysis = analyzeFile(resolvedPath);
    return { path: resolvedPath, ...analysis };
  },
});

export const scanLibraryTool = tool({
  description: "Scan media directories for files that need optimization. Persists results for fast future lookups. By default queues files for conversion — set queueJobs=false to scan only without queuing. Returns count breakdown (remux/audio/full transcode).",
  inputSchema: z.object({
    paths: z.array(z.string()).describe("Directories to scan (e.g. ['/Volumes/Media Vault/Media/Movies', '/Volumes/Media Vault/Media/TV Shows'])"),
    queueJobs: z.boolean().default(true).describe("Whether to queue found files for conversion (default: true)"),
  }),
  execute: async ({ paths, queueJobs }) => {
    if (!hasFfmpeg()) return { error: "ffmpeg not available" };
    let totalScanned = 0, totalQueued = 0, totalSkipped = 0;
    const totalBreakdown = { transmux: 0, audioReencode: 0, fullTranscode: 0 };
    for (const p of paths) {
      if (!validatePath(p)) continue;
      const result = await scanAndQueue(p, queueJobs);
      totalScanned += result.scanned;
      totalQueued += result.queued;
      totalSkipped += result.skipped;
      totalBreakdown.transmux += result.breakdown.transmux;
      totalBreakdown.audioReencode += result.breakdown.audioReencode;
      totalBreakdown.fullTranscode += result.breakdown.fullTranscode;
    }
    return { scanned: totalScanned, queued: totalQueued, skipped: totalSkipped, breakdown: totalBreakdown };
  },
});

export const getOptimizationStatusTool = tool({
  description: "Get the status of optimization jobs. Filter by status (running, queued, completed, failed, cancelled) or get all jobs.",
  inputSchema: z.object({
    status: z.string().optional().describe("Filter by status (comma-separated): running, queued, completed, failed, cancelled"),
  }),
  execute: async ({ status }) => {
    const jobs = listJobs(status ? { status } : undefined);
    const running = jobs.filter(j => j.status === "running");
    const queued = jobs.filter(j => j.status === "queued");
    const completed = jobs.filter(j => j.status === "completed");
    const failed = jobs.filter(j => j.status === "failed");
    return {
      summary: { running: running.length, queued: queued.length, completed: completed.length, failed: failed.length },
      jobs: jobs.slice(0, 20).map(j => ({
        id: j.id,
        file: j.sourcePath.split("/").pop(),
        status: j.status,
        progress: j.status === "running" ? Math.round(j.progress * 100) + "%" : undefined,
        error: j.error || undefined,
        aiDiagnosis: j.aiDiagnosis || undefined,
      })),
    };
  },
});

export const queueOptimizationTool = tool({
  description: "Queue specific media file(s) for optimization. Accepts host paths or Radarr/Sonarr container paths.",
  inputSchema: z.object({
    paths: z.array(z.string()).describe("File paths to optimize"),
    keepOriginal: z.boolean().default(true).describe("Keep original file after conversion"),
    priority: z.number().default(10).describe("Job priority (10+ bypasses pause, default 10)"),
  }),
  execute: async ({ paths, keepOriginal, priority }) => {
    if (!hasFfmpeg()) return { error: "ffmpeg not available" };
    const results: Array<{ path: string; jobId: string }> = [];
    for (const p of paths) {
      let resolvedPath = p;
      if (!validatePath(resolvedPath)) {
        const hostPath = await resolveMediaFilePath(resolvedPath);
        if (!hostPath) continue;
        resolvedPath = hostPath;
      }
      const id = queueOptimization(resolvedPath, { keepOriginal, priority });
      if (id) results.push({ path: resolvedPath, jobId: id });
    }
    return { queued: results.length, jobs: results };
  },
});

export const cancelOptimizationTool = tool({
  description: "Cancel a running or queued optimization job.",
  inputSchema: z.object({
    jobId: z.string().describe("The job ID to cancel"),
  }),
  execute: async ({ jobId }) => {
    cancelJob(jobId);
    return { ok: true, cancelled: jobId };
  },
});

export const getOptimizationConfigTool = tool({
  description: "Get or update the library optimization configuration (maxConcurrentJobs, keepOriginals, autoOptimize).",
  inputSchema: z.object({
    action: z.enum(["get", "set"]).default("get").describe("'get' to read config, 'set' to update"),
    maxConcurrentJobs: z.number().min(1).max(4).optional().describe("Max concurrent conversion jobs (1-4)"),
    keepOriginals: z.boolean().optional().describe("Keep original files after conversion"),
    autoOptimize: z.boolean().optional().describe("Auto-optimize new downloads periodically"),
  }),
  execute: async ({ action, maxConcurrentJobs, keepOriginals, autoOptimize }) => {
    if (action === "set") {
      const patch: Record<string, unknown> = {};
      if (maxConcurrentJobs !== undefined) patch.maxConcurrentJobs = maxConcurrentJobs;
      if (keepOriginals !== undefined) patch.keepOriginals = keepOriginals;
      if (autoOptimize !== undefined) patch.autoOptimize = autoOptimize;
      updateOptimizationConfig(patch);
      const config = getOptimizationConfig();
      if (config.autoOptimize) startAutoOptimize();
      else stopAutoOptimize();
    }
    return getOptimizationConfig();
  },
});

export const getLibraryHealthTool = tool({
  description: "Get a health summary of the media library — how many files are optimal, need conversion, breakdown by type (remux/audio/transcode), total size, and when the last scan was run.",
  inputSchema: z.object({}),
  execute: async () => {
    const health = getLibraryHealth();
    return {
      ...health,
      totalSizeFormatted: formatBytes(health.totalSizeBytes),
    };
  },
});

export const reprocessFailedJobsTool = tool({
  description: "Clear failed optimization jobs and re-queue them for processing. Optionally filter by error pattern (e.g., 'Invalid argument'). Skips files already converted or deleted.",
  inputSchema: z.object({
    errorPattern: z.string().optional().describe("Only reprocess jobs whose error contains this string"),
  }),
  execute: async ({ errorPattern }) => {
    return reprocessFailedJobs(errorPattern);
  },
});

export const diagnoseOptimizationFailuresTool = tool({
  description: "Diagnose failed media optimization jobs. Returns errors, AI diagnoses, disk health, and recommended fixes.",
  inputSchema: z.object({
    limit: z.number().min(1).max(50).default(10).describe("Max number of failed jobs to return (default: 10)"),
  }),
  execute: async ({ limit }) => {
    // 1. Query failed jobs with their error and aiDiagnosis fields
    const failedJobs = db.select()
      .from(schema.optimizationJobs)
      .where(eq(schema.optimizationJobs.status, "failed"))
      .orderBy(schema.optimizationJobs.createdAt)
      .limit(limit)
      .all();

    // 2. Aggregate top error patterns
    const errorCounts = new Map<string, number>();
    for (const job of failedJobs) {
      if (!job.error) continue;
      // Normalize error strings to group similar errors
      const normalized = job.error
        .replace(/\/[^\s:]+/g, "<path>")       // strip file paths
        .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}[^\s]*/g, "<timestamp>")
        .slice(0, 120);
      errorCounts.set(normalized, (errorCounts.get(normalized) ?? 0) + 1);
    }
    const topErrors = [...errorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([pattern, count]) => ({ pattern, count }));

    // 3. Check disk space on media volumes
    let diskStatus: Array<{ mount: string; usedPercent: number; freeGb: number }> = [];
    try {
      const stats = await getSystemStats();
      diskStatus = stats.disk.mounts
        .filter(m => m.type === "external" || m.type === "internal")
        .map(m => ({
          mount: m.mount,
          usedPercent: Math.round(m.percent),
          freeGb: Math.round((m.totalBytes - m.usedBytes) / (1024 * 1024 * 1024) * 10) / 10,
        }));
    } catch {
      // Non-fatal — disk check may not be available
    }

    // 4. Build recommended actions
    const recommendations: string[] = [];
    const hasVolumeErrors = failedJobs.some(j => j.error?.includes("volume") || j.error?.includes("Permission") || j.error?.includes("Read-only"));
    const hasDiskFullErrors = failedJobs.some(j => j.error?.includes("No space") || j.error?.includes("disk full"));
    const hasEncoderErrors = failedJobs.some(j => j.error?.includes("encoder") || j.error?.includes("Invalid argument") || j.error?.includes("VideoToolbox"));
    const lowDisk = diskStatus.some(d => d.freeGb < 10);

    if (hasDiskFullErrors || lowDisk) {
      recommendations.push("Free up disk space or change optimization output directory — some volumes are critically low.");
    }
    if (hasVolumeErrors) {
      recommendations.push("Check volume mount permissions — some jobs failed due to filesystem or permission errors.");
    }
    if (hasEncoderErrors) {
      recommendations.push("Consider switching to software encoding (libx264) if hardware encoder is unstable.");
    }
    if (failedJobs.length > 10) {
      recommendations.push(`${failedJobs.length} failed jobs total. Use reprocess_failed_jobs to clear and re-queue after fixing underlying issues.`);
    }
    if (recommendations.length === 0 && failedJobs.length > 0) {
      recommendations.push("Review individual AI diagnoses for file-specific issues. Some files may be corrupt or unsupported.");
    }

    return {
      failedJobCount: failedJobs.length,
      jobs: failedJobs.slice(0, limit).map(j => ({
        id: j.id,
        file: j.sourcePath.split("/").pop(),
        sourcePath: j.sourcePath,
        error: j.error || undefined,
        aiDiagnosis: j.aiDiagnosis || undefined,
        retryCount: j.retryCount,
        retryStrategy: j.retryStrategy || undefined,
        createdAt: j.createdAt,
      })),
      topErrors,
      diskStatus,
      recommendations,
    };
  },
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}
