/**
 * Streaming file uploads.
 *
 * Bodies are streamed to a temporary file next to the destination and renamed
 * into place only when the whole file arrived, so an interrupted or cancelled
 * upload never leaves a truncated file behind or clobbers an existing one.
 */

import { createWriteStream, realpathSync } from "node:fs";
import { mkdir, rename, rm, stat, statfs } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { isAllowed, sanitizePath } from "./filesystem.js";

export type ConflictMode = "rename" | "replace" | "skip";

export type UploadTarget = { ok: true; dir: string; fileName: string } | { ok: false; status: 400 | 403; error: string };

const PART_SUFFIX = ".talome-part";

function isSafeSegment(segment: string): boolean {
  return segment.length > 0 && segment.length <= 255 && segment !== "." && segment !== ".." && !segment.startsWith(".") && !segment.includes("\0") && !segment.includes("\\");
}

/**
 * Resolve where an upload should land. `relativePath` may include folders (folder
 * uploads); every segment is validated and the final directory must be inside an
 * allowed root after symlinks are resolved.
 */
export async function resolveUploadTarget(targetDir: string, relativePath: string): Promise<UploadTarget> {
  const base = sanitizePath(targetDir);
  if (!isAllowed(base)) return { ok: false, status: 403, error: "Access denied" };

  const segments = relativePath.split("/").filter((s) => s.length > 0);
  if (segments.length === 0 || segments.length > 32 || !segments.every(isSafeSegment)) {
    return { ok: false, status: 400, error: `Invalid file path: ${relativePath}` };
  }

  const fileName = segments[segments.length - 1];

  // Walk the folders one level at a time. Each existing component is resolved
  // (following symlinks) and checked before anything is created inside it, so a
  // symlink can never lead to folders being created outside an allowed root.
  let current: string;
  try {
    current = realpathSync(base);
  } catch {
    return { ok: false, status: 400, error: "Target folder does not exist" };
  }
  if (!isAllowed(current)) return { ok: false, status: 403, error: "Access denied" };

  for (const segment of segments.slice(0, -1)) {
    const next = join(current, segment);
    try {
      await mkdir(next);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const real = realpathSync(next);
    if (!isAllowed(real)) return { ok: false, status: 403, error: "Access denied" };
    if (!(await stat(real)).isDirectory()) return { ok: false, status: 400, error: `Not a folder: ${segment}` };
    current = real;
  }
  return { ok: true, dir: current, fileName };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** "photo.jpg" → "photo (1).jpg", "photo (2).jpg", … — the first name not taken. */
export async function availableName(dir: string, fileName: string): Promise<string> {
  if (!(await exists(join(dir, fileName)))) return fileName;
  const ext = extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await exists(join(dir, candidate)))) return candidate;
  }
  return `${stem} (${randomUUID().slice(0, 8)})${ext}`;
}

/** Free bytes on the filesystem holding `dir`, or null when unknown. */
export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export type UploadResult =
  | { ok: true; name: string; path: string; bytes: number; skipped?: boolean }
  | { ok: false; status: 400 | 403 | 413 | 500 | 507; error: string; cancelled?: boolean };

/**
 * Stream `body` into `dir/fileName`. With `expectedBytes`, a short or long body
 * is rejected (a dropped connection must not produce a "complete" file).
 */
export async function streamUpload(params: {
  body: WebReadableStream<Uint8Array> | ReadableStream<Uint8Array> | null;
  dir: string;
  fileName: string;
  conflict: ConflictMode;
  expectedBytes?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}): Promise<UploadResult> {
  const { dir, conflict, expectedBytes, maxBytes, signal } = params;
  if (!params.body) return { ok: false, status: 400, error: "Empty request body" };

  if (expectedBytes !== undefined) {
    if (maxBytes !== undefined && expectedBytes > maxBytes) {
      return { ok: false, status: 413, error: "File is larger than the upload limit" };
    }
    const free = await freeBytes(dir);
    if (free !== null && expectedBytes > free) {
      return { ok: false, status: 507, error: "Not enough free space on this drive" };
    }
  }

  let name = params.fileName;
  if (await exists(join(dir, name))) {
    if (conflict === "skip") return { ok: true, name, path: join(dir, name), bytes: 0, skipped: true };
    if (conflict === "rename") name = await availableName(dir, name);
  }

  const dest = join(dir, name);
  const part = join(dir, `.${basename(name)}.${randomUUID().slice(0, 8)}${PART_SUFFIX}`);
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      bytes += chunk.length;
      if (maxBytes !== undefined && bytes > maxBytes) {
        callback(new Error("UPLOAD_TOO_LARGE"));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(params.body as WebReadableStream<Uint8Array>),
      counter,
      createWriteStream(part, { flags: "wx" }),
      { signal },
    );
    if (expectedBytes !== undefined && bytes !== expectedBytes) {
      await rm(part, { force: true });
      return { ok: false, status: 400, error: `Upload incomplete: received ${bytes} of ${expectedBytes} bytes` };
    }
    // Re-resolve the name in case another upload took it meanwhile
    if (conflict === "rename" && (await exists(dest))) {
      const fresh = await availableName(dir, name);
      name = fresh;
    }
    await rename(part, join(dir, name));
    return { ok: true, name, path: join(dir, name), bytes };
  } catch (err) {
    await rm(part, { force: true });
    const message = err instanceof Error ? err.message : String(err);
    if (message === "UPLOAD_TOO_LARGE") return { ok: false, status: 413, error: "File is larger than the upload limit" };
    if (signal?.aborted || /aborted|premature close/i.test(message)) return { ok: false, status: 400, error: "Upload cancelled", cancelled: true };
    if (/ENOSPC/.test(message)) return { ok: false, status: 507, error: "Not enough free space on this drive" };
    return { ok: false, status: 500, error: `Failed to write ${name}: ${message}` };
  }
}

