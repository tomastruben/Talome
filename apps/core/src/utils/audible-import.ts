import { randomBytes } from "node:crypto";
import { mkdir, copyFile, unlink, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { getStoredTokens, requestContentLicense } from "./audible-auth.js";
import { getSetting } from "./settings.js";
import { listContainers, inspectContainer } from "../docker/client.js";
import { createLogger } from "./logger.js";

const log = createLogger("audible-import");

/* ── Types ──────────────────────────────────────────────── */

export type ImportStatus =
  | "pending"
  | "licensing"
  | "downloading"
  | "converting"
  | "moving"
  | "scanning"
  | "done"
  | "error"
  | "cancelled";

export interface ImportJob {
  id: string;
  asin: string;
  title: string;
  author: string;
  status: ImportStatus;
  progress: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/* ── In-memory state ────────────────────────────────────── */

const activeImports = new Map<string, ImportJob>();

/** Prune completed jobs older than 1 hour */
function pruneCompletedJobs(): void {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of activeImports) {
    if ((job.status === "done" || job.status === "error") && job.updatedAt < cutoff) {
      activeImports.delete(id);
    }
  }
}

/* ── Helpers ─────────────────────────────────────────────── */

const TALOME_TMP = join(homedir(), ".talome", "tmp", "audible");

/** Sanitize a filename — replace dangerous characters with underscores */
function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "_").trim();
}

function updateJob(job: ImportJob, updates: Partial<ImportJob>): void {
  Object.assign(job, updates, { updatedAt: Date.now() });
}

/* ── FFmpeg check ────────────────────────────────────────── */

let cachedFfmpegResult: { available: boolean; version?: string } | null = null;

export function checkFfmpeg(): { available: boolean; version?: string } {
  if (cachedFfmpegResult !== null) return cachedFfmpegResult;
  try {
    const output = execSync("ffmpeg -version", { encoding: "utf-8", timeout: 5000 });
    const firstLine = output.split("\n")[0] ?? "";
    const versionMatch = firstLine.match(/ffmpeg version (\S+)/);
    cachedFfmpegResult = {
      available: true,
      version: versionMatch?.[1] ?? firstLine.trim(),
    };
  } catch {
    cachedFfmpegResult = { available: false };
  }
  return cachedFfmpegResult;
}

/* ── ABS host path resolution ────────────────────────────── */

/**
 * Find the host path that corresponds to a container path inside the
 * Audiobookshelf container. Uses Docker inspect to read bind mounts.
 */
async function findAbsHostPath(containerPath: string): Promise<string | null> {
  try {
    const containers = await listContainers();
    const absContainer = containers.find(
      (c) =>
        c.name.toLowerCase().includes("audiobookshelf") ||
        c.image.toLowerCase().includes("audiobookshelf"),
    );
    if (!absContainer) return null;

    const info = await inspectContainer(absContainer.id);

    // Find the mount whose container destination is a prefix of containerPath
    for (const mount of info.mounts) {
      if (containerPath.startsWith(mount.destination)) {
        const remainder = containerPath.slice(mount.destination.length);
        return join(mount.source, remainder);
      }
    }

    return null;
  } catch (err) {
    console.error("[audible-import] Error resolving ABS host path:", err);
    return null;
  }
}

/* ── Import pipeline ─────────────────────────────────────── */

