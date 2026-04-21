/**
 * Media Library Optimizer — converts media files to the most compatible format
 * (H.264 + AAC in MP4) for instant browser playback on all devices.
 *
 * Features:
 * - Analyze files to determine if optimization is needed
 * - Queue single or batch conversions
 * - Progress tracking via ffmpeg stderr parsing
 * - Hardware acceleration (VideoToolbox on macOS)
 * - Atomic file operations (write .tmp, rename on completion)
 * - Auto-optimize mode with periodic scanning
 */

import { spawn, execSync, execFile, type ChildProcess } from "node:child_process";
import { stat, unlink, rename, mkdir, readdir } from "node:fs/promises";
import { existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join, extname, basename } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { probeFile, hasFfmpeg } from "../routes/files.js";
import { writeNotification } from "../db/notifications.js";
import { hostToContainerPath, getArrMounts } from "../utils/media-paths.js";
import { createLogger } from "../utils/logger.js";
import { getSetting } from "../utils/settings.js";

const log = createLogger("optimizer");
import type { OptimizationConfig, FileAnalysis, OptimizationJob, ScanResult, LibraryHealthSummary } from "@talome/types";

// ── Settings helpers ───────────────────────────────────────────────────────

/** Cached tagged media root paths (populated by autoScan or lazily on first queue). */
let cachedTaggedPaths: Array<{ path: string; source: string }> = [];
let taggedPathsCacheTime = 0;
const TAGGED_PATHS_STALE_MS = 5 * 60 * 1000; // 5 minutes

/** Refresh the tagged paths cache from Radarr/Sonarr root folders. */
let taggedPathsPromise: Promise<void> | null = null;

async function refreshTaggedPathsCache(): Promise<void> {
  try {
    const { getTaggedMediaRootPaths } = await import("../utils/media-paths.js");
    cachedTaggedPaths = await getTaggedMediaRootPaths();
    taggedPathsCacheTime = Date.now();
  } catch { /* ignore */ }
}

// Eagerly populate on module load (non-blocking)
taggedPathsPromise = refreshTaggedPathsCache();

/** Await initial cache load + refresh if stale. Call before scan operations. */
export async function ensureMediaTypeCache(): Promise<void> {
  if (taggedPathsPromise) await taggedPathsPromise;
  if (Date.now() - taggedPathsCacheTime > TAGGED_PATHS_STALE_MS) {
    taggedPathsPromise = refreshTaggedPathsCache();
    await taggedPathsPromise;
  }
}

/** Check if a file path belongs to the allowed media type (movies/tv/all). */
function matchesMediaTypeFilter(filePath: string, mediaTypes: string): boolean {
  if (mediaTypes === "all") return true;
  if (cachedTaggedPaths.length === 0) {
    // Cache not loaded yet and filter is active — deny by default to prevent
    // wrong media types leaking through during startup race window
    log.info(`Media type filter "${mediaTypes}" active but no tagged paths cached — skipping ${basename(filePath)}`);
    return false;
  }
  return cachedTaggedPaths
    .filter((t) => t.source === mediaTypes)
    .some((t) => filePath.startsWith(t.path));
}

export function getOptimizationConfig(): OptimizationConfig {
  const mediaTypes = getSetting("optimization_media_types");
  return {
    maxConcurrentJobs: parseInt(getSetting("optimization_max_jobs") ?? "1", 10),
    keepOriginals: getSetting("optimization_keep_originals") !== "false",
    autoOptimize: getSetting("optimization_auto_optimize") === "true",
    paused: getSetting("optimization_paused") === "true",
    mediaTypes: (mediaTypes === "movies" || mediaTypes === "tv") ? mediaTypes : "all",
  };
}

export function updateOptimizationConfig(patch: Partial<OptimizationConfig>): void {
  const keyMap: Record<string, string> = {
    maxConcurrentJobs: "optimization_max_jobs",
    keepOriginals: "optimization_keep_originals",
    autoOptimize: "optimization_auto_optimize",
    paused: "optimization_paused",
    mediaTypes: "optimization_media_types",
  };
  for (const [k, v] of Object.entries(patch)) {
    const dbKey = keyMap[k];
    if (!dbKey) continue;
    const val = String(v);
    db.run(sql`INSERT INTO settings (key, value) VALUES (${dbKey}, ${val})
               ON CONFLICT(key) DO UPDATE SET value = ${val}`);
  }
  // Kick the queue — unpausing or changing concurrency should start processing
  scheduleProcessQueue();
}

// ── Radarr/Sonarr rescan after conversion ───────────────────────────────────

async function triggerArrRescan(hostPath: string, sourcePath: string): Promise<void> {
  try {
    const mounts = await getArrMounts();

    // Match by directory basename (e.g. "A.I. Artificial Intelligence (2001)")
    // This works even when the movie is tracked under a different root folder
    const sourceDir = sourcePath.substring(0, sourcePath.lastIndexOf("/"));
    const dirBasename = sourceDir.substring(sourceDir.lastIndexOf("/") + 1).toLowerCase();

    const arrApps = [
      { service: "radarr", settingKey: "radarr_url", apiKeyKey: "radarr_api_key" },
      { service: "sonarr", settingKey: "sonarr_url", apiKeyKey: "sonarr_api_key" },
    ];

    for (const app of arrApps) {
      const baseUrl = getSetting(app.settingKey);
      const apiKey = getSetting(app.apiKeyKey);
      if (!baseUrl || !apiKey) continue;

      try {
        if (app.service === "radarr") {
          const res = await fetch(`${baseUrl}/api/v3/movie`, {
            headers: { "X-Api-Key": apiKey },
          });
          if (!res.ok) continue;
          const movies = (await res.json()) as Array<{ id: number; path: string; movieFile?: { relativePath?: string } }>;

          // Try container path match first, fall back to directory basename match
          const containerPath = hostToContainerPath(hostPath, mounts);
          const containerDir = containerPath?.substring(0, containerPath.lastIndexOf("/"));
          const movie = movies.find((m) =>
            (containerDir && containerDir.startsWith(m.path)) ||
            m.path.toLowerCase().endsWith("/" + dirBasename)
          );

          if (movie) {
            await fetch(`${baseUrl}/api/v3/command`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
              body: JSON.stringify({ name: "RescanMovie", movieId: movie.id }),
            });
            log.info(`Triggered Radarr rescan for movie ${movie.id}`);
          }
        } else {
          const res = await fetch(`${baseUrl}/api/v3/series`, {
            headers: { "X-Api-Key": apiKey },
          });
          if (!res.ok) continue;
          const series = (await res.json()) as Array<{ id: number; path: string }>;

          const containerPath = hostToContainerPath(hostPath, mounts);
          const containerDir = containerPath?.substring(0, containerPath.lastIndexOf("/"));
          const show = series.find((s) =>
            (containerDir && containerDir.startsWith(s.path)) ||
            s.path.toLowerCase().endsWith("/" + dirBasename)
          );

          if (show) {
            await fetch(`${baseUrl}/api/v3/command`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
              body: JSON.stringify({ name: "RescanSeries", seriesId: show.id }),
            });
            log.info(`Triggered Sonarr rescan for series ${show.id}`);
          }
        }
      } catch { /* rescan is best-effort */ }
    }
  } catch { /* rescan is best-effort */ }
}

// ── Hardware acceleration detection (cached) ───────────────────────────────

let hwEncoder: string | null | undefined;
function detectHwEncoder(): string | null {
  if (hwEncoder !== undefined) return hwEncoder;
  try {
    const out = execSync("ffmpeg -encoders 2>&1", { encoding: "utf-8", timeout: 5_000 });
    if (out.includes("h264_videotoolbox")) { hwEncoder = "h264_videotoolbox"; return hwEncoder; }
    if (out.includes("h264_vaapi")) { hwEncoder = "h264_vaapi"; return hwEncoder; }
  } catch { /* no hw */ }
  hwEncoder = null;
  return null;
}

// ── Error classification for smart retry ────────────────────────────────────

type RetryStrategy = "local-tmp" | "software-encoder" | "alt-audio" | "lower-quality" | "ai-analyze";

interface ErrorClassification {
  category: "output-path" | "volume-unavailable" | "permissions" | "disk-full" |
            "encoder-missing" | "source-corrupt" | "audio-failure" | "oom" | "muxer-error" | "unknown";
  retryable: boolean;
  suggestedStrategy: RetryStrategy | null;
  description: string;
}

