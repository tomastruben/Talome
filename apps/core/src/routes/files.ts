import { Hono } from "hono";
import { readdir, stat, readFile, writeFile, unlink, mkdir, rename, rm } from "node:fs/promises";
import { join, resolve, basename, dirname, extname } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { getSetting, setSetting } from "../utils/settings.js";
import { db, schema } from "../db/index.js";
import type { TranscodingConfig } from "@talome/types";
import {
  TALOME_HOME,
  getAllowedRoots,
  getDetectedDrives,
  isAllowed,
  sanitizePath,
  invalidateDriveCache,
} from "../utils/filesystem.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("files");
const files = new Hono();

/** Reusable Range-aware streaming response builder. */
export async function buildStreamResponse(
  absPath: string,
  rangeHeader: string | undefined,
): Promise<Response> {
  const s = await stat(absPath);
  if (s.isDirectory()) return Response.json({ error: "Cannot stream a directory" }, { status: 400 });

  const fileSize = s.size;
  const mime = getMimeType(absPath);
  const commonHeaders: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Content-Type": mime,
    "Cache-Control": "no-store",
    "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
  };

  if (!rangeHeader) {
    const stream = createReadStream(absPath);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: { ...commonHeaders, "Content-Length": String(fileSize) },
    });
  }

  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${fileSize}` } });
  }

  let start: number;
  let end: number;

  if (match[1] && match[2]) { start = parseInt(match[1], 10); end = parseInt(match[2], 10); }
  else if (match[1]) { start = parseInt(match[1], 10); end = fileSize - 1; }
  else if (match[2]) { start = fileSize - parseInt(match[2], 10); end = fileSize - 1; }
  else { return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${fileSize}` } }); }

  start = Math.max(0, start);
  end = Math.min(end, fileSize - 1);

  if (start > end || start >= fileSize) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${fileSize}` } });
  }

  const chunkSize = end - start + 1;
  const stream = createReadStream(absPath, { start, end });
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 206,
    headers: {
      ...commonHeaders,
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Content-Length": String(chunkSize),
    },
  });
}

// ── List directory contents ─────────────────────────────────────────────

files.get("/list", async (c) => {
  const dirPath = c.req.query("path") || TALOME_HOME;
  const abs = sanitizePath(dirPath);

  if (!isAllowed(abs)) {
    return c.json({ error: "Access denied: path outside allowed directories" }, 403);
  }

  try {
    const entries = await readdir(abs, { withFileTypes: true });
    const showHidden = c.req.query("showHidden") === "true";
    const items = await Promise.all(
      entries
        .filter((e) => showHidden || !e.name.startsWith("."))
        .map(async (entry) => {
          const fullPath = join(abs, entry.name);
          try {
            const s = await stat(fullPath);
            return {
              name: entry.name,
              path: fullPath,
              isDirectory: entry.isDirectory(),
              size: s.size,
              modified: s.mtime.toISOString(),
            };
          } catch {
            return {
              name: entry.name,
              path: fullPath,
              isDirectory: entry.isDirectory(),
              size: 0,
              modified: null,
            };
          }
        }),
    );

    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    // Only allow navigating up if still inside an allowed root
    const parentDir = resolve(abs, "..");
    const canGoUp = isAllowed(parentDir) && parentDir !== abs;

    return c.json({
      path: abs,
      parent: canGoUp ? parentDir : null,
      items,
      allowedRoots: getAllowedRoots().filter((r: string) => existsSync(r)),
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── Read file contents ──────────────────────────────────────────────────

files.get("/read", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path query parameter required" }, 400);

  const abs = sanitizePath(filePath);
  if (!isAllowed(abs)) {
    return c.json({ error: "Access denied" }, 403);
  }

  try {
    const s = await stat(abs);
    if (s.isDirectory()) return c.json({ error: "Cannot read a directory" }, 400);
    if (s.size > 5 * 1024 * 1024) return c.json({ error: "File too large (max 5MB)" }, 413);

    const content = await readFile(abs, "utf-8");
    return c.json({ path: abs, name: basename(abs), size: s.size, modified: s.mtime.toISOString(), content });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── Download file ───────────────────────────────────────────────────────

files.get("/download", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path query parameter required" }, 400);

  const abs = sanitizePath(filePath);
  if (!isAllowed(abs)) return c.json({ error: "Access denied" }, 403);

  try {
    const s = await stat(abs);
    if (s.isDirectory()) return c.json({ error: "Cannot download a directory" }, 400);

    const stream = createReadStream(abs);
    const webStream = Readable.toWeb(stream) as ReadableStream;

    return new Response(webStream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${basename(abs)}"`,
        "Content-Length": String(s.size),
      },
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── Stream file (with Range support for media playback) ─────────────────

const MIME_MAP: Record<string, string> = {
  // Video
  mp4: "video/mp4", mkv: "video/x-matroska", avi: "video/x-msvideo",
  mov: "video/quicktime", webm: "video/webm",
  // Audio
  mp3: "audio/mpeg", flac: "audio/flac", ogg: "audio/ogg",
  wav: "audio/wav", aac: "audio/aac", m4a: "audio/mp4", m4b: "audio/mp4",
  // Images
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", svg: "image/svg+xml", webp: "image/webp",
  ico: "image/x-icon", bmp: "image/bmp",
  // Documents
  pdf: "application/pdf",
};

function getMimeType(filePath: string): string {
  const e = extname(filePath).slice(1).toLowerCase();
  return MIME_MAP[e] || "application/octet-stream";
}

// ── Transmux: remux MKV/AVI → MP4 for Safari compatibility ───────────────

/** Resolve ffmpeg binary — prefer jellyfin-ffmpeg (has tonemapx for HDR) over stock.
 *  Also checks common install paths (Homebrew on macOS) when ffmpeg isn't in PATH. */
let cachedFfmpegBin: string | null = null;
function getFfmpegBin(): string {
  if (cachedFfmpegBin) return cachedFfmpegBin;
  // 1. Prefer jellyfin-ffmpeg (has tonemapx for HDR→SDR)
  const jfPath = join(process.env.HOME ?? "/tmp", ".local", "bin", "jellyfin-ffmpeg");
  try { execSync(`"${jfPath}" -version`, { stdio: "ignore" }); cachedFfmpegBin = jfPath; }
  catch {
    // 2. Try ffmpeg from PATH
    try { execSync("ffmpeg -version", { stdio: "ignore" }); cachedFfmpegBin = "ffmpeg"; }
    catch {
      // 3. Check common install locations (launchd/cron don't inherit shell PATH)
      const commonPaths = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
      for (const p of commonPaths) {
        try { execSync(`"${p}" -version`, { stdio: "ignore" }); cachedFfmpegBin = p; break; }
        catch { /* not here */ }
      }
      if (!cachedFfmpegBin) cachedFfmpegBin = "ffmpeg"; // will fail gracefully in hasFfmpeg()
    }
  }
  console.log(`[hls] using ffmpeg: ${cachedFfmpegBin}`);
  return cachedFfmpegBin;
}

let ffmpegAvailable: boolean | null = null;
function hasFfmpeg(): boolean {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try { execSync(`"${getFfmpegBin()}" -version`, { stdio: "ignore" }); ffmpegAvailable = true; }
  catch { ffmpegAvailable = false; }
  return ffmpegAvailable;
}