export async function importAudibleBook(
  asin: string,
  title: string,
  author: string,
  libraryId?: string,
): Promise<string> {
  pruneCompletedJobs();

  // Fix 3: Check for an already-active import of the same ASIN
  for (const [, existingJob] of activeImports) {
    if (existingJob.asin === asin && existingJob.status !== "error" && existingJob.status !== "done") {
      return existingJob.id;
    }
  }

  const importId = randomBytes(8).toString("hex");
  const job: ImportJob = {
    id: importId,
    asin,
    title,
    author,
    status: "pending",
    progress: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  activeImports.set(importId, job);

  // Fire-and-forget async pipeline
  void (async () => {
    const tempDir = join(TALOME_TMP, importId);

    try {
      await mkdir(tempDir, { recursive: true });

      /* ── 1. Licensing ──────────────────────────────────── */
      console.log(`[audible-import] ${importId}: licensing for ${asin}`);
      updateJob(job, { status: "licensing", progress: 0 });

      const tokens = getStoredTokens();
      if (!tokens) {
        throw new Error("Not authenticated with Audible");
      }

      // Fix 2: Check for duplicates in the target ABS library before licensing
      const absUrl = getSetting("audiobookshelf_url");
      const absApiKey = getSetting("audiobookshelf_api_key");

      if (absUrl && absApiKey) {
        try {
          // Determine target library ID up front
          let targetLibraryId = libraryId;
          if (!targetLibraryId) {
            const preLibRes = await fetch(`${absUrl}/api/libraries`, {
              headers: { Authorization: `Bearer ${absApiKey}` },
              signal: AbortSignal.timeout(10000),
            });
            if (preLibRes.ok) {
              const preLibData = await preLibRes.json() as {
                libraries: Array<{ id: string; mediaType: string }>;
              };
              const fallbackLib =
                preLibData.libraries?.find((l) => l.mediaType === "book") ??
                preLibData.libraries?.[0];
              if (fallbackLib) targetLibraryId = fallbackLib.id;
            }
          }

          if (targetLibraryId) {
            const searchRes = await fetch(
              `${absUrl}/api/libraries/${targetLibraryId}/search?q=${encodeURIComponent(title)}&limit=5`,
              { headers: { Authorization: `Bearer ${absApiKey}` }, signal: AbortSignal.timeout(10000) },
            );
            if (searchRes.ok) {
              const searchData = await searchRes.json() as {
                book?: Array<{
                  libraryItem?: { media?: { metadata?: { title?: string } } };
                }>;
              };
              const existing = searchData.book?.find((b) =>
                b.libraryItem?.media?.metadata?.title
                  ?.toLowerCase()
                  .includes(title.toLowerCase().slice(0, 20)),
              );
              if (existing) {
                updateJob(job, { status: "done", progress: 100, error: "Already in library" });
                return;
              }
            }
          }
        } catch {
          // Non-fatal — proceed with import
        }
      }

      const { contentUrl, key, iv } = await requestContentLicense(asin, tokens);
      updateJob(job, { progress: 10 });

      /* ── 2. Downloading ────────────────────────────────── */
      updateJob(job, { status: "downloading", progress: 10 });

      const aaxcPath = join(tempDir, `${importId}.aaxc`);
      const downloadRes = await fetch(contentUrl, {
        headers: {
          "User-Agent": "Audible/3.56.2 iOS/15.0.0",
          Authorization: `Bearer ${tokens.accessToken}`,
        },
        signal: AbortSignal.timeout(10 * 60 * 1000), // 10 minute timeout for large files
      });

      if (!downloadRes.ok) {
        throw new Error(`Download failed (${downloadRes.status}): ${downloadRes.statusText}`);
      }

      if (!downloadRes.body) {
        throw new Error("Download response has no body");
      }

      const contentLength = parseInt(downloadRes.headers.get("content-length") ?? "0", 10);
      let downloaded = 0;

      // Create a transform to track download progress
      const progressStream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          downloaded += chunk.byteLength;
          if (contentLength > 0) {
            // Download is 10-50% of total progress
            const dlProgress = 10 + Math.round((downloaded / contentLength) * 40);
            updateJob(job, { progress: Math.min(dlProgress, 50) });
          }
          controller.enqueue(chunk);
        },
      });

      const trackedStream = downloadRes.body.pipeThrough(progressStream);
      const nodeStream = Readable.fromWeb(trackedStream as any);
      const fileStream = createWriteStream(aaxcPath);
      await pipeline(nodeStream, fileStream);

      // Verify the download produced a file
      const aaxcStat = await stat(aaxcPath);
      if (aaxcStat.size === 0) {
        throw new Error("Downloaded file is empty");
      }

      updateJob(job, { progress: 50 });

      /* ── 3. Converting ─────────────────────────────────── */
      updateJob(job, { status: "converting", progress: 50 });

      const ffmpegCheck = checkFfmpeg();
      if (!ffmpegCheck.available) {
        throw new Error("FFmpeg is not available — install FFmpeg to convert audiobooks");
      }

      const sanitizedTitle = sanitizeFilename(title);
      const outputPath = join(tempDir, `${sanitizedTitle}.m4b`);

      await new Promise<void>((resolve, reject) => {
        // Check if cancelled before starting conversion
        if (job.status === "cancelled") {
          reject(new Error("Import cancelled"));
          return;
        }

        const proc = spawn("ffmpeg", [
          "-y",
          "-audible_key", key,
          "-audible_iv", iv,
          "-i", aaxcPath,
          "-c", "copy",
          outputPath,
        ], { stdio: ["ignore", "pipe", "pipe"] });

        let stderrBuf = "";

        proc.stderr?.on("data", (chunk: Buffer) => {
          stderrBuf += chunk.toString();

          // Parse FFmpeg progress from stderr (time= patterns)
          const timeMatch = stderrBuf.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
          if (timeMatch) {
            // Report converting progress as 50-80%
            // We don't know total duration here, so just pulse progress forward
            const hours = parseInt(timeMatch[1], 10);
            const minutes = parseInt(timeMatch[2], 10);
            const seconds = parseInt(timeMatch[3], 10);
            const totalSeconds = hours * 3600 + minutes * 60 + seconds;
            // Asymptotic progress: approaches 80 but never exceeds it
            const convertProgress = 50 + Math.min(30, Math.round(totalSeconds / 10));
            updateJob(job, { progress: Math.min(convertProgress, 80) });
          }

          // Keep only the last 4KB of stderr
          if (stderrBuf.length > 4096) {
            stderrBuf = stderrBuf.slice(-4096);
          }
        });

        proc.stdout?.on("data", () => { /* drain */ });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ChildProcessByStdio lacks .on() in newer @types/node
        const p = proc as any;
        p.on("close", (code: number | null) => {
          if (code === 0) {
            resolve();
          } else {
            // Extract the last meaningful error from stderr
            const lastLines = stderrBuf.trim().split("\n").slice(-5).join("\n");
            reject(new Error(`FFmpeg exited with code ${code}: ${lastLines}`));
          }
        });

        p.on("error", (err: Error) => {
          reject(new Error(`FFmpeg spawn error: ${err.message}`));
        });
      });

      // Verify M4B was created
      const m4bStat = await stat(outputPath);
      if (m4bStat.size === 0) {
        throw new Error("Converted M4B file is empty");
      }

      updateJob(job, { progress: 80 });

      /* ── 4. Moving ─────────────────────────────────────── */
      updateJob(job, { status: "moving", progress: 80 });

      if (!absUrl || !absApiKey) {
        // ABS not configured — leave file in temp with a note
        updateJob(job, {
          status: "done",
          progress: 100,
          error: `Audiobookshelf not configured. File saved to: ${outputPath}`,
        });
        // Clean up the AAXC (no longer needed), keep the M4B
        await unlink(aaxcPath).catch((err) => log.debug("failed to clean up aaxc", err));
        return;
      }

      // Fetch ABS libraries to find the first audiobook library
      const libRes = await fetch(`${absUrl}/api/libraries`, {
        headers: { Authorization: `Bearer ${absApiKey}` },
        signal: AbortSignal.timeout(10000),
      });

      if (!libRes.ok) {
        throw new Error(`Failed to fetch Audiobookshelf libraries (${libRes.status})`);
      }

      const libData = await libRes.json() as {
        libraries: Array<{
          id: string;
          name: string;
          mediaType: string;
          folders: Array<{ id: string; fullPath: string }>;
        }>;
      };

      // Use the specified library, or fall back to first audiobook library
      let audioLib: (typeof libData.libraries)[number] | undefined;
      if (libraryId) {
        audioLib = libData.libraries?.find((l) => l.id === libraryId);
        if (!audioLib) {
          throw new Error(`Library "${libraryId}" not found in Audiobookshelf`);
        }
      } else {
        audioLib = libData.libraries?.find((l) => l.mediaType === "book") ?? libData.libraries?.[0];
      }
      if (!audioLib || !audioLib.folders?.[0]) {
        throw new Error("No audiobook library found in Audiobookshelf");
      }

      const containerLibPath = audioLib.folders[0].fullPath;

      // Resolve the container path to a host path
      // First check if there's a configured override
      let hostLibPath = getSetting("audiobookshelf_library_path");

      if (!hostLibPath) {
        // Try to resolve via Docker container mounts
        hostLibPath = await findAbsHostPath(containerLibPath) ?? undefined;
      }

      if (!hostLibPath) {
        // Last resort: assume the container path is the same as host path
        // (e.g. when ABS is running natively, not in Docker)
        hostLibPath = containerLibPath;
      }

      const sanitizedAuthor = sanitizeFilename(author);
      const destDir = join(hostLibPath, sanitizedAuthor, sanitizedTitle);
      await mkdir(destDir, { recursive: true });

      const destPath = join(destDir, `${sanitizedTitle}.m4b`);

      // Use copyFile + unlink for cross-device support (temp may be on different mount)
      await copyFile(outputPath, destPath);
      await unlink(outputPath).catch((err) => log.debug("failed to clean up m4b", err));
      await unlink(aaxcPath).catch((err) => log.debug("failed to clean up aaxc", err));

      updateJob(job, { progress: 90 });

      /* ── 5. Scanning ───────────────────────────────────── */
      updateJob(job, { status: "scanning", progress: 90 });

      try {
        const scanRes = await fetch(`${absUrl}/api/libraries/${audioLib.id}/scan`, {
          method: "POST",
          headers: { Authorization: `Bearer ${absApiKey}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!scanRes.ok) {
          console.warn(`[audible-import] ABS library scan returned ${scanRes.status}`);
        }
      } catch (err) {
        console.warn("[audible-import] ABS library scan failed:", err);
        // Non-fatal — the book is already on disk
      }

      /* ── 6. Cleanup ────────────────────────────────────── */
      await rm(tempDir, { recursive: true, force: true }).catch((err) => log.debug("failed to clean up temp dir", err));

      updateJob(job, { status: "done", progress: 100 });
      console.log(`[audible-import] Completed: "${title}" by ${author}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[audible-import] Error importing "${title}":`, message);
      updateJob(job, { status: "error", error: message });

      // Clean up temp directory on error
      await rm(tempDir, { recursive: true, force: true }).catch((err) => log.debug("failed to clean up temp dir on error", err));
    }
  })();

  return importId;
}

/* ── Query functions ─────────────────────────────────────── */

export function getImportJobs(): ImportJob[] {
  pruneCompletedJobs();
  return Array.from(activeImports.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export function getImportJob(id: string): ImportJob | undefined {
  return activeImports.get(id);
}

export function cancelImport(importId: string): boolean {
  const job = activeImports.get(importId);
  if (!job) return false;

  if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
    return false;
  }

  updateJob(job, { status: "cancelled", error: "Cancelled by user" });
  return true;
}