function classifyError(stderr: string, exitCode: number): ErrorClassification {
  const s = stderr.toLowerCase();

  // Output path / filesystem errors (the #1 failure pattern)
  if (s.includes("invalid argument") && (s.includes("error opening output") || s.includes("output file"))) {
    return { category: "output-path", retryable: true, suggestedStrategy: "local-tmp", description: "Cannot write output file — filesystem issue" };
  }
  if (s.includes("no such file or directory") && (s.includes("output") || s.includes(".mp4"))) {
    return { category: "volume-unavailable", retryable: true, suggestedStrategy: "local-tmp", description: "Target directory missing — volume may be unmounted" };
  }
  if (s.includes("permission denied") && (s.includes("output") || s.includes(".mp4"))) {
    return { category: "permissions", retryable: true, suggestedStrategy: "local-tmp", description: "Write permission denied on target" };
  }
  if (s.includes("no space left on device")) {
    return { category: "disk-full", retryable: false, suggestedStrategy: null, description: "Disk full" };
  }

  // Encoder issues
  if (s.includes("unknown encoder") || s.includes("encoder") && s.includes("not found")) {
    return { category: "encoder-missing", retryable: true, suggestedStrategy: "software-encoder", description: "Hardware encoder unavailable" };
  }

  // Source file corruption
  if (s.includes("invalid data found when processing") || s.includes("moov atom not found") ||
      s.includes("invalid nal") || s.includes("error while decoding") && s.includes("corrupt")) {
    return { category: "source-corrupt", retryable: false, suggestedStrategy: null, description: "Source file is corrupt" };
  }

  // Audio encoding failures
  if ((s.includes("audio") || s.includes("aac") || s.includes("dts")) &&
      (s.includes("conversion failed") || s.includes("too many bits") || s.includes("encoding error"))) {
    return { category: "audio-failure", retryable: true, suggestedStrategy: "alt-audio", description: "Audio encoding failed" };
  }

  // OOM / killed by system
  if (exitCode === 137) {
    return { category: "oom", retryable: true, suggestedStrategy: "lower-quality", description: "Process killed (OOM)" };
  }

  // Muxer errors
  if (s.includes("muxer") && s.includes("error") || s.includes("could not write header")) {
    return { category: "muxer-error", retryable: true, suggestedStrategy: "local-tmp", description: "Muxer error writing output" };
  }

  return { category: "unknown", retryable: true, suggestedStrategy: "ai-analyze", description: `ffmpeg exited with code ${exitCode}` };
}

/** Pick the next escalated strategy when a retry itself fails. */
function escalateStrategy(current: string | null, classification: ErrorClassification): RetryStrategy {
  if (current === "local-tmp") return "software-encoder";
  if (current === "software-encoder") return "lower-quality";
  if (current === "alt-audio") return "lower-quality";
  if (current === "lower-quality") return "local-tmp";
  return classification.suggestedStrategy ?? "local-tmp";
}

// ── AI failure analysis (lightweight Haiku call) ─────────────────────────────

type ConcreteRetryStrategy = Exclude<RetryStrategy, "ai-analyze">;

/**
 * Ask Haiku to diagnose an ffmpeg failure and recommend a concrete retry strategy.
 * Returns a strategy or null if AI is unavailable / can't help.
 */
async function analyzeFailureWithAI(
  stderr: string,
  sourcePath: string,
  exitCode: number,
  previousStrategy: string | null,
): Promise<{ strategy: ConcreteRetryStrategy | null; diagnosis: string }> {
  try {
    const { generateObject } = await import("ai");
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const { z } = await import("zod");

    const apiKey = (() => {
      try {
        const row = db.get(sql`SELECT value FROM settings WHERE key = 'anthropic_key'`) as { value: string } | undefined;
        return row?.value || process.env.ANTHROPIC_API_KEY;
      } catch {
        return process.env.ANTHROPIC_API_KEY;
      }
    })();

    if (!apiKey) return { strategy: null, diagnosis: "No API key available" };

    const anthropic = createAnthropic({ apiKey });
    const result = await generateObject({
      model: anthropic("claude-haiku-4-5-20251001"),
      schema: z.object({
        diagnosis: z.string().max(300).describe("Brief explanation of what went wrong"),
        strategy: z.enum(["local-tmp", "software-encoder", "alt-audio", "lower-quality", "give-up"])
          .describe("Recommended retry strategy, or give-up if the file is unprocessable"),
        confidence: z.enum(["high", "medium", "low"]),
      }),
      prompt: `You are an ffmpeg expert diagnosing a failed media conversion. Analyze the error and recommend a retry strategy.

File: ${basename(sourcePath)}
Exit code: ${exitCode}
Previous strategy tried: ${previousStrategy ?? "none"}

ffmpeg stderr (last 800 chars):
${stderr.slice(-800)}

Available strategies:
- "local-tmp": Write output to /tmp instead of the target volume (fixes filesystem/permission issues)
- "software-encoder": Force libx264 software encoding instead of hardware (fixes encoder crashes)
- "alt-audio": Try a different audio track (fixes audio encoding failures)
- "lower-quality": Use lower quality settings (fixes OOM/resource issues)
- "give-up": The file is unprocessable (corrupt source, unsupported format)

Do NOT recommend a strategy that was already tried (previous strategy: ${previousStrategy ?? "none"}).`,
    });

    const { strategy, diagnosis } = result.object;
    log.info(`AI diagnosis: ${diagnosis} → strategy: ${strategy}`);

    if (strategy === "give-up") return { strategy: null, diagnosis };
    return { strategy, diagnosis };
  } catch (err) {
    log.error("AI analysis failed", err instanceof Error ? err.message : err);
    return { strategy: null, diagnosis: "AI analysis unavailable" };
  }
}

// ── Volume circuit breakers ────────────────────────────────────────────────

import { CircuitBreaker } from "../utils/circuit-breaker.js";

const volumeBreakers = new Map<string, CircuitBreaker>();

function getVolumeBreaker(targetDir: string): CircuitBreaker {
  // Extract volume root: /Volumes/X, /mnt/X, /media/user/X, or first 2 components
  const parts = targetDir.split("/");
  let root: string;
  if (parts[1] === "Volumes" && parts.length >= 3) root = `/${parts[1]}/${parts[2]}`;
  else if (parts[1] === "media" && parts.length >= 4) root = `/${parts[1]}/${parts[2]}/${parts[3]}`;
  else if (parts[1] === "mnt" && parts.length >= 3) root = `/${parts[1]}/${parts[2]}`;
  else root = targetDir;

  if (!volumeBreakers.has(root)) {
    volumeBreakers.set(root, new CircuitBreaker({
      name: `optimizer-volume:${root}`,
      threshold: 3,
      resetTimeout: 300_000, // 5 minutes
    }));
  }
  return volumeBreakers.get(root)!;
}

// ── Pre-flight validation ──────────────────────────────────────────────────

import { writeFile as writeFileFs } from "node:fs/promises";

interface PreflightResult {
  ok: boolean;
  error?: string;
  action?: "pause-queue" | "skip-job" | "retry-later";
}

async function preflightCheck(sourcePath: string, targetDir: string): Promise<PreflightResult> {
  // 1. Source file readable
  try {
    await stat(sourcePath);
  } catch {
    return { ok: false, error: `Source file gone: ${basename(sourcePath)}`, action: "skip-job" };
  }

  // 2. Target directory writable
  try {
    if (!existsSync(targetDir)) {
      return { ok: false, error: `Target directory missing: ${targetDir}`, action: "retry-later" };
    }
    const testFile = join(targetDir, `.talome-write-test-${Date.now()}`);
    await writeFileFs(testFile, "t");
    await unlink(testFile);
  } catch {
    return { ok: false, error: `Target not writable: ${targetDir}`, action: "retry-later" };
  }

  return { ok: true };
}

// ── Browser compatibility sets ─────────────────────────────────────────────

const BROWSER_VIDEO_CODECS = new Set(["h264", "hevc", "h265"]);
const BROWSER_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
const DIRECT_PLAY_CONTAINERS = new Set(["mp4", "m4v", "mov", "webm"]);

// ── File analysis ──────────────────────────────────────────────────────────

export function analyzeFile(filePath: string): FileAnalysis {
  if (!hasFfmpeg()) {
    return { needsOptimization: false, reason: "ffmpeg not available", sourceCodec: "", sourceAudioCodec: "", sourceContainer: "", canDirectPlay: false, canTransmux: false };
  }

  const probe = probeFile(filePath);
  const ext = extname(filePath).slice(1).toLowerCase();
  const vCodec = probe.videoCodec.toLowerCase();
  const aCodec = (probe.audio[0]?.codec ?? "").toLowerCase();

  // Detect Dolby Vision / problematic HEVC: DV Profile 5 has no HDR10 fallback
  // and shows black screen in browsers. Codec tags "dvhe"/"dvh1" or HEVC 10-bit
  // Dolby Vision with proprietary tags can't be remuxed — needs transcode.
  // HDR10/HLG/10-bit HEVC: video is kept as-is (remux only), player uses HLS
  // streaming with on-the-fly tonemap for browser playback. This preserves
  // HDR quality for Plex, Apple TV, and HDR displays.
  const isDvOnly = (vCodec === "hevc" || vCodec === "h265") && (
    probe.videoCodecTag === "dvhe" || probe.videoCodecTag === "dvh1"
  );

  const videoOk = BROWSER_VIDEO_CODECS.has(vCodec) && !isDvOnly;
  const audioOk = BROWSER_AUDIO_CODECS.has(aCodec);
  const containerOk = DIRECT_PLAY_CONTAINERS.has(ext);

  // DV-only HEVC: browser can't decode proprietary layer, needs full transcode
  if (isDvOnly) {
    return { needsOptimization: true, reason: "Dolby Vision HEVC needs transcode for browser playback", sourceCodec: vCodec, sourceAudioCodec: aCodec, sourceContainer: ext, canDirectPlay: false, canTransmux: false };
  }

  // MP4 with H.264+AAC = perfect, no optimization needed
  if (containerOk && videoOk && audioOk) {
    return { needsOptimization: false, reason: "Already in optimal format", sourceCodec: vCodec, sourceAudioCodec: aCodec, sourceContainer: ext, canDirectPlay: true, canTransmux: false };
  }

  // MKV with H.264+AAC = can transmux instantly, but optimization to MP4 is better long-term
  if (videoOk && audioOk && !containerOk) {
    return { needsOptimization: true, reason: "Container needs remux to MP4", sourceCodec: vCodec, sourceAudioCodec: aCodec, sourceContainer: ext, canDirectPlay: false, canTransmux: true };
  }

  // H.264 but non-browser audio (DTS, AC3) = needs audio re-encoding
  if (videoOk && !audioOk) {
    return { needsOptimization: true, reason: `Audio codec ${aCodec} needs conversion to AAC`, sourceCodec: vCodec, sourceAudioCodec: aCodec, sourceContainer: ext, canDirectPlay: false, canTransmux: true };
  }

  // Non-browser video (MPEG4, MPEG2) = needs full video+audio transcode
  return { needsOptimization: true, reason: `Video codec ${vCodec} needs conversion to H.264`, sourceCodec: vCodec, sourceAudioCodec: aCodec, sourceContainer: ext, canDirectPlay: false, canTransmux: false };
}