/** Check if jellyfin-ffmpeg (with tonemapx) is available. */
function hasTonemapx(): boolean {
  return getFfmpegBin().includes("jellyfin");
}

// ── Media probing ────────────────────────────────────────────────────────

interface ProbeTrack {
  index: number;
  codec: string;
  language: string;
  title: string;
}

interface ProbeAudioTrack extends ProbeTrack {
  channels: number;
}

interface ProbeSubTrack extends ProbeTrack {
  textBased: boolean;
}

interface ProbeResult {
  duration: number;
  videoCodec: string;
  /** Codec tag string from container (e.g. "hev1", "dvhe", "avc1") */
  videoCodecTag?: string;
  /** Color transfer characteristics (e.g. "smpte2084" for HDR10, "arib-std-b67" for HLG) */
  videoColorTransfer?: string;
  /** Color primaries (e.g. "bt2020" for HDR/WCG, "bt709" for SDR) */
  videoColorPrimaries?: string;
  /** Color space / matrix coefficients (e.g. "bt2020nc" for HDR, "bt709" for SDR) */
  videoColorSpace?: string;
  /** Pixel format (e.g. "yuv420p", "yuv420p10le" for 10-bit) */
  videoPixFmt?: string;
  audio: ProbeAudioTrack[];
  subtitle: ProbeSubTrack[];
}

const IMAGE_SUB_CODECS = new Set(["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle"]);

export { MIME_MAP, getMimeType, hasFfmpeg };
export type { ProbeResult, ProbeAudioTrack, ProbeSubTrack };

export function probeFile(filePath: string): ProbeResult {
  try {
    // Derive ffprobe path from resolved ffmpeg binary (same directory)
    const ffmpegBin = getFfmpegBin();
    const ffprobeBin = ffmpegBin.endsWith("ffmpeg")
      ? ffmpegBin.replace(/ffmpeg$/, "ffprobe")
      : "ffprobe";
    const out = execSync(
      `"${ffprobeBin}" -v error -print_format json -show_format -show_streams "${filePath}"`,
      { encoding: "utf-8", timeout: 15_000 },
    );
    const data = JSON.parse(out);
    const duration = parseFloat(data.format?.duration ?? "0") || 0;

    let videoCodec = "";
    let audioIdx = 0;
    let subIdx = 0;
    const audio: ProbeAudioTrack[] = [];
    const subtitle: ProbeSubTrack[] = [];

    let videoCodecTag = "";
    let videoColorTransfer = "";
    let videoColorPrimaries = "";
    let videoColorSpace = "";
    let videoPixFmt = "";

    for (const s of data.streams ?? []) {
      if (s.codec_type === "video" && !videoCodec) {
        videoCodec = s.codec_name ?? "";
        videoCodecTag = s.codec_tag_string ?? "";
        videoColorTransfer = s.color_transfer ?? "";
        videoColorPrimaries = s.color_primaries ?? "";
        videoColorSpace = s.color_space ?? "";
        videoPixFmt = s.pix_fmt ?? "";
      } else if (s.codec_type === "audio") {
        audio.push({
          index: audioIdx++,
          language: s.tags?.language ?? "und",
          title: s.tags?.title ?? "",
          codec: s.codec_name ?? "",
          channels: s.channels ?? 0,
        });
      } else if (s.codec_type === "subtitle") {
        const codec = s.codec_name ?? "";
        subtitle.push({
          index: subIdx++,
          language: s.tags?.language ?? "und",
          title: s.tags?.title ?? "",
          codec,
          textBased: !IMAGE_SUB_CODECS.has(codec),
        });
      }
    }

    return { duration, videoCodec, videoCodecTag, videoColorTransfer, videoColorPrimaries, videoColorSpace, videoPixFmt, audio, subtitle };
  } catch {
    return { duration: 0, videoCodec: "", audio: [], subtitle: [] };
  }
}

/** GET /probe — return track metadata for a media file. */
files.get("/probe", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path required" }, 400);

  const abs = sanitizePath(filePath);
  if (!isAllowed(abs)) return c.json({ error: "Access denied" }, 403);
  if (!hasFfmpeg()) return c.json({ error: "ffmpeg not available" }, 500);

  return c.json(probeFile(abs));
});

/** GET /subtitle — extract a subtitle track as WebVTT. */
files.get("/subtitle", async (c) => {
  const filePath = c.req.query("path");
  const indexStr = c.req.query("index");
  if (!filePath) return c.json({ error: "path required" }, 400);

  const abs = sanitizePath(filePath);
  if (!isAllowed(abs)) return c.json({ error: "Access denied" }, 403);
  if (!hasFfmpeg()) return c.json({ error: "ffmpeg not available" }, 500);

  const subIndex = parseInt(indexStr ?? "0", 10);

  const vtt = await new Promise<Buffer | null>((resolve) => {
    // Use -copyts -start_at_zero so subtitle timestamps are shifted by the
    // container's global start_time (= video start PTS). This matches the HLS
    // output which remaps video timestamps to 0 from the same reference point.
    const proc = spawn(getFfmpegBin(), [
      "-copyts", "-start_at_zero",
      "-i", abs,
      "-map", `0:s:${subIndex}`,
      "-f", "webvtt",
      "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", () => { /* drain */ });
    proc.on("close", (code) => resolve(code === 0 && chunks.length > 0 ? Buffer.concat(chunks) : null));
    proc.on("error", () => resolve(null));
  });

  if (!vtt) return c.json({ error: "Failed to extract subtitle" }, 500);

  return new Response(vtt.toString("utf-8"), {
    headers: {
      "Content-Type": "text/vtt; charset=utf-8",
      "Cache-Control": "max-age=3600",
    },
  });
});

// ── HLS streaming for Safari ──────────────────────────────────────────────

import type { ChildProcess } from "node:child_process";

/** Resolve the HLS output root, using the user-configured directory if set. */
function getHlsOutRoot(): string {
  return getSetting("transcoding_hls_temp_dir") || "/tmp/talome/hls";
}
/** Default constant for backward compat — use getHlsOutRoot() for runtime. */
const HLS_OUT_ROOT = "/tmp/talome/hls";
const HLS_MAX_JOBS = 5;
/** Idle timeout: kill HLS job after no segment/ping activity (Jellyfin uses 60s). */
const HLS_IDLE_TIMEOUT_MS = 90_000;
/** How often to check for idle jobs. */
const HLS_IDLE_CHECK_MS = 15_000;

interface HlsJob {
  hash: string;
  outDir: string;
  srcPath: string;
  proc: ChildProcess | null;
  done: boolean;
  createdAt: number;
  /** Last time a segment was fetched or a ping was received. */
  lastActivity: number;
}

/** Track in-flight HLS jobs. Key = srcPath:aTrack:sSeek */
const hlsJobs = new Map<string, HlsJob>();

/** Idle reaper interval — started once, runs forever. */
let idleReaperStarted = false;
function ensureIdleReaper() {
  if (idleReaperStarted) return;
  idleReaperStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [key, job] of hlsJobs.entries()) {
      if (job.done && now - job.lastActivity > HLS_IDLE_TIMEOUT_MS) {
        console.log("[hls] idle reaper: cleaning", key, "(idle", Math.round((now - job.lastActivity) / 1000), "s)");
        void killJob(key, job);
      } else if (!job.done && now - job.lastActivity > HLS_IDLE_TIMEOUT_MS * 2) {
        // Running job with no activity for 2x timeout — client likely disconnected
        console.log("[hls] idle reaper: killing abandoned job", key);
        void killJob(key, job);
      }
    }
  }, HLS_IDLE_CHECK_MS);
}