// ── Job management ─────────────────────────────────────────────────────────

// In-memory tracking of running ffmpeg processes
const runningProcesses = new Map<string, ChildProcess>();

/** Force-start a queued job immediately, bypassing pause and queue ordering. */
export function forceStartJob(jobId: string): boolean {
  const job = db.select().from(schema.optimizationJobs).where(eq(schema.optimizationJobs.id, jobId)).get();
  if (!job || (job.status !== "queued" && job.status !== "failed")) return false;
  db.update(schema.optimizationJobs)
    .set({ status: "running", startedAt: new Date().toISOString(), progress: 0, error: null })
    .where(eq(schema.optimizationJobs.id, jobId))
    .run();
  void runConversion(jobId);
  return true;
}

export function prioritizeJob(jobId: string): boolean {
  const job = db.select().from(schema.optimizationJobs).where(eq(schema.optimizationJobs.id, jobId)).get();
  if (!job || job.status !== "queued") return false;
  // Set priority higher than any existing queued job
  const maxPriority = db.get(
    sql`SELECT COALESCE(MAX(priority), 0) as max FROM optimization_jobs WHERE status = 'queued'`,
  ) as { max: number };
  db.update(schema.optimizationJobs)
    .set({ priority: maxPriority.max + 1 })
    .where(eq(schema.optimizationJobs.id, jobId))
    .run();
  return true;
}

export function queueOptimization(
  sourcePath: string,
  options?: { keepOriginal?: boolean; priority?: number },
): string {
  // Skip macOS resource fork files and junk files
  if (basename(sourcePath).startsWith("._")) return "";
  const nameNoExt = basename(sourcePath, extname(sourcePath)).toLowerCase();
  if (JUNK_BASENAMES.has(nameNoExt)) return "";
  try { if (statSync(sourcePath).size < MIN_VIDEO_SIZE) return ""; } catch { return ""; }

  const config = getOptimizationConfig();

  // Respect media type filter (movies/tv) — skip unless user-initiated
  const priority = options?.priority ?? 0;
  if (priority < CONVERT_NOW_PRIORITY && !matchesMediaTypeFilter(sourcePath, config.mediaTypes)) {
    log.info(`Skipped ${basename(sourcePath)} — media type "${config.mediaTypes}" filter`);
    return "";
  }

  const analysis = analyzeFile(sourcePath);

  // Skip if already in optimal format
  if (!analysis.needsOptimization) return "";

  // Check if already queued/running, recently completed, or permanently failed for this file
  const existing = db.get(
    sql`SELECT id, status FROM optimization_jobs WHERE source_path = ${sourcePath} AND (status IN ('queued', 'running', 'failed') OR (status = 'completed' AND completed_at > datetime('now', '-1 hour')))`,
  ) as { id: string; status: string } | undefined;
  if (existing) {
    // Still kick the queue — it may be stalled (e.g. after a restart or unpause)
    scheduleProcessQueue();
    return existing.id;
  }

  const id = randomUUID();
  const probe = probeFile(sourcePath);
  let fileSize = 0;
  try { fileSize = statSync(sourcePath).size; } catch { /* ignore */ }

  // Target path: same directory, same name, .mp4 extension
  // When source is already .mp4, target IS the source — we'll write to temp then replace in-place
  const dir = dirname(sourcePath);
  const base = basename(sourcePath, extname(sourcePath));
  const targetPath = join(dir, `${base}.mp4`);

  db.insert(schema.optimizationJobs).values({
    id,
    sourcePath,
    targetPath,
    status: "queued",
    sourceCodec: analysis.sourceCodec,
    sourceAudioCodec: analysis.sourceAudioCodec,
    sourceContainer: analysis.sourceContainer,
    durationSecs: probe.duration,
    fileSize,
    keepOriginal: options?.keepOriginal ?? config.keepOriginals,
    priority: options?.priority ?? 0,
  }).run();

  // Kick the queue (debounced — scanAndQueue may call this many times)
  scheduleProcessQueue();

  return id;
}

export function cancelJob(jobId: string): void {
  const job = db.select().from(schema.optimizationJobs).where(eq(schema.optimizationJobs.id, jobId)).get();
  if (!job) return;

  if (job.status === "running") {
    const proc = runningProcesses.get(jobId);
    if (proc) {
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      runningProcesses.delete(jobId);
    }
    // Clean up partial output (try both naming conventions)
    if (job.targetPath) {
      const tmpDir = dirname(job.targetPath);
      void unlink(join(tmpDir, `${jobId}.tmp.mp4`)).catch((err) => log.debug("Failed to clean tmp file on cancel", err));
      void unlink(job.targetPath + ".tmp").catch((err) => log.debug("Failed to clean legacy tmp file on cancel", err));
    }
  }

  db.update(schema.optimizationJobs)
    .set({ status: "cancelled", completedAt: new Date().toISOString() })
    .where(eq(schema.optimizationJobs.id, jobId))
    .run();
}

export function listJobs(filter?: { status?: string }): OptimizationJob[] {
  let rows;
  if (filter?.status) {
    const statuses = filter.status.split(",");
    rows = db.select().from(schema.optimizationJobs)
      .where(sql`status IN (${sql.join(statuses.map(s => sql`${s}`), sql`,`)})`)
      .orderBy(sql`created_at DESC`)
      .all();
  } else {
    rows = db.select().from(schema.optimizationJobs)
      .orderBy(sql`created_at DESC`)
      .all();
  }
  return rows.map(mapJobRow);
}

export function getJob(jobId: string): OptimizationJob | null {
  const row = db.select().from(schema.optimizationJobs).where(eq(schema.optimizationJobs.id, jobId)).get();
  return row ? mapJobRow(row) : null;
}

export function deleteJob(jobId: string): void {
  db.delete(schema.optimizationJobs).where(eq(schema.optimizationJobs.id, jobId)).run();
}

export function reprocessFailedJobs(errorPattern?: string): { cleared: number; requeued: number } {
  const failedJobs = errorPattern
    ? db.select().from(schema.optimizationJobs).where(
        and(eq(schema.optimizationJobs.status, "failed"), like(schema.optimizationJobs.error, `%${errorPattern}%`))
      ).all()
    : db.select().from(schema.optimizationJobs).where(eq(schema.optimizationJobs.status, "failed")).all();

  let cleared = 0;
  let requeued = 0;

  for (const job of failedJobs) {
    // Skip if already successfully converted by another job
    const alreadyDone = db.get(
      sql`SELECT id FROM optimization_jobs WHERE source_path = ${job.sourcePath} AND status = 'completed'`,
    ) as { id: string } | undefined;

    if (alreadyDone || !existsSync(job.sourcePath)) {
      db.delete(schema.optimizationJobs).where(eq(schema.optimizationJobs.id, job.id)).run();
      cleared++;
      continue;
    }

    // Reset for re-processing with fresh retry count
    db.update(schema.optimizationJobs)
      .set({
        status: "queued",
        retryCount: 0,
        retryStrategy: null,
        error: null,
        progress: 0,
        startedAt: null,
        completedAt: null,
        pid: null,
        lastCommand: null,
      })
      .where(eq(schema.optimizationJobs.id, job.id)).run();
    requeued++;
  }

  if (requeued > 0) scheduleProcessQueue();
  return { cleared, requeued };
}

function mapJobRow(row: typeof schema.optimizationJobs.$inferSelect): OptimizationJob {
  return {
    id: row.id,
    sourcePath: row.sourcePath,
    targetPath: row.targetPath,
    status: row.status as OptimizationJob["status"],
    sourceCodec: row.sourceCodec,
    sourceAudioCodec: row.sourceAudioCodec,
    sourceContainer: row.sourceContainer,
    progress: row.progress,
    durationSecs: row.durationSecs,
    fileSize: row.fileSize,
    outputSize: row.outputSize,
    keepOriginal: row.keepOriginal,
    error: row.error,
    retryCount: row.retryCount ?? 0,
    retryStrategy: row.retryStrategy ?? null,
    lastCommand: row.lastCommand ?? null,
    aiDiagnosis: row.aiDiagnosis ?? null,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    priority: row.priority ?? 0,
  };
}

// ── Orphan recovery — reset stale "running" jobs on startup ─────────────

/** Check if a process with the given PID is still alive. */
function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Re-attach to or reset jobs stuck as "running" after a server restart. */
export function recoverOrphanedJobs(): number {
  const orphans = db.select({
    id: schema.optimizationJobs.id,
    targetPath: schema.optimizationJobs.targetPath,
    pid: schema.optimizationJobs.pid,
    durationSecs: schema.optimizationJobs.durationSecs,
    sourcePath: schema.optimizationJobs.sourcePath,
    fileSize: schema.optimizationJobs.fileSize,
    keepOriginal: schema.optimizationJobs.keepOriginal,
  })
    .from(schema.optimizationJobs)
    .where(eq(schema.optimizationJobs.status, "running"))
    .all();

  let recovered = 0;
  let reattached = 0;
  for (const job of orphans) {
    if (runningProcesses.has(job.id)) continue; // tracked by this process, all good

    // Check if the ffmpeg process is still alive
    if (job.pid && isProcessAlive(job.pid)) {
      // Re-attach: monitor the tmp file size for progress
      void reattachToProcess(job.id, job.pid, job.targetPath!, job.durationSecs, job.sourcePath, job.fileSize, !!job.keepOriginal);
      reattached++;
      continue;
    }

    // Process is dead — clean up and re-queue
    if (job.targetPath) {
      const tmpFile = join(dirname(job.targetPath), `${job.id}.tmp.mp4`);
      void unlink(tmpFile).catch((err) => log.debug("Failed to clean tmp file for dead job", err));
    }
    db.update(schema.optimizationJobs)
      .set({ status: "queued", progress: 0, startedAt: null, error: null, pid: null })
      .where(eq(schema.optimizationJobs.id, job.id))
      .run();
    recovered++;
  }
  if (reattached > 0) log.info(`Re-attached to ${reattached} running conversion(s)`);
  if (recovered > 0) log.info(`Recovered ${recovered} dead job(s) → re-queued`);

  // Clean stale temp files in /tmp/talome-optimize/ that aren't being used.
  // These can be 10-30GB each — must be cleaned on startup.
  void (async () => {
    try {
      const tmpDir = "/tmp/talome-optimize";
      const activeIds = new Set([...runningProcesses.keys()]);
      const files = await readdir(tmpDir).catch(() => [] as string[]);
      let cleaned = 0;
      for (const f of files) {
        const jobId = f.replace(".tmp.mp4", "");
        if (!activeIds.has(jobId)) {
          await unlink(join(tmpDir, f)).catch((err) => log.debug("Failed to clean stale temp file", err));
          cleaned++;
        }
      }
      if (cleaned > 0) log.info(`Cleaned ${cleaned} stale temp file(s)`);
    } catch { /* /tmp/talome-optimize may not exist */ }
  })();

  return recovered;
}

/**
 * Re-attach to an orphaned ffmpeg process by polling the tmp file size.
 * When the process exits (detected by isProcessAlive returning false),
 * finalize the conversion or mark it failed.
 */
async function reattachToProcess(
  jobId: string, pid: number, targetPath: string,
  durationSecs: number, sourcePath: string, fileSize: number, keepOriginal: boolean,
): Promise<void> {
  const tmpPath = join(dirname(targetPath), `${jobId}.tmp.mp4`);
  log.info(`Re-attaching to PID ${pid} for ${basename(sourcePath)}`);

  // Poll until the process exits
  const poll = setInterval(async () => {
    if (isProcessAlive(pid)) {
      // Update progress from file size ratio (rough estimate)
      try {
        const tmpStat = await stat(tmpPath);
        if (fileSize > 0) {
          // Estimate: output ~= input size for remux, ~50% for transcode
          const estimatedOutput = fileSize * 0.7; // conservative middle ground
          const progress = Math.min(tmpStat.size / estimatedOutput, 0.99);
          db.update(schema.optimizationJobs)
            .set({ progress })
            .where(eq(schema.optimizationJobs.id, jobId))
            .run();
        }
      } catch { /* tmp file may not exist yet */ }
      return;
    }

    // Process exited — finalize
    clearInterval(poll);

    if (existsSync(tmpPath)) {
      try {
        const tmpStat = await stat(tmpPath);
        // If tmp file is very small (< 1MB), it's likely a failed conversion
        if (tmpStat.size < 1_000_000) throw new Error("Output file too small — conversion likely failed");

        // Verify the output is a valid media file (has moov atom / valid streams)
        // before replacing the original — a partially-written file can be large but corrupt
        const tmpProbe = probeFile(tmpPath);
        if (!tmpProbe.videoCodec) throw new Error("Output file is corrupt — no video stream detected (likely interrupted conversion)");

        log.info(`Re-attached job completed, finalizing: ${basename(tmpPath)}`);
        await unlink(targetPath).catch((err) => log.debug("Failed to remove old target before rename", err));
        await rename(tmpPath, targetPath);

        let outputSize = 0;
        try { outputSize = (await stat(targetPath)).size; } catch { /* ignore */ }

        if (!keepOriginal && targetPath !== sourcePath) {
          try { await unlink(sourcePath); } catch { /* ignore */ }
        }

        db.update(schema.optimizationJobs)
          .set({ status: "completed", progress: 1, outputSize, completedAt: new Date().toISOString(), pid: null })
          .where(eq(schema.optimizationJobs.id, jobId))
          .run();

        const savedPct = fileSize > 0 ? Math.round((1 - outputSize / fileSize) * 100) : 0;
        const sizeInfo = savedPct > 0 ? ` (${savedPct}% smaller)` : "";
        writeNotification("info", `Optimized: ${basename(sourcePath)}`, `Converted to MP4${sizeInfo}`);

        void triggerArrRescan(targetPath, sourcePath);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        db.update(schema.optimizationJobs)
          .set({ status: "failed", error: errorMsg, completedAt: new Date().toISOString(), pid: null })
          .where(eq(schema.optimizationJobs.id, jobId))
          .run();
        writeNotification("warning", `Optimization failed: ${basename(sourcePath)}`, errorMsg);
        await unlink(tmpPath).catch((err) => log.warn("Failed to clean tmp file after re-attach failure", err));
      }
    } else {
      // No tmp file — process died without producing output
      db.update(schema.optimizationJobs)
        .set({ status: "queued", progress: 0, startedAt: null, error: null, pid: null })
        .where(eq(schema.optimizationJobs.id, jobId))
        .run();
    }

    setTimeout(() => processQueue(), 500);
  }, 3000); // Poll every 3 seconds
}

// ── Queue processing ───────────────────────────────────────────────────────

let processing = false;
let processTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleProcessQueue(): void {
  if (processTimer) return;
  processTimer = setTimeout(() => { processTimer = null; processQueue(); }, 100);
}

/** Remove completed/failed/cancelled jobs older than 7 days. */
function cleanupOldJobs(): void {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  db.run(sql`DELETE FROM optimization_jobs
    WHERE status IN ('completed', 'failed', 'cancelled')
    AND completed_at IS NOT NULL AND completed_at < ${cutoff}`);
}

// Run recovery on module load (server restart) — defer to allow migrations to complete
setTimeout(() => {
  try {
    recoverOrphanedJobs();
    scheduleProcessQueue();
  } catch {
    // Table may not exist on first boot — migrations haven't run yet
  }
}, 2_000);

// ── Process watchdog — detect dead ffmpeg every 60s + auto-cleanup ───────

setInterval(() => {
  const recovered = recoverOrphanedJobs();
  if (recovered > 0) scheduleProcessQueue();
  cleanupOldJobs();
}, 60_000);

/** Priority threshold for user-initiated "Convert Now" jobs that bypass pause. */
const CONVERT_NOW_PRIORITY = 10;

export function processQueue(): void {
  if (processing) return;
  processing = true;

  try {
    const config = getOptimizationConfig();
    const runningCount = db.get(
      sql`SELECT COUNT(*) as count FROM optimization_jobs WHERE status = 'running'`,
    ) as { count: number };

    if (runningCount.count >= config.maxConcurrentJobs) {
      processing = false;
      return;
    }

    // Get all running source paths to avoid processing the same file concurrently
    const runningPaths = new Set(
      (db.all(sql`SELECT source_path FROM optimization_jobs WHERE status = 'running'`) as Array<{ source_path: string }>)
        .map((r) => r.source_path),
    );

    // Find next queued job that isn't already running for the same source file
    const candidates = db.select().from(schema.optimizationJobs)
      .where(eq(schema.optimizationJobs.status, "queued"))
      .orderBy(sql`priority DESC, created_at ASC`)
      .limit(20)
      .all();

    // Filter out jobs that no longer match the media type setting (e.g. user
    // changed filter from "all" to "movies" after TV jobs were already queued).
    // User-initiated "Convert Now" jobs bypass the filter.
    let next: typeof candidates[number] | undefined;
    for (const j of candidates) {
      if (runningPaths.has(j.sourcePath)) continue;
      // Skip jobs with a "not before" cooldown (circuit breaker re-queued jobs)
      if (j.startedAt && new Date(j.startedAt).getTime() > Date.now()) continue;
      if ((j.priority ?? 0) < CONVERT_NOW_PRIORITY && !matchesMediaTypeFilter(j.sourcePath, config.mediaTypes)) {
        // Silently cancel — this job shouldn't have been in the queue
        db.update(schema.optimizationJobs)
          .set({ status: "cancelled", error: `Skipped: media type filter changed to "${config.mediaTypes}"`, completedAt: new Date().toISOString() })
          .where(eq(schema.optimizationJobs.id, j.id)).run();
        continue;
      }
      next = j;
      break;
    }

    if (!next) {
      processing = false;
      return;
    }

    // When paused, only allow user-initiated high-priority ("Convert Now") jobs through
    if (config.paused && (next.priority ?? 0) < CONVERT_NOW_PRIORITY) {
      processing = false;
      return;
    }

    // Mark as running BEFORE releasing lock — prevents concurrent processQueue
    // calls from picking more jobs than maxConcurrentJobs allows
    db.update(schema.optimizationJobs)
      .set({ status: "running", startedAt: new Date().toISOString(), progress: 0 })
      .where(eq(schema.optimizationJobs.id, next.id))
      .run();

    processing = false;
    void runConversion(next.id);
  } catch {
    processing = false;
  }
}