/** Lookup job output directory by hash (for the serving endpoint). */
export function hlsOutDirByHash(hash: string): string | null {
  for (const job of hlsJobs.values()) {
    if (job.hash === hash) return job.outDir;
  }
  // Fallback: check filesystem (job map is lost on server restart)
  if (/^[a-f0-9]+$/.test(hash)) {
    const root = getHlsOutRoot();
    const candidate = join(root, hash);
    if (existsSync(candidate)) return candidate;
    // Also check default location if configured dir is different
    if (root !== HLS_OUT_ROOT) {
      const defaultCandidate = join(HLS_OUT_ROOT, hash);
      if (existsSync(defaultCandidate)) return defaultCandidate;
    }
  }
  return null;
}

/** Record activity for a job by hash (segment fetch or ping). */
export function touchJob(hash: string) {
  for (const job of hlsJobs.values()) {
    if (job.hash === hash) { job.lastActivity = Date.now(); return; }
  }
}

/** Kill an ffmpeg process and clean up its output directory. */
async function killJob(key: string, job: HlsJob) {
  if (job.proc && !job.done) {
    try { job.proc.kill("SIGKILL"); } catch { /* already dead */ }
  }
  try { await rm(job.outDir, { recursive: true, force: true }); } catch { /* already gone */ }
  hlsJobs.delete(key);
}

/** Kill all running HLS jobs for a given source file (e.g. on re-seek). */
async function killJobsForSource(srcPath: string, keepKey?: string) {
  const toKill = [...hlsJobs.entries()].filter(
    ([k, j]) => j.srcPath === srcPath && k !== keepKey,
  );
  await Promise.all(toKill.map(([k, j]) => killJob(k, j)));
}

/** Remove oldest finished HLS jobs when over the limit. */
async function pruneHlsCache() {
  if (hlsJobs.size <= HLS_MAX_JOBS) return;
  const finished = [...hlsJobs.entries()]
    .filter(([, j]) => j.done)
    .sort(([, a], [, b]) => a.createdAt - b.createdAt);

  while (hlsJobs.size > HLS_MAX_JOBS && finished.length > 0) {
    const [key, job] = finished.shift()!;
    await killJob(key, job);
  }
}

/** Stop all HLS jobs for a given hash and clean up. */
export async function stopHls(hash: string) {
  const entries = [...hlsJobs.entries()].filter(([, j]) => j.hash === hash);
  await Promise.all(entries.map(([k, j]) => killJob(k, j)));
}

/** Stop ALL running HLS jobs (server shutdown). */
export async function stopAllHls() {
  await Promise.all([...hlsJobs.entries()].map(([k, j]) => killJob(k, j)));
}

/** Clean up stale transmux files on startup (orphaned from previous server run). */
export async function cleanupStaleTransmuxOnStartup() {
  try {
    const txRoot = getTransmuxRoot();
    const entries = await readdir(txRoot);
    let cleaned = 0;
    let freedBytes = 0;
    for (const f of entries) {
      if (!f.endsWith(".mp4")) continue;
      const fp = join(txRoot, f);
      try {
        const s = await stat(fp);
        freedBytes += s.size;
        await unlink(fp);
        cleaned++;
      } catch { /* skip */ }
    }
    if (cleaned > 0) console.log(`[transmux] startup cleanup: removed ${cleaned} stale file(s), freed ${(freedBytes / 1e9).toFixed(1)} GB`);
  } catch { /* dir doesn't exist yet — fine */ }
}

/** Clean up stale HLS files on startup (orphaned from previous server run). */
export async function cleanupStaleHlsOnStartup() {
  try {
    const hlsRoot = getHlsOutRoot();
    const entries = await readdir(hlsRoot, { withFileTypes: true });
    let cleaned = 0;
    for (const e of entries) {
      if (e.isDirectory()) {
        await rm(join(hlsRoot, e.name), { recursive: true, force: true });
        cleaned++;
      }
    }
    if (cleaned > 0) console.log(`[hls] startup cleanup: removed ${cleaned} stale cache dir(s)`);
  } catch { /* dir doesn't exist yet — fine */ }
}