// ── Conversion runner ──────────────────────────────────────────────────────

async function runConversion(jobId: string): Promise<void> {
  const job = db.select().from(schema.optimizationJobs).where(eq(schema.optimizationJobs.id, jobId)).get();
  if (!job || job.status !== "running") return;

  const sourcePath = job.sourcePath;
  const targetPath = job.targetPath!;
  const targetDir = dirname(targetPath);

  // UUID-based temp filename — avoids special chars and keeps .mp4 extension
  // so ffmpeg selects the correct muxer (.mp4.tmp caused 2,293 failures).
  let tmpPath = join(targetDir, `${jobId}.tmp.mp4`);
  let usingLocalTmp = false;

  log.info(`Job ${job.id} source: ${sourcePath}`);
  log.info(`Job ${job.id} target: ${targetPath} retry: ${job.retryCount} strategy: ${job.retryStrategy ?? "none"}`);

  // ── Pre-flight validation ──────────────────────────────────────────────
  const preflight = await preflightCheck(sourcePath, targetDir);
  if (!preflight.ok) {
    if (preflight.action === "pause-queue") {
      db.update(schema.optimizationJobs)
        .set({ status: "queued", error: preflight.error, startedAt: null, progress: 0 })
        .where(eq(schema.optimizationJobs.id, jobId)).run();
      writeNotification("warning", "Optimization paused: disk issue", preflight.error!);
      return;
    }
    if (preflight.action === "retry-later") {
      db.update(schema.optimizationJobs)
        .set({ status: "queued", error: preflight.error, startedAt: null, progress: 0 })
        .where(eq(schema.optimizationJobs.id, jobId)).run();
      setTimeout(() => processQueue(), 60_000);
      return;
    }
    // skip-job
    db.update(schema.optimizationJobs)
      .set({ status: "failed", error: preflight.error!, completedAt: new Date().toISOString() })
      .where(eq(schema.optimizationJobs.id, jobId)).run();
    setTimeout(() => processQueue(), 500);
    return;
  }

  // ── Volume circuit breaker ─────────────────────────────────────────────
  const breaker = getVolumeBreaker(targetDir);
  if (breaker.isOpen) {
    log.warn(`Volume circuit breaker open for ${targetDir} — pausing job for 5min`);
    // Mark as failed-temporary so it doesn't get picked up by processQueue immediately.
    // The job stays in "queued" but with a future startedAt as a "not before" marker.
    const notBefore = new Date(Date.now() + 300_000).toISOString();
    db.update(schema.optimizationJobs)
      .set({ status: "queued", error: "Volume temporarily unavailable — retrying after cooldown", startedAt: notBefore, progress: 0 })
      .where(eq(schema.optimizationJobs.id, jobId)).run();
    return;
  }

  // ── Apply retry strategy overrides ─────────────────────────────────────
  // Use local tmp for large files (>4GB) by default to avoid doubling disk
  // usage on the target volume and reduce I/O pressure during conversion.
  // Only if the system drive has enough free space (source size + 2GB margin).
  const LOCAL_TMP_THRESHOLD = 4 * 1024 * 1024 * 1024; // 4GB
  let sourceSize = 0;
  try { sourceSize = (await stat(sourcePath)).size; } catch { /* use 0 */ }

  let shouldUseLocalTmp = job.retryStrategy === "local-tmp";
  if (!shouldUseLocalTmp && sourceSize > LOCAL_TMP_THRESHOLD) {
    // Check system drive free space before committing to local tmp
    try {
      const { execSync } = await import("node:child_process");
      const dfOut = execSync("df -k /tmp", { timeout: 5000 }).toString();
      const lines = dfOut.trim().split("\n");
      if (lines.length >= 2) {
        const cols = lines[1].split(/\s+/);
        const freeKB = Number(cols[3]);
        const neededKB = Math.ceil(sourceSize / 1024) + 2 * 1024 * 1024; // source + 2GB margin
        shouldUseLocalTmp = freeKB > neededKB;
        if (!shouldUseLocalTmp) {
          log.info(`Large file (${(sourceSize / 1e9).toFixed(1)}GB) but system drive too full (${(freeKB / 1e6).toFixed(1)}GB free) — writing to target volume`);
        }
      }
    } catch {
      // Can't check — fall back to target volume
    }
  }

  if (shouldUseLocalTmp) {
    const localTmpDir = "/tmp/talome-optimize";
    await mkdir(localTmpDir, { recursive: true });
    tmpPath = join(localTmpDir, `${jobId}.tmp.mp4`);
    usingLocalTmp = true;
    if (job.retryStrategy === "local-tmp") {
      log.info(`Retry strategy: using local tmp dir: ${tmpPath}`);
    } else {
      log.info(`Large file (${(sourceSize / 1e9).toFixed(1)}GB) — using local tmp: ${tmpPath}`);
    }
  }

  // Build ffmpeg args — copy what can be copied, only encode what must change
  const probe = probeFile(sourcePath);
  const vCodec = probe.videoCodec.toLowerCase();
  const aCodec = (probe.audio[0]?.codec ?? "").toLowerCase();

  // Only DV with proprietary tags needs re-encoding.
  // HDR10/HLG/10-bit HEVC is copied as-is — preserves HDR for Plex/Apple TV.
  // Browser playback routes through HLS streaming (on-the-fly tonemap).
  const isDvHevc = (vCodec === "hevc" || vCodec === "h265") && (
    probe.videoCodecTag === "dvhe" || probe.videoCodecTag === "dvh1"
  );
  const videoCanCopy = BROWSER_VIDEO_CODECS.has(vCodec) && !isDvHevc;
  const audioCanCopy = BROWSER_AUDIO_CODECS.has(aCodec);

  const hw = detectHwEncoder();
  const isHdr = probe.videoPixFmt?.includes("10") || probe.videoColorTransfer === "smpte2084" || probe.videoColorTransfer === "arib-std-b67";

  let videoArgs: string[];
  let videoFilterArgs: string[] = [];
  if (videoCanCopy) {
    videoArgs = ["-c:v", "copy"];
  } else if (isDvHevc) {
    // DV → H.264 SDR: software decode + zscale tonemap (DV can't be copied or hw-decoded).
    videoArgs = ["-c:v", "libx264", "-preset", "fast", "-crf", "20", "-profile:v", "high"];
    videoFilterArgs = ["-vf", "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p"];
    log.info("Dolby Vision source — using software encoder + tonemap");
  } else if (hw === "h264_videotoolbox") {
    videoArgs = ["-c:v", "h264_videotoolbox", "-b:v", "8M", "-profile:v", "high"];
  } else {
    videoArgs = ["-c:v", "libx264", "-preset", "fast", "-crf", "20", "-profile:v", "high"];
  }

  // Ensure output is 8-bit yuv420p for browser compatibility
  if (!videoCanCopy && videoFilterArgs.length === 0) {
    videoFilterArgs = ["-pix_fmt", "yuv420p"];
  }

  let audioArgs = audioCanCopy
    ? ["-c:a", "copy"]
    : ["-c:a", "aac", "-b:a", "192k"];

  // Map all audio streams — preserve surround, commentary, other languages.
  // Re-encode non-browser-compatible codecs, copy the rest.
  const audioMapArgs: string[] = [];
  for (let i = 0; i < probe.audio.length; i++) {
    audioMapArgs.push("-map", `0:a:${i}`);
  }
  if (probe.audio.length === 0) {
    audioMapArgs.push("-map", "0:a:0?"); // optional — don't fail if no audio
  }
  // Per-stream audio codec: copy compatible, re-encode others
  const audioCodecArgs: string[] = [];
  if (probe.audio.length > 1) {
    for (let i = 0; i < probe.audio.length; i++) {
      const ac = probe.audio[i].codec.toLowerCase();
      if (BROWSER_AUDIO_CODECS.has(ac)) {
        audioCodecArgs.push(`-c:a:${i}`, "copy");
      } else {
        audioCodecArgs.push(`-c:a:${i}`, "aac", `-b:a:${i}`, "192k");
      }
    }
  } else {
    audioCodecArgs.push(...audioArgs);
  }

  // Legacy single-track mapping for retry strategies that need it
  const bestAudioIdx = probe.audio.findIndex((a) => a.language === "eng");
  let audioStreamMap = bestAudioIdx >= 0 ? `0:a:${bestAudioIdx}` : "0:a:0";

  // ── Retry strategy: encoder overrides ──────────────────────────────────
  if (job.retryStrategy === "software-encoder") {
    videoArgs = ["-c:v", "libx264", "-preset", "fast", "-crf", "20", "-profile:v", "high"];
    log.info("Retry strategy: forced software encoder (libx264)");
  } else if (job.retryStrategy === "lower-quality") {
    videoArgs = ["-c:v", "libx264", "-preset", "faster", "-crf", "23", "-profile:v", "high"];
    log.info("Retry strategy: lower quality software encoder");
  }

  // ── Retry strategy: audio overrides ────────────────────────────────────
  if (job.retryStrategy === "alt-audio" && probe.audio.length > 1) {
    const altIdx = bestAudioIdx >= 0 ? (bestAudioIdx + 1) % probe.audio.length : 1;
    audioStreamMap = `0:a:${altIdx}`;
    audioArgs = ["-c:a", "aac", "-b:a", "192k"];
    log.info(`Retry strategy: alternate audio track index ${altIdx}`);
  }

  let args: string[];
  if (job.retryStrategy === "alt-audio") {
    // Alt-audio retry: use single alternate track
    args = [
      "-i", sourcePath,
      "-map", "0:v:0", "-map", audioStreamMap,
      ...videoArgs, ...videoFilterArgs,
      ...audioArgs,
      "-movflags", "+faststart",
      "-y", tmpPath,
    ];
  } else {
    // Normal: map all audio streams, per-stream codec selection
    args = [
      "-i", sourcePath,
      "-map", "0:v:0", ...audioMapArgs,
      ...videoArgs, ...videoFilterArgs,
      ...audioCodecArgs,
      "-movflags", "+faststart",
      "-y", tmpPath,
    ];
  }

  log.info(`Starting: ${basename(sourcePath)} → ${basename(targetPath)}`);
  log.debug(`ffmpeg args: ${args.join(" ")}`);

  // Store command for diagnostics
  db.update(schema.optimizationJobs)
    .set({ lastCommand: `ffmpeg ${args.join(" ")}` })
    .where(eq(schema.optimizationJobs.id, jobId)).run();

  let exitCode = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      runningProcesses.set(jobId, proc);

      if (proc.pid) {
        db.update(schema.optimizationJobs)
          .set({ pid: proc.pid })
          .where(eq(schema.optimizationJobs.id, jobId)).run();
      }

      proc.stdout?.on("data", () => { /* drain */ });

      let stderrBuf = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const timeMatch = stderrBuf.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
        if (timeMatch) {
          const [, h, m, s] = timeMatch;
          const progressSecs = parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s);
          const progress = job.durationSecs > 0 ? Math.min(progressSecs / job.durationSecs, 0.99) : 0;
          db.update(schema.optimizationJobs)
            .set({ progress })
            .where(eq(schema.optimizationJobs.id, jobId)).run();
          if (stderrBuf.length > 2000) stderrBuf = stderrBuf.slice(-500);
        }
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @types/node regression: ChildProcess lost .on()
      const p = proc as any;
      p.on("close", (code: number | null) => {
        runningProcesses.delete(jobId);
        exitCode = code ?? 1;
        if (code === 0) {
          resolve();
        } else {
          log.error(`ffmpeg failed, code: ${code} stderr tail: ${stderrBuf.slice(-500)}`);
          reject(new Error(`ffmpeg exited with code ${code}: ${stderrBuf.slice(-200)}`));
        }
      });

      p.on("error", (err: Error) => {
        runningProcesses.delete(jobId);
        reject(err);
      });
    });

    // ── Finalize: move temp → target ─────────────────────────────────────
    if (!existsSync(tmpPath)) throw new Error("Output file not found after conversion");

    if (usingLocalTmp) {
      // Copy from local /tmp back to target volume, then clean up
      const { copyFile } = await import("node:fs/promises");
      const localTargetTmp = join(targetDir, `${jobId}.tmp.mp4`);
      await copyFile(tmpPath, localTargetTmp);
      await unlink(tmpPath);
      tmpPath = localTargetTmp;
    }

    // Validate output has audio — catch silent ffmpeg audio encoding failures.
    // If source had audio but output doesn't, the conversion is broken.
    if (probe.audio.length > 0) {
      try {
        const outputProbe = probeFile(tmpPath);
        if (outputProbe.audio.length === 0) {
          log.error(`Audio lost during conversion: source had ${probe.audio.length} audio stream(s), output has 0. Aborting.`);
          await unlink(tmpPath).catch(() => {});
          throw new Error("Output file has no audio streams — conversion aborted to protect source");
        }
      } catch (probeErr) {
        if (probeErr instanceof Error && probeErr.message.includes("no audio")) throw probeErr;
        log.warn("Could not probe output file for audio validation, proceeding", probeErr instanceof Error ? probeErr.message : probeErr);
      }
    }

    log.info(`Finalizing ${basename(tmpPath)} → ${basename(targetPath)}`);
    await unlink(targetPath).catch((err) => log.debug("Failed to remove old target before rename", err));
    await rename(tmpPath, targetPath);

    let outputSize = 0;
    try { outputSize = (await stat(targetPath)).size; } catch { /* ignore */ }

    if (!job.keepOriginal && targetPath !== sourcePath) {
      try {
        await unlink(sourcePath);
        log.info(`Deleted original: ${basename(sourcePath)}`);
      } catch (delErr) {
        log.error(`Failed to delete original: ${sourcePath}`, delErr instanceof Error ? delErr.message : delErr);
      }
    }

    // Mark complete — record success through volume breaker
    breaker.exec(async () => {}).catch((err) => log.debug("Failed to record breaker success", err));

    db.update(schema.optimizationJobs)
      .set({ status: "completed", progress: 1, outputSize, completedAt: new Date().toISOString() })
      .where(eq(schema.optimizationJobs.id, jobId)).run();

    const savedPct = job.fileSize > 0 ? Math.round((1 - outputSize / job.fileSize) * 100) : 0;
    const sizeInfo = savedPct > 0 ? ` (${savedPct}% smaller)` : "";
    const retryNote = job.retryCount > 0 ? ` (after ${job.retryCount} retry, strategy: ${job.retryStrategy})` : "";
    writeNotification("info", `Optimized: ${basename(sourcePath)}`, `Converted to MP4${sizeInfo}${retryNote}`);
    log.info(`Done: ${basename(targetPath)}${retryNote}`);

    try {
      const targetAnalysis: FileAnalysis = { needsOptimization: false, reason: "Optimized to MP4", sourceCodec: "h264", sourceAudioCodec: "aac", sourceContainer: "mp4", canDirectPlay: true, canTransmux: false };
      persistScanEntry(targetPath, targetAnalysis, outputSize, Math.floor(Date.now()));
      if (targetPath !== sourcePath) {
        db.run(sql`DELETE FROM library_scan_results WHERE file_path = ${sourcePath}`);
      }
    } catch { /* scan cache update is best-effort */ }

    void triggerArrRescan(targetPath, sourcePath);
  } catch (err) {
    runningProcesses.delete(jobId);
    await unlink(tmpPath).catch((err) => log.warn("Failed to clean tmp file after job error", err));

    const errorMsg = err instanceof Error ? err.message : String(err);
    const classification = classifyError(errorMsg, exitCode);

    // Record volume failure in circuit breaker
    if (classification.category === "output-path" || classification.category === "volume-unavailable" || classification.category === "permissions") {
      breaker.exec(async () => { throw new Error("volume failure"); }).catch((err) => log.debug("Failed to record breaker volume failure", err));
    }

    // ── Smart retry ──────────────────────────────────────────────────────
    const retryCount = job.retryCount ?? 0;
    const maxRetries = classification.suggestedStrategy === "ai-analyze" ? 3 : 2;
    if (classification.retryable && retryCount < maxRetries) {
      let nextStrategy: RetryStrategy | null;
      let aiDiagnosis: string | undefined;

      if (classification.suggestedStrategy === "ai-analyze" || job.retryStrategy === "ai-analyze") {
        // Ask Haiku to diagnose the failure and pick a concrete strategy
        const aiResult = await analyzeFailureWithAI(errorMsg, sourcePath, exitCode, job.retryStrategy);
        nextStrategy = aiResult.strategy;
        aiDiagnosis = aiResult.diagnosis;
        if (!nextStrategy) {
          // AI says give-up or is unavailable — fall back to local-tmp on first try, else fail
          nextStrategy = retryCount === 0 ? "local-tmp" : null;
        }
      } else if (retryCount === 0) {
        nextStrategy = classification.suggestedStrategy ?? "local-tmp";
      } else {
        nextStrategy = escalateStrategy(job.retryStrategy, classification);
      }

      if (nextStrategy) {
        const diagNote = aiDiagnosis ? ` [AI: ${aiDiagnosis}]` : "";
        log.warn(`Retryable error (${classification.category}), re-queuing with strategy: ${nextStrategy} (retry ${retryCount + 1}/${maxRetries})${diagNote}`);

        db.update(schema.optimizationJobs)
          .set({
            status: "queued",
            retryCount: retryCount + 1,
            retryStrategy: nextStrategy,
            error: `Retry ${retryCount + 1}/${maxRetries} (${classification.description})${diagNote}: ${errorMsg.slice(0, 200)}`,
            progress: 0,
            startedAt: null,
            pid: null,
            ...(aiDiagnosis ? { aiDiagnosis } : {}),
          })
          .where(eq(schema.optimizationJobs.id, jobId)).run();

        const delay = classification.category === "volume-unavailable" ? 30_000 : 2_000;
        setTimeout(() => processQueue(), delay);
      } else {
        // AI said give-up after analysis
        db.update(schema.optimizationJobs)
          .set({
            status: "failed",
            error: `${aiDiagnosis ?? "Unrecoverable"}: ${errorMsg.slice(0, 200)}`,
            completedAt: new Date().toISOString(),
            ...(aiDiagnosis ? { aiDiagnosis } : {}),
          })
          .where(eq(schema.optimizationJobs.id, jobId)).run();

        writeNotification("warning", `Optimization failed: ${basename(sourcePath)}`, aiDiagnosis ?? errorMsg);
        log.error(`AI says give-up: ${aiDiagnosis} ${errorMsg.slice(0, 200)}`);
      }
    } else {
      // Permanently failed
      if (classification.category === "disk-full") {
        writeNotification("warning", "Optimization paused: disk full", errorMsg);
      }

      db.update(schema.optimizationJobs)
        .set({ status: "failed", error: errorMsg, completedAt: new Date().toISOString() })
        .where(eq(schema.optimizationJobs.id, jobId)).run();

      writeNotification("warning", `Optimization failed: ${basename(sourcePath)}`, errorMsg);
      log.error(`Permanently failed: ${classification.category} ${errorMsg.slice(0, 200)}`);
    }
  }

  // Process next in queue
  setTimeout(() => processQueue(), 500);
}

// ── Optimized file lookup (for stream endpoint) ────────────────────────────

/** If a completed optimization job exists for this source (by basename), return the target path. */
export function findOptimizedPath(hostPath: string): string | null {
  const srcBasename = basename(hostPath).toLowerCase();
  const row = db.get(
    sql`SELECT target_path FROM optimization_jobs WHERE status = 'completed' ORDER BY completed_at DESC`,
  ) as { target_path: string } | undefined;
  // Search all completed jobs for a basename match
  if (!row) {
    // No completed jobs at all
    return null;
  }
  const rows = db.select({ targetPath: schema.optimizationJobs.targetPath, sourcePath: schema.optimizationJobs.sourcePath })
    .from(schema.optimizationJobs)
    .where(eq(schema.optimizationJobs.status, "completed"))
    .all();
  for (const r of rows) {
    const jobBasename = basename(r.sourcePath).toLowerCase();
    if (jobBasename === srcBasename && r.targetPath) {
      try {
        if (existsSync(r.targetPath)) return r.targetPath;
      } catch { /* ignore */ }
    }
  }
  return null;
}

// ── Persistent scan results ────────────────────────────────────────────────

const VIDEO_EXTS = new Set([".mp4", ".mkv", ".avi", ".m4v", ".mov", ".wmv", ".flv", ".ts", ".webm"]);
const MIN_VIDEO_SIZE = 50 * 1024 * 1024; // 50 MB — skip junk/promo stubs
const JUNK_BASENAMES = new Set(["rarbg.com", "rarbg_do_not_mirror.exe", "sample"]);