/** Get HLS cache statistics. */
export async function getHlsCacheStats() {
  let totalSize = 0;
  let jobCount = 0;
  let runningCount = 0;

  for (const job of hlsJobs.values()) {
    jobCount++;
    if (!job.done) runningCount++;
    try {
      const entries = await readdir(job.outDir);
      for (const f of entries) {
        try { const s = await stat(join(job.outDir, f)); totalSize += s.size; } catch { /* skip */ }
      }
    } catch { /* dir gone */ }
  }

  // Orphan dirs not tracked in hlsJobs
  try {
    const hlsRoot = getHlsOutRoot();
    const rootEntries = await readdir(hlsRoot, { withFileTypes: true });
    const trackedHashes = new Set([...hlsJobs.values()].map((j) => j.hash));
    for (const e of rootEntries) {
      if (e.isDirectory() && !trackedHashes.has(e.name)) {
        jobCount++;
        const dirPath = join(hlsRoot, e.name);
        try {
          const files = await readdir(dirPath);
          for (const f of files) {
            try { const s = await stat(join(dirPath, f)); totalSize += s.size; } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* root doesn't exist yet */ }

  return { jobCount, runningCount, totalSize };
}

/** Clear ALL HLS cache (active + orphan). Returns bytes freed. */
export async function clearAllHlsCache(): Promise<number> {
  let freedSize = 0;

  // Sum sizes before deleting
  for (const job of hlsJobs.values()) {
    try {
      const entries = await readdir(job.outDir);
      for (const f of entries) {
        try { const s = await stat(join(job.outDir, f)); freedSize += s.size; } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  await stopAllHls();

  // Orphan dirs
  try {
    const hlsRoot = getHlsOutRoot();
    const rootEntries = await readdir(hlsRoot, { withFileTypes: true });
    for (const e of rootEntries) {
      if (e.isDirectory()) {
        const dirPath = join(hlsRoot, e.name);
        try {
          const entries = await readdir(dirPath);
          for (const f of entries) {
            try { const s = await stat(join(dirPath, f)); freedSize += s.size; } catch { /* skip */ }
          }
        } catch { /* skip */ }
        await rm(dirPath, { recursive: true, force: true });
      }
    }
  } catch { /* root doesn't exist */ }

  return freedSize;
}

/** Codecs that Safari HLS can play with -c:v copy. */
const HLS_COPY_CODECS = new Set(["h264", "hevc", "h265"]);

/** Detect available HW video encoder (cached). */
let cachedHwEncoder: string | null | undefined;
function detectHwEncoder(): string | null {
  if (cachedHwEncoder !== undefined) return cachedHwEncoder;
  try {
    const out = execSync(`"${getFfmpegBin()}" -encoders 2>&1`, { encoding: "utf-8", timeout: 5_000 });
    if (out.includes("hevc_videotoolbox")) cachedHwEncoder = "hevc_videotoolbox";
    else if (out.includes("h264_videotoolbox")) cachedHwEncoder = "h264_videotoolbox";
    else if (out.includes("hevc_vaapi")) cachedHwEncoder = "hevc_vaapi";
    else if (out.includes("h264_vaapi")) cachedHwEncoder = "h264_vaapi";
    else cachedHwEncoder = null;
  } catch { cachedHwEncoder = null; }
  console.log("[hls] hw encoder:", cachedHwEncoder ?? "none (software fallback)");
  return cachedHwEncoder;
}

// v5: no -copyts, timestamps start at 0 natively
// v7: added hw tonemap pipeline — bust cache from v6
function hlsHash(srcPath: string, audioTrack: number, seekTo: number, transcodeVideo = false): string {
  return createHash("md5").update(`v9:${srcPath}:a${audioTrack}:s${Math.floor(seekTo)}:tv${transcodeVideo ? 1 : 0}`).digest("hex");
}

/** Build video encoding args based on source codec + HW availability.
 *  Matches Jellyfin's approach: BSF for copy, profile/level/keyframes for transcode.
 *  When transcodeVideo=true, HEVC is transcoded to H.264 for browsers that can't play it. */
function buildVideoArgs(videoCodec: string, transcodeVideo = false, colorTransfer = ""): string[] {
  const isHevc = videoCodec === "hevc" || videoCodec === "h265";

  if (transcodeVideo) {
    if (isHevc) {
      const hasKnownHdr = colorTransfer === "smpte2084" || colorTransfer === "arib-std-b67";

      // Use VideoToolbox for hw decode + encode, software zscale for tonemap.
      // ~3x faster than full software pipeline at 4K.
      const useHw = detectHwEncoder()?.includes("videotoolbox");

      const jf = hasTonemapx();

      if (hasKnownHdr) {
        // HDR10/HLG tonemap to SDR.
        // jellyfin-ffmpeg: tonemapx (SIMD optimized, ~67fps at 4K)
        // stock ffmpeg: zscale (slower but works)
        const vf = jf
          ? "format=p010le,tonemapx=tonemap=hable:format=yuv420p"
          : "format=p010le,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p";
        return [
          ...(useHw ? ["-hwaccel", "videotoolbox"] : []),
          "-vf", vf,
          "-c:v", useHw ? "h264_videotoolbox" : "libx264",
          ...(useHw ? ["-b:v", "20M"] : ["-preset", "fast", "-crf", "22"]),
          "-profile:v", "high",
          "-force_key_frames", "expr:gte(t,n_forced*6)",
        ];
      }

      // DV or missing color metadata — inject fake HDR10 metadata first.
      const vf = jf
        ? "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,format=p010le,tonemapx=tonemap=hable:format=yuv420p"
        : "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,format=p010le,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p";
      return [
        ...(useHw ? ["-hwaccel", "videotoolbox"] : []),
        "-vf", vf,
        "-c:v", useHw ? "h264_videotoolbox" : "libx264",
        ...(useHw ? ["-b:v", "20M"] : ["-preset", "fast", "-crf", "22"]),
        "-profile:v", "high",
        "-force_key_frames", "expr:gte(t,n_forced*6)",
      ];
    }
    // Non-HEVC legacy codecs (MPEG4, MPEG2) — hardware encode if available
    try {
      const out = execSync(`"${getFfmpegBin()}" -encoders 2>&1`, { encoding: "utf-8", timeout: 5_000 });
      if (out.includes("h264_videotoolbox")) {
        return [
          "-hwaccel", "videotoolbox",
          "-c:v", "h264_videotoolbox",
          "-b:v", "8M", "-qmin", "-1", "-qmax", "-1",
          "-profile:v", "high",
          "-force_key_frames", "expr:gte(t,n_forced*6)",
        ];
      }
    } catch { /* fall through */ }
    return [
      "-c:v", "libx264", "-preset", "fast", "-crf", "22",
      "-profile:v", "high",
      "-force_key_frames", "expr:gte(t,n_forced*6)",
    ];
  }

  if (HLS_COPY_CODECS.has(videoCodec)) {
    // fMP4 segments keep NAL units in length-prefixed format (same as MP4/MKV),
    // so no BSF conversion needed. BSFs are only for MPEG-TS (Annex B).
    // For HEVC, tag as hvc1 so Safari recognises the codec in fMP4 init segment.
    const args = ["-c:v", "copy"];
    if (isHevc) args.push("-tag:v", "hvc1");
    return args;
  }

  const hw = detectHwEncoder();
  if (hw) {
    const isHwHevc = hw.startsWith("hevc");
    return [
      ...(hw.includes("videotoolbox") ? ["-hwaccel", "videotoolbox"] : []),
      "-c:v", hw, "-b:v", "8M", "-qmin", "-1", "-qmax", "-1",
      ...(isHwHevc ? ["-tag:v", "hvc1"] : []),
      "-force_key_frames", "expr:gte(t,n_forced*6)",
    ];
  }

  return ["-c:v", "libx264", "-preset", "fast", "-crf", "22", "-force_key_frames", "expr:gte(t,n_forced*6)"];
}

/** Start HLS segmentation in background. Returns hash immediately. */
export function startHls(srcPath: string, audioTrack = 0, seekTo = 0, videoCodec = "", transcodeVideo = false, colorTransfer = "", colorPrimaries = "", colorSpace = ""): string {
  const hash = hlsHash(srcPath, audioTrack, seekTo, transcodeVideo);
  // Use hash as key so version bumps (v4→v5) naturally invalidate old entries
  const existing = hlsJobs.get(hash);
  if (existing) {
    // Reuse if: playlist exists, or process is genuinely still running
    const playlistExists = existsSync(join(existing.outDir, "playlist.m3u8"));
    const processAlive = existing.proc && !existing.proc.killed && existing.proc.exitCode === null;
    if (playlistExists || processAlive) return hash;
    // Job finished/crashed without producing output — remove stale entry and restart
    console.log("[hls] removing stale job:", hash);
    hlsJobs.delete(hash);
  }

  // Output to configured temp dir, or alongside source when user prefers media drive
  const useSourceFolder = getSetting("transcoding_use_source_folder") === "true";
  let outDir: string;
  if (useSourceFolder) {
    try {
      const srcDir = join(dirname(srcPath), ".talome-hls");
      mkdirSync(srcDir, { recursive: true });
      outDir = join(srcDir, hash);
    } catch {
      console.warn("[hls] cannot write to source folder, falling back to system temp");
      outDir = join(getHlsOutRoot(), hash);
    }
  } else {
    outDir = join(getHlsOutRoot(), hash);
  }
  const now = Date.now();
  const job: HlsJob = { hash, outDir, srcPath, proc: null, done: false, createdAt: now, lastActivity: now };
  ensureIdleReaper();
  hlsJobs.set(hash, job);

  const videoArgs = buildVideoArgs(videoCodec, transcodeVideo, colorTransfer);
  const isCopy = videoArgs.includes("copy");
  console.log("[hls] starting:", srcPath, "audio:", audioTrack, "seek:", seekTo, "video:", isCopy ? "copy" : videoArgs.join(" "), "transcode:", transcodeVideo, "→", outDir);

  void (async () => {
    // Kill old jobs FIRST, wait for them to die, then create output dir.
    // Without await, killJobsForSource races with mkdir and can delete
    // the directory while ffmpeg is writing segments → "No such file".
    await killJobsForSource(srcPath, hash);
    await pruneHlsCache();

    // Clean output dir — stale files from killed jobs cause corrupt playlists
    await rm(outDir, { recursive: true, force: true }).catch((err) => log.debug("Failed to clean HLS output dir before transcode", err));
    await mkdir(outDir, { recursive: true });
    await new Promise<void>((res) => {
      const args: string[] = [];

      // Jellyfin-style HLS: exact same flags that Jellyfin uses for
      // video copy + audio transcode to fMP4 HLS segments.
      // Input seeking before -i, +genpts for copy codec.
      if (seekTo > 0) args.push("-ss", String(seekTo), "-noaccurate_seek");
      args.push("-fflags", "+genpts");

      const hwIdx = videoArgs.indexOf("-hwaccel");
      if (hwIdx >= 0) args.push("-hwaccel", videoArgs[hwIdx + 1]);

      // fMP4 HLS — works in both Safari and Chrome.
      // Key flags:
      //   -start_at_zero: remap timestamps to start at 0 (no -copyts — we don't
      //   want the source PTS offset leaking into video.currentTime)
      //   -hls_segment_type fmp4: fragmented MP4 segments (not MPEG-TS)
      //   movflags=+frag_discont: correct DTS/PTS handling across fMP4 segments
      //   -ac 2: stereo downmix (Chrome's AAC decoder only supports stereo)
      const filteredVideoArgs = videoArgs.filter((_, i) => !(videoArgs[i - 1] === "-hwaccel" || videoArgs[i] === "-hwaccel"));

      // When copying HDR video, explicitly set color metadata so fMP4 init segment
      // signals HDR correctly to the browser (MKV→fMP4 may lose stream-level tags).
      const colorArgs: string[] = [];
      if (isCopy && colorPrimaries) colorArgs.push("-color_primaries", colorPrimaries);
      if (isCopy && colorTransfer) colorArgs.push("-color_trc", colorTransfer);
      if (isCopy && colorSpace) colorArgs.push("-colorspace", colorSpace);

      args.push(
        "-i", srcPath,
        "-map_metadata:g", "-1", "-map_chapters", "-1",
        "-map", "0:v:0", "-map", `0:a:${audioTrack}`,
        ...filteredVideoArgs,
        ...colorArgs,
        "-c:a", "aac", "-b:a", "192k", "-ac", "2",
        "-start_at_zero",
        "-max_muxing_queue_size", "2048",
        "-f", "hls",
        "-max_delay", "0",
        "-hls_time", "4",
        "-hls_init_time", "1",
        "-hls_list_size", "0",
        "-hls_playlist_type", "event",
        "-hls_segment_type", "fmp4",
        "-hls_fmp4_init_filename", "init.mp4",
        "-hls_segment_options", "movflags=+frag_discont",
        "-hls_segment_filename", join(outDir, "seg_%04d.m4s"),
        join(outDir, "playlist.m3u8"),
      );

      console.log("[hls] cmd: ffmpeg", args.join(" "));
      const proc = spawn(getFfmpegBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
      job.proc = proc;

      let stderrTail = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        const s = chunk.toString();
        stderrTail = (stderrTail + s).slice(-2000);
      });
      proc.stdout?.on("data", () => { /* drain */ });

      proc.on("close", (code) => {
        job.done = true;
        job.proc = null;
        if (code === 0) console.log("[hls] done:", outDir);
        else if (code !== null) console.error("[hls] failed, code:", code, "\n", stderrTail);
        res();
      });
      proc.on("error", (e) => { job.done = true; job.proc = null; console.error("[hls] spawn error:", e.message); res(); });
    });
  })();

  return hash;
}

/** GET /hls-start — kick off HLS conversion, return hash + probe data. */
files.get("/hls-start", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path required" }, 400);

  const abs = sanitizePath(filePath);
  if (!isAllowed(abs)) return c.json({ error: "Access denied" }, 403);
  if (!hasFfmpeg()) return c.json({ error: "ffmpeg not available" }, 500);

  const audioTrack = parseInt(c.req.query("audioTrack") ?? "0", 10);
  const seekTo = parseFloat(c.req.query("seekTo") ?? "0");
  const transcodeVideo = c.req.query("transcodeVideo") === "1";
  const probe = probeFile(abs);
  const hash = startHls(abs, audioTrack, seekTo, probe.videoCodec, transcodeVideo, probe.videoColorTransfer ?? "", probe.videoColorPrimaries ?? "", probe.videoColorSpace ?? "");
  return c.json({ hash, ...probe });
});

/** GET /hls/:hash/:file — serve HLS playlist and segments. */
files.get("/hls/:hash/:file", async (c) => {
  const hash = c.req.param("hash");
  const file = c.req.param("file");

  if (!/^[a-f0-9]+$/.test(hash) || /[/\\]/.test(file)) {
    return c.json({ error: "Invalid path" }, 400);
  }

  const outDir = hlsOutDirByHash(hash);
  if (!outDir) return c.json({ error: "Not found" }, 404);

  // Record activity — keeps idle reaper from cleaning this job
  touchJob(hash);

  const filePath = join(outDir, file);

  try {
    const s = await stat(filePath);
    const stream = createReadStream(filePath);

    let contentType = "application/octet-stream";
    if (file.endsWith(".m3u8")) contentType = "application/vnd.apple.mpegurl";
    else if (file.endsWith(".m4s")) contentType = "video/mp4";
    else if (file.endsWith(".mp4")) contentType = "video/mp4";
    else if (file.endsWith(".ts")) contentType = "video/mp2t";

    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(s.size),
        "Cache-Control": file.endsWith(".m3u8") ? "no-store" : "max-age=3600",
        "Access-Control-Allow-Origin": c.req.header("origin") ?? "*",
        "Access-Control-Allow-Credentials": "true",
      },
    });
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
});

/** POST /hls-stop — kill ffmpeg process and clean up HLS files for a given hash. */
files.post("/hls-stop", async (c) => {
  const body = await c.req.json<{ hash: string }>().catch(() => ({ hash: "" }));
  if (!body.hash) return c.json({ error: "hash required" }, 400);
  await stopHls(body.hash);
  return c.json({ ok: true });
});

/** POST /hls-ping — keep-alive from client, resets idle timer. */
files.post("/hls-ping", async (c) => {
  const body = await c.req.json<{ hash: string }>().catch(() => ({ hash: "" }));
  if (!body.hash) return c.json({ error: "hash required" }, 400);
  touchJob(body.hash);
  return c.json({ ok: true });
});

/** GET /hls-cache — return stats about HLS cache. */
files.get("/hls-cache", async (c) => {
  const stats = await getHlsCacheStats();
  return c.json(stats);
});

/** POST /hls-cache/clear — stop all jobs and clear all HLS cache. */
files.post("/hls-cache/clear", async (c) => {
  const freedSize = await clearAllHlsCache();
  return c.json({ ok: true, freedSize });
});

// ── Transmux: remux MKV → MP4 for Chrome direct playback ──────────────

/** Resolve the transmux output root, using the user-configured directory if set. */
function getTransmuxRoot(): string {
  return getSetting("transcoding_transmux_temp_dir") || "/tmp/talome-transmux";
}
export const TRANSMUX_ROOT = "/tmp/talome-transmux";

interface TransmuxJob {
  hash: string;
  srcPath: string;
  outPath: string;
  proc: ChildProcess | null;
  done: boolean;
  error: boolean;
  createdAt: number;
  /** Duration in seconds from probe (for progress calc). */
  durationSecs: number;
  /** Current progress time in seconds (parsed from ffmpeg stderr). */
  progressSecs: number;
}

export const transmuxJobs = new Map<string, TransmuxJob>();

function transmuxHash(srcPath: string): string {
  try {
    const s = statSync(srcPath);
    return createHash("md5").update(`tx1:${srcPath}:${s.mtimeMs}`).digest("hex");
  } catch {
    return createHash("md5").update(`tx1:${srcPath}`).digest("hex");
  }
}

/** Start MKV→MP4 transmux. Copies video, transcodes audio to AAC for browser compat.
 *  If primary audio is already AAC, copies it instead of re-encoding. */
export function startTransmux(srcPath: string, videoCodec: string, durationSecs = 0, primaryAudioCodec = ""): string {
  const hash = transmuxHash(srcPath);

  const existing = transmuxJobs.get(hash);
  if (existing) {
    if (!existing.error && (existing.done ? existsSync(existing.outPath) : true)) return hash;
    transmuxJobs.delete(hash);
  }

  const useSourceFolder = getSetting("transcoding_use_source_folder") === "true";
  let txRoot: string;
  if (useSourceFolder) {
    try {
      txRoot = join(dirname(srcPath), ".talome-transmux");
      mkdirSync(txRoot, { recursive: true });
    } catch {
      console.warn("[transmux] cannot write to source folder, falling back to system temp");
      txRoot = getTransmuxRoot();
    }
  } else {
    txRoot = getTransmuxRoot();
  }
  const outPath = join(txRoot, `${hash}.mp4`);

  // Filesystem cache hit
  if (existsSync(outPath)) {
    transmuxJobs.set(hash, { hash, srcPath, outPath, proc: null, done: true, error: false, createdAt: Date.now(), durationSecs, progressSecs: durationSecs });
    return hash;
  }

  const job: TransmuxJob = { hash, srcPath, outPath, proc: null, done: false, error: false, createdAt: Date.now(), durationSecs, progressSecs: 0 };
  transmuxJobs.set(hash, job);

  const isHevc = videoCodec === "hevc" || videoCodec === "h265";
  const audioIsAac = primaryAudioCodec === "aac";

  void (async () => {
    await mkdir(txRoot, { recursive: true });

    await new Promise<void>((res) => {
      // Use fragmented MP4 so the browser can start playing immediately
      // while ffmpeg is still writing. No need for faststart — fMP4 puts
      // the moov atom at the very beginning.
      const args = [
        "-i", srcPath,
        "-map", "0:v:0", "-map", "0:a:0",  // Only first audio track — saves 2-5x encoding time
        "-sn",
        "-c:v", "copy",
        ...(isHevc ? ["-tag:v", "hvc1"] : []),
        // If audio is already AAC, just copy it (instant). Otherwise re-encode.
        ...(audioIsAac
          ? ["-c:a", "copy"]
          : ["-c:a", "aac", "-b:a", "192k", "-ac", "2"]),
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-y", outPath,
      ];

      console.log("[transmux] starting:", srcPath, "→", outPath);
      const proc = spawn(getFfmpegBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
      job.proc = proc;

      proc.stdout?.on("data", () => { /* drain */ });
      // Parse ffmpeg stderr for progress (lines contain "time=HH:MM:SS.ms")
      let stderrBuf = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const timeMatch = stderrBuf.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
        if (timeMatch) {
          const [, h, m, s] = timeMatch;
          job.progressSecs = parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s);
          // Keep only the tail to avoid unbounded buffer growth
          if (stderrBuf.length > 2000) stderrBuf = stderrBuf.slice(-500);
        }
      });

      proc.on("close", (code) => {
        job.proc = null;
        if (code === 0) {
          job.done = true;
          console.log("[transmux] done:", outPath);
        } else {
          job.error = true;
          job.done = true;
          void unlink(outPath).catch(() => { /* partial file cleanup */ });
          console.error("[transmux] failed, code:", code);
        }
        res();
      });
      proc.on("error", (e) => {
        job.proc = null;
        job.error = true;
        job.done = true;
        console.error("[transmux] spawn error:", e.message);
        res();
      });
    });
  })();

  return hash;
}

/** Stop a transmux job — kill ffmpeg process and clean up output file. */
export function stopTransmux(hash: string) {
  const job = transmuxJobs.get(hash);
  if (!job) return;
  if (job.proc && !job.done) {
    try { job.proc.kill("SIGKILL"); } catch { /* already dead */ }
    job.proc = null;
  }
  // Always remove the output file — transmux is a temporary playback artifact
  if (job.outPath) {
    void unlink(job.outPath).catch(() => {});
  }
  transmuxJobs.delete(hash);
}

/** POST /transmux-stop — kill transmux process and clean up. */
files.post("/transmux-stop", async (c) => {
  const body = await c.req.json<{ hash: string }>().catch(() => ({ hash: "" }));
  if (!body.hash) return c.json({ error: "hash required" }, 400);
  stopTransmux(body.hash);
  return c.json({ ok: true });
});

/** GET /transmux-start — kick off transmux, return hash + probe data. */
files.get("/transmux-start", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path required" }, 400);

  const abs = sanitizePath(filePath);
  if (!isAllowed(abs)) return c.json({ error: "Access denied" }, 403);
  if (!hasFfmpeg()) return c.json({ error: "ffmpeg not available" }, 500);

  const probe = probeFile(abs);
  const primaryAudioCodec = probe.audio[0]?.codec ?? "";
  const hash = startTransmux(abs, probe.videoCodec, probe.duration, primaryAudioCodec);
  return c.json({ hash, ...probe });
});

/** GET /transmux-status/:hash — check if transmux is ready. */
files.get("/transmux-status/:hash", (c) => {
  const hash = c.req.param("hash");
  if (!/^[a-f0-9]+$/.test(hash)) return c.json({ error: "Invalid hash" }, 400);

  const job = transmuxJobs.get(hash);
  if (job) {
    const progress = job.durationSecs > 0 ? Math.min(job.progressSecs / job.durationSecs, 1) : 0;
    // Fragmented MP4: streamable as soon as the first fragment is written (>1KB = moov present)
    const streamable = !job.error && (job.done || (existsSync(job.outPath) && statSync(job.outPath).size > 1024));
    return c.json({ ready: streamable, error: job.error, progress, done: job.done });
  }

  const txRoot = getTransmuxRoot();
  const outPath = join(txRoot, `${hash}.mp4`);
  if (existsSync(outPath)) return c.json({ ready: true, error: false });
  // Check default location too
  if (txRoot !== TRANSMUX_ROOT) {
    const defaultPath = join(TRANSMUX_ROOT, `${hash}.mp4`);
    if (existsSync(defaultPath)) return c.json({ ready: true, error: false });
  }

  return c.json({ error: "Not found" }, 404);
});

/** GET /transmux/:hash/stream — serve transmuxed MP4 with Range support. */
files.get("/transmux/:hash/stream", async (c) => {
  const hash = c.req.param("hash");
  if (!/^[a-f0-9]+$/.test(hash)) return c.json({ error: "Invalid hash" }, 400);

  const txRoot = getTransmuxRoot();
  let outPath = join(txRoot, `${hash}.mp4`);
  if (!existsSync(outPath)) {
    // Fall back to default location
    const defaultPath = join(TRANSMUX_ROOT, `${hash}.mp4`);
    if (existsSync(defaultPath)) outPath = defaultPath;
    else return c.json({ error: "Not found" }, 404);
  }

  return buildStreamResponse(outPath, c.req.header("range"));
});

// ── Image thumbnail — resized preview for Quick Look ──────────────────────

const THUMB_CACHE_DIR = join(TALOME_HOME, "cache", "thumbnails");
const THUMB_ALLOWED_WIDTHS = [640, 1280, 1920] as const;
type ThumbWidth = (typeof THUMB_ALLOWED_WIDTHS)[number];

async function ensureThumbCache() {
  if (!existsSync(THUMB_CACHE_DIR)) await mkdir(THUMB_CACHE_DIR, { recursive: true });
}

files.get("/thumbnail", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path query parameter required" }, 400);

  const wParam = parseInt(c.req.query("w") ?? "1280", 10);
  const width: ThumbWidth = THUMB_ALLOWED_WIDTHS.includes(wParam as ThumbWidth)
    ? (wParam as ThumbWidth)
    : 1280;

  const abs = sanitizePath(filePath);
  if (!isAllowed(abs)) return c.json({ error: "Access denied" }, 403);

  const e = extname(abs).slice(1).toLowerCase();
  if (!["png", "jpg", "jpeg", "webp", "bmp", "gif"].includes(e)) {
    // Non-raster images (SVG, ICO) — fall through to regular stream
    return buildStreamResponse(abs, c.req.header("range"));
  }

  try {
    const s = await stat(abs);
    const hash = createHash("md5").update(`${abs}:${s.mtimeMs}:${width}`).digest("hex");
    const cachePath = join(THUMB_CACHE_DIR, `${hash}.webp`);

    await ensureThumbCache();

    if (existsSync(cachePath)) {
      const cs = await stat(cachePath);
      return new Response(Readable.toWeb(createReadStream(cachePath)) as ReadableStream, {
        headers: {
          "Content-Type": "image/webp",
          "Content-Length": String(cs.size),
          "Cache-Control": "public, max-age=86400, immutable",
        },
      });
    }

    // Resize with sharp — fit within width, preserve aspect ratio
    const { default: sharp } = await import("sharp");
    const buf = await sharp(abs)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();

    // Write cache non-blocking
    void writeFile(cachePath, buf);

    return new Response(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, {
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(buf.length),
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch (err) {
    // Fallback to original file on any error
    return buildStreamResponse(abs, c.req.header("range"));
  }
});

files.get("/stream", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path query parameter required" }, 400);

  const abs = sanitizePath(filePath);
  if (!isAllowed(abs)) return c.json({ error: "Access denied" }, 403);

  try {
    return await buildStreamResponse(abs, c.req.header("range"));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── Delete file ─────────────────────────────────────────────────────────

files.delete("/", async (c) => {
  const body = await c.req.json<{ path: string }>();
  if (!body.path) return c.json({ error: "path required" }, 400);

  const abs = sanitizePath(body.path);
  if (!isAllowed(abs)) return c.json({ error: "Access denied" }, 403);

  // Prevent deleting allowed root directories
  const roots = getAllowedRoots();
  if (roots.includes(abs)) return c.json({ error: "Cannot delete a root directory" }, 403);

  try {
    const s = await stat(abs);
    if (s.isDirectory()) {
      await rm(abs, { recursive: true, force: true });
    } else {
      await unlink(abs);
    }
    return c.json({ ok: true, deleted: abs });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── Rename / move file ──────────────────────────────────────────────────

files.post("/rename", async (c) => {
  const body = await c.req.json<{ oldPath: string; newName: string }>();
  if (!body.oldPath || !body.newName) return c.json({ error: "oldPath and newName required" }, 400);
  if (body.newName.includes("/")) return c.json({ error: "newName must not contain path separators" }, 400);

  const absOld = sanitizePath(body.oldPath);
  if (!isAllowed(absOld)) return c.json({ error: "Access denied" }, 403);

  const absNew = join(dirname(absOld), body.newName);
  if (!isAllowed(absNew)) return c.json({ error: "Access denied" }, 403);

  try {
    await rename(absOld, absNew);
    return c.json({ ok: true, oldPath: absOld, newPath: absNew });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── Move files to a different directory ─────────────────────────────────

files.post("/move", async (c) => {
  const body = await c.req.json<{ sources: string[]; destination: string }>();
  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    return c.json({ error: "sources array required" }, 400);
  }
  if (!body.destination) return c.json({ error: "destination required" }, 400);

  const absDest = sanitizePath(body.destination);
  if (!isAllowed(absDest)) return c.json({ error: "Access denied: destination" }, 403);

  // Destination must be a directory
  try {
    const destStat = await stat(absDest);
    if (!destStat.isDirectory()) return c.json({ error: "Destination is not a directory" }, 400);
  } catch {
    return c.json({ error: "Destination directory does not exist" }, 404);
  }

  const moved: string[] = [];
  const errors: { path: string; error: string }[] = [];

  for (const src of body.sources) {
    const absSrc = sanitizePath(src);
    if (!isAllowed(absSrc)) {
      errors.push({ path: src, error: "Access denied" });
      continue;
    }

    // Prevent moving a directory into itself
    if (absDest.startsWith(absSrc + "/") || absDest === absSrc) {
      errors.push({ path: src, error: "Cannot move a folder into itself" });
      continue;
    }

    const destPath = join(absDest, basename(absSrc));
    if (!isAllowed(destPath)) {
      errors.push({ path: src, error: "Access denied: target path" });
      continue;
    }

    // Skip if source and destination are the same
    if (absSrc === destPath) {
      errors.push({ path: src, error: "Already in this location" });
      continue;
    }

    try {
      await rename(absSrc, destPath);
      moved.push(absSrc);
    } catch (err) {
      errors.push({ path: src, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return c.json({
    ok: errors.length === 0,
    moved,
    errors: errors.length > 0 ? errors : undefined,
  });
});

// ── Create directory ────────────────────────────────────────────────────

files.post("/mkdir", async (c) => {
  const body = await c.req.json<{ path: string }>();
  if (!body.path) return c.json({ error: "path required" }, 400);

  const abs = sanitizePath(body.path);
  if (!isAllowed(abs)) return c.json({ error: "Access denied" }, 403);

  try {
    await mkdir(abs, { recursive: true });
    return c.json({ ok: true, created: abs });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── Upload files ────────────────────────────────────────────────────

files.post("/upload", async (c) => {
  const formData = await c.req.formData();
  const targetDir = formData.get("path") as string | null;
  if (!targetDir) return c.json({ error: "path field required" }, 400);

  const abs = sanitizePath(targetDir);
  if (!isAllowed(abs)) return c.json({ error: "Access denied" }, 403);

  const uploaded: string[] = [];
  const errors: string[] = [];

  for (const [key, value] of formData.entries()) {
    if (key !== "files" || !(value instanceof File)) continue;

    const fileName = basename(value.name);
    if (!fileName || fileName.startsWith(".")) {
      errors.push(`Skipped invalid filename: ${value.name}`);
      continue;
    }

    const dest = join(abs, fileName);
    if (!isAllowed(dest)) {
      errors.push(`Access denied: ${fileName}`);
      continue;
    }

    try {
      const buffer = Buffer.from(await value.arrayBuffer());
      await writeFile(dest, buffer);
      uploaded.push(fileName);
    } catch (err) {
      errors.push(`Failed to write ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return c.json({ ok: true, uploaded, errors: errors.length > 0 ? errors : undefined });
});

// ── Drive management ──────────────────────────────────────────────────

/** List all detected external drives and which ones are currently enabled. */
files.get("/drives", (c) => {
  const detected = getDetectedDrives();
  const raw = getSetting("file_manager_drives");
  let enabled: string[] = [];
  try { enabled = raw ? JSON.parse(raw) : []; } catch { /* empty */ }

  const drives = detected.map((path) => ({
    path,
    label: path.split("/").filter(Boolean).pop() || path,
    enabled: enabled.includes(path),
  }));

  return c.json({ drives });
});

/** Set which external drives are allowed in the file manager. */
files.post("/drives", async (c) => {
  const body = await c.req.json<{ enabled: string[] }>();
  if (!Array.isArray(body.enabled)) {
    return c.json({ error: "enabled must be an array of drive paths" }, 400);
  }

  // Only allow paths that are actually detected as external drives
  const detected = new Set(getDetectedDrives());
  const valid = body.enabled.filter((p) => detected.has(p));
  const value = JSON.stringify(valid);

  db.insert(schema.settings)
    .values({ key: "file_manager_drives", value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run();

  // Invalidate the drive cache so the next file listing picks up the change
  invalidateDriveCache();

  return c.json({ ok: true, enabled: valid });
});

// ── Transcoding configuration ─────────────────────────────────────────────

/** GET /transcode-config — return current transcoding configuration. */
files.get("/transcode-config", (c) => {
  const config: TranscodingConfig = {
    hlsTempDirectory: getSetting("transcoding_hls_temp_dir") || "/tmp/talome/hls",
    transmuxTempDirectory: getSetting("transcoding_transmux_temp_dir") || "/tmp/talome-transmux",
    enableSmartDetection: getSetting("transcoding_smart_detection") !== "false",
    preferredCodecs: (() => {
      const raw = getSetting("transcoding_preferred_codecs");
      try { return raw ? JSON.parse(raw) : []; } catch { return []; }
    })(),
    enableTranscodeCache: getSetting("transcoding_cache") !== "false",
    maxConcurrentJobs: parseInt(getSetting("transcoding_max_jobs") ?? "5", 10),
    useSourceFolderTemp: getSetting("transcoding_use_source_folder") === "true",
  };
  return c.json(config);
});

/** POST /transcode-config — update transcoding configuration. */
files.post("/transcode-config", async (c) => {
  const body = await c.req.json<Partial<TranscodingConfig>>();

  if (body.hlsTempDirectory !== undefined) {
    setSetting("transcoding_hls_temp_dir", body.hlsTempDirectory);
  }
  if (body.transmuxTempDirectory !== undefined) {
    setSetting("transcoding_transmux_temp_dir", body.transmuxTempDirectory);
  }
  if (body.enableSmartDetection !== undefined) {
    setSetting("transcoding_smart_detection", String(body.enableSmartDetection));
  }
  if (body.preferredCodecs !== undefined) {
    setSetting("transcoding_preferred_codecs", JSON.stringify(body.preferredCodecs));
  }
  if (body.enableTranscodeCache !== undefined) {
    setSetting("transcoding_cache", String(body.enableTranscodeCache));
  }
  if (body.maxConcurrentJobs !== undefined) {
    setSetting("transcoding_max_jobs", String(body.maxConcurrentJobs));
  }
  if (body.useSourceFolderTemp !== undefined) {
    setSetting("transcoding_use_source_folder", String(body.useSourceFolderTemp));
  }

  return c.json({ ok: true });
});

/** GET /transcode-decision — smart detection: should we transcode, transmux, or direct play? */
files.get("/transcode-decision", async (c) => {
  const filePath = c.req.query("path");
  const clientCodecs = c.req.query("clientCodecs") || "";
  if (!filePath) return c.json({ error: "path required" }, 400);

  const abs = sanitizePath(filePath);
  if (!isAllowed(abs)) return c.json({ error: "Access denied" }, 403);
  if (!hasFfmpeg()) return c.json({ error: "ffmpeg not available" }, 500);

  const smartEnabled = getSetting("transcoding_smart_detection") !== "false";
  const probe = probeFile(abs);
  const ext = extname(abs).slice(1).toLowerCase();
  const codec = probe.videoCodec;

  // Parse client-supported codecs (comma-separated, e.g. "h264,hevc,vp9")
  const supported = new Set(clientCodecs.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

  // Direct-playable containers with compatible codec
  const directContainers = new Set(["mp4", "m4v", "mov", "webm"]);
  const canDirectPlay = directContainers.has(ext) &&
    (supported.size === 0 || supported.has(codec));

  // Transmux: container not browser-native but codec is compatible
  const canTransmux = !canDirectPlay &&
    (codec === "h264" || (supported.has("hevc") && (codec === "hevc" || codec === "h265")));

  const needsTranscode = !canDirectPlay && !canTransmux;

  let reason: string;
  if (canDirectPlay) {
    reason = `${ext} container with ${codec} codec is natively playable`;
  } else if (canTransmux) {
    reason = `${codec} codec is compatible but ${ext} container needs remuxing to MP4`;
  } else {
    reason = `${codec || "unknown"} codec in ${ext} container requires full transcoding`;
  }

  // If smart detection is off, always report transcoding needed for non-direct containers
  if (!smartEnabled && !canDirectPlay) {
    return c.json({
      canDirectPlay: false,
      canTransmux: false,
      needsTranscode: true,
      sourceCodec: codec,
      sourceContainer: ext,
      reason: "Smart detection disabled — defaulting to full transcode",
    });
  }

  return c.json({
    canDirectPlay,
    canTransmux,
    needsTranscode,
    sourceCodec: codec,
    sourceContainer: ext,
    reason,
  });
});

export { files };