const execFileAsync = promisify(execFile);

/** Yield to the event loop so HTTP requests can be served during long scans. */
const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));

/** Non-blocking ffprobe — same output as probeFile but doesn't freeze the event loop. */
async function probeFileAsync(filePath: string): Promise<ReturnType<typeof probeFile>> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { encoding: "utf-8", timeout: 15_000 },
    );
    const data = JSON.parse(stdout);
    const duration = parseFloat(data.format?.duration ?? "0") || 0;

    let videoCodec = "";
    let videoCodecTag = "";
    let videoColorTransfer = "";
    let videoPixFmt = "";
    let audioIdx = 0;
    const audio: Array<{ index: number; language: string; title: string; codec: string; channels: number }> = [];

    for (const s of data.streams ?? []) {
      if (s.codec_type === "video" && !videoCodec) {
        videoCodec = s.codec_name ?? "";
        videoCodecTag = s.codec_tag_string ?? "";
        videoColorTransfer = s.color_transfer ?? "";
        videoPixFmt = s.pix_fmt ?? "";
      } else if (s.codec_type === "audio") {
        audio.push({
          index: audioIdx++,
          language: s.tags?.language ?? "und",
          title: s.tags?.title ?? "",
          codec: s.codec_name ?? "",
          channels: s.channels ?? 0,
        });
      }
    }

    return { duration, videoCodec, videoCodecTag, videoColorTransfer, videoPixFmt, audio, subtitle: [] };
  } catch {
    return { duration: 0, videoCodec: "", audio: [], subtitle: [] };
  }
}

/** Async version of analyzeFile — doesn't block the event loop. */
async function analyzeFileAsync(filePath: string): Promise<FileAnalysis> {
  if (!hasFfmpeg()) {
    return { needsOptimization: false, reason: "ffmpeg not available", sourceCodec: "", sourceAudioCodec: "", sourceContainer: "", canDirectPlay: false, canTransmux: false };
  }

  const probe = await probeFileAsync(filePath);
  const ext = extname(filePath).slice(1).toLowerCase();
  const vCodec = probe.videoCodec.toLowerCase();
  const aCodec = (probe.audio[0]?.codec ?? "").toLowerCase();

  const isDvOnly = (vCodec === "hevc" || vCodec === "h265") && (
    probe.videoCodecTag === "dvhe" || probe.videoCodecTag === "dvh1"
  );

  const videoOk = BROWSER_VIDEO_CODECS.has(vCodec) && !isDvOnly;
  const audioOk = BROWSER_AUDIO_CODECS.has(aCodec);
  const containerOk = DIRECT_PLAY_CONTAINERS.has(ext);

  if (isDvOnly) {
    return { needsOptimization: true, reason: "Dolby Vision HEVC needs transcode for browser playback", sourceCodec: vCodec, sourceAudioCodec: aCodec, sourceContainer: ext, canDirectPlay: false, canTransmux: false };
  }

  if (containerOk && videoOk && audioOk) {
    return { needsOptimization: false, reason: "Already in optimal format", sourceCodec: vCodec, sourceAudioCodec: aCodec, sourceContainer: ext, canDirectPlay: true, canTransmux: false };
  }
  if (videoOk && audioOk && !containerOk) {
    return { needsOptimization: true, reason: "Container needs remux to MP4", sourceCodec: vCodec, sourceAudioCodec: aCodec, sourceContainer: ext, canDirectPlay: false, canTransmux: true };
  }
  if (videoOk && !audioOk) {
    return { needsOptimization: true, reason: `Audio codec ${aCodec} needs conversion to AAC`, sourceCodec: vCodec, sourceAudioCodec: aCodec, sourceContainer: ext, canDirectPlay: false, canTransmux: true };
  }
  return { needsOptimization: true, reason: `Video codec ${vCodec} needs conversion to H.264`, sourceCodec: vCodec, sourceAudioCodec: aCodec, sourceContainer: ext, canDirectPlay: false, canTransmux: false };
}

/** Upsert a single file analysis into the scan results cache. */
function persistScanEntry(filePath: string, analysis: FileAnalysis, fileSize: number, mtime: number): void {
  const dir = dirname(filePath);
  const now = new Date().toISOString();
  db.run(sql`INSERT INTO library_scan_results
    (file_path, video_codec, audio_codec, container, needs_optimization, reason, can_transmux, file_size, file_mtime, last_probed, directory)
    VALUES (${filePath}, ${analysis.sourceCodec}, ${analysis.sourceAudioCodec}, ${analysis.sourceContainer},
            ${analysis.needsOptimization ? 1 : 0}, ${analysis.reason}, ${analysis.canTransmux ? 1 : 0},
            ${fileSize}, ${mtime}, ${now}, ${dir})
    ON CONFLICT(file_path) DO UPDATE SET
      video_codec = ${analysis.sourceCodec}, audio_codec = ${analysis.sourceAudioCodec},
      container = ${analysis.sourceContainer}, needs_optimization = ${analysis.needsOptimization ? 1 : 0},
      reason = ${analysis.reason}, can_transmux = ${analysis.canTransmux ? 1 : 0},
      file_size = ${fileSize}, file_mtime = ${mtime}, last_probed = ${now}, directory = ${dir}`);
}

/** Get cached scan result for a file, or null if stale/missing. */
function getCachedScanEntry(filePath: string, currentMtime: number): { needsOptimization: boolean; reason: string; canTransmux: boolean } | null {
  const row = db.get(sql`SELECT needs_optimization, reason, can_transmux, file_mtime
    FROM library_scan_results WHERE file_path = ${filePath}`) as
    { needs_optimization: number; reason: string; can_transmux: number; file_mtime: number } | undefined;
  if (!row || row.file_mtime !== currentMtime) return null;
  return { needsOptimization: !!row.needs_optimization, reason: row.reason, canTransmux: !!row.can_transmux };
}

/** Returns true if the file is already optimal or has a completed/active job. */
export function isAlreadyOptimized(filePath: string): boolean {
  // Has a completed or active job as source OR target in DB?
  const existing = db.get(
    sql`SELECT id FROM optimization_jobs
        WHERE (source_path = ${filePath} OR target_path = ${filePath})
        AND status IN ('completed', 'running', 'queued')`,
  ) as { id: string } | undefined;
  if (existing) return true;

  // Check via analysis (uses cache when possible)
  const analysis = analyzeFile(filePath);
  return !analysis.needsOptimization;
}

// ── Scan + auto-queue (used by both API scan and auto-optimize) ────────────

export async function scanAndQueue(dirPath: string, queueJobs = true): Promise<ScanResult> {
  let scanned = 0;
  let queued = 0;
  let skipped = 0;
  const breakdown = { transmux: 0, audioReencode: 0, fullTranscode: 0 };

  // Collect all video file paths first (fast, sync fs walk)
  const filePaths: Array<{ fullPath: string; name: string }> = [];
  const collect = (dir: string, depth: number) => {
    if (depth > 5) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          collect(fullPath, depth + 1);
        } else if (entry.isFile() && !entry.name.startsWith("._") && VIDEO_EXTS.has(extname(entry.name).toLowerCase())) {
          const nameNoExt = basename(entry.name, extname(entry.name)).toLowerCase();
          if (JUNK_BASENAMES.has(nameNoExt)) continue;
          filePaths.push({ fullPath, name: entry.name });
        }
      }
    } catch { /* skip unreadable dirs */ }
  };
  collect(dirPath, 0);

  // Process files with async probing + periodic event loop yields
  for (const { fullPath } of filePaths) {
    scanned++;

    // Check for active/completed/failed job first (sync DB lookup — fast)
    // Including 'failed' prevents permanently-failed (corrupt) files from being re-queued every scan cycle.
    // Use reprocessFailedJobs() to explicitly retry them.
    const existingJob = db.get(
      sql`SELECT id FROM optimization_jobs
          WHERE source_path = ${fullPath} AND status IN ('completed', 'running', 'queued', 'failed')`,
    ) as { id: string } | undefined;
    if (existingJob) { skipped++; continue; }

    // Stat the file (sync — fast)
    let fileSize = 0;
    let mtime = 0;
    try { const st = statSync(fullPath); fileSize = st.size; mtime = Math.floor(st.mtimeMs); } catch { skipped++; continue; }

    // Skip files below minimum size (junk/promo stubs)
    if (fileSize < MIN_VIDEO_SIZE) { skipped++; continue; }

    const cached = getCachedScanEntry(fullPath, mtime);
    let analysis: FileAnalysis;
    if (cached) {
      if (!cached.needsOptimization) { skipped++; continue; }
      analysis = { ...cached, sourceCodec: "", sourceAudioCodec: "", sourceContainer: "", canDirectPlay: false };
    } else {
      // Async probe — yields to event loop, doesn't block HTTP requests
      analysis = await analyzeFileAsync(fullPath);
      persistScanEntry(fullPath, analysis, fileSize, mtime);
      if (!analysis.needsOptimization) { skipped++; continue; }
    }

    // Classify the type of work needed
    if (analysis.canTransmux && analysis.reason.toLowerCase().includes("remux")) {
      breakdown.transmux++;
    } else if (analysis.reason.toLowerCase().includes("audio")) {
      breakdown.audioReencode++;
    } else {
      breakdown.fullTranscode++;
    }

    if (queueJobs) {
      queueOptimization(fullPath);
    }
    queued++;

    // Yield every file to keep the server responsive
    await yieldToEventLoop();
  }

  // Store last scan timestamp
  const now = new Date().toISOString();
  db.run(sql`INSERT INTO settings (key, value) VALUES ('last_library_scan_at', ${now})
             ON CONFLICT(key) DO UPDATE SET value = ${now}`);
  db.run(sql`INSERT INTO settings (key, value) VALUES ('last_scan_directory', ${dirPath})
             ON CONFLICT(key) DO UPDATE SET value = ${dirPath}`);

  return { scanned, queued, skipped, breakdown, lastScanAt: now };
}

// ── Library health summary ────────────────────────────────────────────────

export function getLibraryHealth(filterRoots?: string[]): LibraryHealthSummary {
  // When filterRoots is provided, only count files under those directories
  const dirFilter = filterRoots && filterRoots.length > 0
    ? sql.raw(` WHERE (${filterRoots.map((r) => `s.file_path LIKE '${r.replace(/'/g, "''")}%'`).join(" OR ")})`)
    : sql.raw("");

  // Exclude files that already have active optimization jobs — they're being handled
  const query = sql`SELECT
    COUNT(*) as total,
    SUM(CASE WHEN s.needs_optimization = 0 THEN 1 ELSE 0 END) as optimal,
    SUM(CASE WHEN s.needs_optimization = 1 AND j.id IS NULL THEN 1 ELSE 0 END) as needs_opt,
    SUM(CASE WHEN s.needs_optimization = 1 AND j.id IS NULL AND s.can_transmux = 1 AND s.reason LIKE '%remux%' THEN 1 ELSE 0 END) as transmux,
    SUM(CASE WHEN s.needs_optimization = 1 AND j.id IS NULL AND s.reason LIKE '%Audio%' THEN 1 ELSE 0 END) as audio_reencode,
    SUM(CASE WHEN s.needs_optimization = 1 AND j.id IS NULL AND s.can_transmux = 0 AND s.reason NOT LIKE '%Audio%' AND s.reason NOT LIKE '%remux%' THEN 1 ELSE 0 END) as full_transcode,
    SUM(s.file_size) as total_size
    FROM library_scan_results s
    LEFT JOIN optimization_jobs j ON j.source_path = s.file_path AND j.status IN ('queued', 'running', 'completed')${dirFilter}`;

  const rows = db.all(query) as Array<{
    total: number; optimal: number; needs_opt: number;
    transmux: number; audio_reencode: number; full_transcode: number; total_size: number;
  }>;

  const row = rows[0] ?? { total: 0, optimal: 0, needs_opt: 0, transmux: 0, audio_reencode: 0, full_transcode: 0, total_size: 0 };

  const lastScan = db.get(sql`SELECT value FROM settings WHERE key = 'last_library_scan_at'`) as { value: string } | undefined;

  const dirsQuery = filterRoots && filterRoots.length > 0
    ? sql`SELECT DISTINCT directory FROM library_scan_results s${dirFilter}`
    : sql`SELECT DISTINCT directory FROM library_scan_results`;
  const dirs = (db.all(dirsQuery) as Array<{ directory: string }>).map(r => r.directory);

  return {
    totalFiles: row.total ?? 0,
    optimal: row.optimal ?? 0,
    needsOptimization: row.needs_opt ?? 0,
    needsTransmux: row.transmux ?? 0,
    needsAudioConvert: row.audio_reencode ?? 0,
    needsFullTranscode: row.full_transcode ?? 0,
    totalSizeBytes: row.total_size ?? 0,
    lastScanAt: lastScan?.value ?? null,
    directories: dirs,
  };
}

/** Get scan entries for files matching given basenames (for frontend lookup). */
export function getScanEntriesByBasenames(basenames: string[]): Record<string, { needsOptimization: boolean; videoCodec: string; audioCodec: string; container: string }> {
  if (basenames.length === 0) return {};
  const result: Record<string, { needsOptimization: boolean; videoCodec: string; audioCodec: string; container: string }> = {};
  // Query all scan results and match by basename for cross-path compatibility
  const allRows = db.all(sql`SELECT file_path, video_codec, audio_codec, container, needs_optimization FROM library_scan_results`) as
    Array<{ file_path: string; video_codec: string; audio_codec: string; container: string; needs_optimization: number }>;
  const basenameSet = new Set(basenames.map(b => b.toLowerCase()));
  for (const row of allRows) {
    const name = basename(row.file_path);
    const stem = name.substring(0, name.lastIndexOf(".")).toLowerCase();
    if (basenameSet.has(stem)) {
      result[stem] = {
        needsOptimization: !!row.needs_optimization,
        videoCodec: row.video_codec,
        audioCodec: row.audio_codec,
        container: row.container,
      };
    }
  }
  return result;
}

// ── Auto-optimize scanner ──────────────────────────────────────────────────

let autoOptimizeTimer: ReturnType<typeof setInterval> | null = null;

export function startAutoOptimize(): void {
  if (autoOptimizeTimer) return;
  const config = getOptimizationConfig();
  if (!config.autoOptimize) return;

  log.info("Auto-optimize enabled, scanning every 30 minutes");
  // Initial scan after 60s to let the server settle
  setTimeout(() => {
    if (getOptimizationConfig().autoOptimize) {
      autoScan();
    }
  }, 60_000);

  autoOptimizeTimer = setInterval(() => {
    if (!getOptimizationConfig().autoOptimize) {
      stopAutoOptimize();
      return;
    }
    autoScan();
  }, 30 * 60 * 1000);
}

async function autoScan(): Promise<void> {
  // Don't scan when paused — no point queuing jobs that won't run
  if (getOptimizationConfig().paused) return;

  // Scan media roots from Radarr/Sonarr, filtered by mediaTypes setting
  try {
    const config = getOptimizationConfig();
    await refreshTaggedPathsCache();
    let tagged = [...cachedTaggedPaths];

    // Filter by media type preference
    if (config.mediaTypes !== "all") {
      tagged = tagged.filter((t) => t.source === config.mediaTypes);
    }

    let roots = tagged.map((t) => t.path);
    if (roots.length === 0) {
      const setting = getSetting("allowed_paths");
      if (setting) roots = JSON.parse(setting) as string[];
    }
    for (const root of roots) {
      const result = await scanAndQueue(root, true);
      if (result.queued > 0) {
        log.info(`Auto-scan ${root}: ${result.queued} queued, ${result.skipped} skipped`);
      }
    }
  } catch { /* ignore scan errors */ }
}

export function stopAutoOptimize(): void {
  if (autoOptimizeTimer) {
    clearInterval(autoOptimizeTimer);
    autoOptimizeTimer = null;
    log.info("Auto-optimize disabled");
  }
}
