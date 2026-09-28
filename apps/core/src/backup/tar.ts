/**
 * Minimal streaming tar.gz writer/reader (POSIX ustar + pax extended headers).
 *
 * Why not shell out to `tar`: the runtime image is Alpine (busybox tar), dev
 * hosts are macOS (bsdtar) and some installs use GNU tar. Their flag sets
 * differ (no --transform in busybox), and we need to rename members, compute
 * per-file sha256 while archiving and verify archives without trusting a
 * shell. Archives written here are standard: `tar -xzf data.tar.gz` works
 * with GNU tar, bsdtar and busybox tar.
 *
 * Supported member types: regular files, directories, symlinks (and reading
 * of hard links). Sockets, FIFOs and devices are skipped by the writer.
 */

import { createReadStream, createWriteStream, constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, symlink, link, unlink, utimes, chmod, lchown, rm } from "node:fs/promises";
import { createGzip, createGunzip } from "node:zlib";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { join, resolve, sep, dirname } from "node:path";
import type { Stats } from "node:fs";

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);
const MAX_OCTAL_SIZE = 0o77777777777; // 11 octal digits
const MAX_OCTAL_ID = 0o7777777; // 7 octal digits

export class TarFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarFormatError";
  }
}

export type TarEntryType = "file" | "directory" | "symlink" | "hardlink" | "other";

export interface TarEntryHeader {
  /** POSIX path without leading slash and without trailing slash */
  name: string;
  type: TarEntryType;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  /** Seconds since epoch */
  mtime: number;
  linkname: string;
}

// ── Header encoding ─────────────────────────────────────────────────────────

function writeString(buf: Buffer, value: string, offset: number, length: number): void {
  const bytes = Buffer.from(value, "utf-8");
  bytes.copy(buf, offset, 0, Math.min(bytes.length, length));
}

function writeOctal(buf: Buffer, value: number, offset: number, length: number): void {
  // length includes the trailing NUL
  const str = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0");
  buf.write(str.slice(-(length - 1)), offset, length - 1, "ascii");
  buf[offset + length - 1] = 0;
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body, "utf-8");
  let len = bodyLen + 1;
  while (String(len).length + bodyLen !== len) len = String(len).length + bodyLen;
  return Buffer.from(`${len}${body}`, "utf-8");
}

function isPlainAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}

interface RawHeader {
  name: string;
  typeflag: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: number;
  linkname: string;
}

function encodeBlock(h: RawHeader): Buffer {
  const buf = Buffer.alloc(BLOCK);
  writeString(buf, h.name, 0, 100);
  writeOctal(buf, h.mode & 0o7777, 100, 8);
  writeOctal(buf, h.uid > MAX_OCTAL_ID ? 0 : h.uid, 108, 8);
  writeOctal(buf, h.gid > MAX_OCTAL_ID ? 0 : h.gid, 116, 8);
  writeOctal(buf, h.size > MAX_OCTAL_SIZE ? 0 : h.size, 124, 12);
  writeOctal(buf, h.mtime, 136, 12);
  buf.fill(0x20, 148, 156); // checksum placeholder (spaces)
  buf.write(h.typeflag, 156, 1, "ascii");
  writeString(buf, h.linkname, 157, 100);
  buf.write("ustar\u0000", 257, 6, "ascii");
  buf.write("00", 263, 2, "ascii");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i];
  const chk = sum.toString(8).padStart(6, "0");
  buf.write(chk, 148, 6, "ascii");
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

/** Encode a header, prefixed by a pax extended header when needed. */
export function encodeHeader(h: TarEntryHeader): Buffer {
  const typeflag = h.type === "directory" ? "5" : h.type === "symlink" ? "2" : h.type === "hardlink" ? "1" : "0";
  const memberName = h.type === "directory" ? `${h.name}/` : h.name;
  const pax: Buffer[] = [];
  if (Buffer.byteLength(memberName, "utf-8") > 100 || !isPlainAscii(memberName)) pax.push(paxRecord("path", memberName));
  if (h.linkname && (Buffer.byteLength(h.linkname, "utf-8") > 100 || !isPlainAscii(h.linkname))) {
    pax.push(paxRecord("linkpath", h.linkname));
  }
  if (h.size > MAX_OCTAL_SIZE) pax.push(paxRecord("size", String(h.size)));
  if (h.uid > MAX_OCTAL_ID) pax.push(paxRecord("uid", String(h.uid)));
  if (h.gid > MAX_OCTAL_ID) pax.push(paxRecord("gid", String(h.gid)));

  const main = encodeBlock({
    name: truncateUtf8(memberName, 100),
    typeflag,
    mode: h.mode,
    uid: h.uid,
    gid: h.gid,
    size: h.type === "file" ? h.size : 0,
    mtime: h.mtime,
    linkname: truncateUtf8(h.linkname, 100),
  });
  if (pax.length === 0) return main;

  const paxBody = Buffer.concat(pax);
  const paxHeader = encodeBlock({
    name: truncateUtf8(`PaxHeader/${h.name.split("/").pop() ?? "entry"}`, 100),
    typeflag: "x",
    mode: 0o644,
    uid: 0,
    gid: 0,
    size: paxBody.length,
    mtime: h.mtime,
    linkname: "",
  });
  return Buffer.concat([paxHeader, paxBody, padding(paxBody.length), main]);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf-8");
  if (bytes.length <= maxBytes) return value;
  // Cut on a character boundary
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf-8");
}

function padding(size: number): Buffer {
  const rem = size % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem);
}

// ── Writer ──────────────────────────────────────────────────────────────────

export interface AddedFile {
  name: string;
  size: number;
  sha256: string;
  mode: number;
  /** True when the file shrank while being read (content was zero-filled) */
  changed: boolean;
}

export interface WalkOptions {
  /** Return true to leave a path (relative to the walked root) out of the archive */
  exclude?: (relPath: string, isDir: boolean) => boolean;
  onFile?: (file: AddedFile) => void;
  onSymlink?: (name: string, target: string) => void;
  onWarning?: (message: string) => void;
  /** A file or directory (relative path, "" = the root) that could not be read and is missing from the archive */
  onSkipped?: (relPath: string) => void;
  signal?: AbortSignal;
}

export interface WalkResult {
  fileCount: number;
  bytes: number;
  kind: "dir" | "file";
}

export class TarGzWriter {
  private readonly gzip = createGzip({ level: 6 });
  private readonly done: Promise<void>;
  private failure: Error | null = null;
  private closed = false;

  constructor(readonly path: string) {
    const out = createWriteStream(path, { mode: 0o600 });
    this.done = pipeline(this.gzip, out);
    this.done.catch((err: unknown) => {
      this.failure = err instanceof Error ? err : new Error(String(err));
    });
  }

  private async push(buf: Buffer): Promise<void> {
    if (this.failure) throw this.failure;
    if (buf.length === 0) return;
    if (!this.gzip.write(buf)) {
      const drain = once(this.gzip, "drain");
      drain.catch(() => {});
      const failed = this.done.then(() => {
        throw new Error("archive stream closed unexpectedly");
      });
      failed.catch(() => {});
      await Promise.race([drain, failed]);
    }
    if (this.failure) throw this.failure;
  }

  async addDirectory(name: string, stat: Pick<Stats, "mode" | "uid" | "gid" | "mtimeMs">): Promise<void> {
    await this.push(
      encodeHeader({ name, type: "directory", mode: stat.mode, uid: stat.uid, gid: stat.gid, size: 0, mtime: stat.mtimeMs / 1000, linkname: "" }),
    );
  }

  async addSymlink(name: string, target: string, stat: Pick<Stats, "mode" | "uid" | "gid" | "mtimeMs">): Promise<void> {
    await this.push(
      encodeHeader({ name, type: "symlink", mode: stat.mode, uid: stat.uid, gid: stat.gid, size: 0, mtime: stat.mtimeMs / 1000, linkname: target }),
    );
  }

  /** Add an in-memory buffer as a regular file. */
  async addBuffer(name: string, data: Buffer, mode = 0o644): Promise<AddedFile> {
    await this.push(
      encodeHeader({ name, type: "file", mode, uid: 0, gid: 0, size: data.length, mtime: Date.now() / 1000, linkname: "" }),
    );
    await this.push(data);
    await this.push(padding(data.length));
    return { name, size: data.length, sha256: createHash("sha256").update(data).digest("hex"), mode, changed: false };
  }

  /**
   * Add a file from disk. The size recorded in the header is the size at
   * lstat time: a file that grows is truncated to it, a file that shrinks is
   * zero-filled (and reported as changed). The sha256 always describes the
   * bytes stored in the archive.
   */
  async addFile(name: string, absPath: string, stat: Stats, signal?: AbortSignal): Promise<AddedFile> {
    const size = stat.size;
    await this.push(
      encodeHeader({ name, type: "file", mode: stat.mode, uid: stat.uid, gid: stat.gid, size, mtime: stat.mtimeMs / 1000, linkname: "" }),
    );
    const hash = createHash("sha256");
    let written = 0;
    if (size > 0) {
      const stream = createReadStream(absPath, { start: 0, end: size - 1, highWaterMark: 256 * 1024 });
      try {
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          if (signal?.aborted) throw new Error("Backup cancelled");
          const slice = written + chunk.length > size ? chunk.subarray(0, size - written) : chunk;
          hash.update(slice);
          written += slice.length;
          await this.push(slice);
          if (written >= size) break;
        }
      } finally {
        stream.destroy();
      }
    }
    const changed = written < size;
    if (changed) {
      const fill = Buffer.alloc(Math.min(size - written, 1024 * 1024));
      while (written < size) {
        const part = fill.subarray(0, Math.min(fill.length, size - written));
        hash.update(part);
        written += part.length;
        await this.push(part);
      }
    }
    await this.push(padding(size));
    return { name, size, sha256: hash.digest("hex"), mode: stat.mode & 0o7777, changed };
  }

  /**
   * Recursively add `rootPath` (a directory or a single file) under the
   * archive prefix `prefix`. Unreadable or vanished entries are reported as
   * warnings instead of aborting the whole archive.
   */
  async addTree(rootPath: string, prefix: string, opts: WalkOptions = {}): Promise<WalkResult> {
    const rootStat = await lstat(rootPath);
    const result: WalkResult = { fileCount: 0, bytes: 0, kind: rootStat.isDirectory() ? "dir" : "file" };
    const warn = (m: string) => opts.onWarning?.(m);

    const addOne = async (abs: string, name: string, rel: string, stat: Stats): Promise<boolean> => {
      if (stat.isSymbolicLink()) {
        const target = await readlink(abs);
        await this.addSymlink(name, target, stat);
        opts.onSymlink?.(name, target);
        return false;
      }
      if (stat.isFile()) {
        try {
          const added = await this.addFile(name, abs, stat, opts.signal);
          if (added.changed) warn(`${rel || name} changed while being archived`);
          result.fileCount++;
          result.bytes += added.size;
          opts.onFile?.(added);
        } catch (err) {
          if (opts.signal?.aborted) throw err;
          // Header was already written — the archive is now inconsistent
          throw new Error(`Failed to read ${abs}: ${err instanceof Error ? err.message : String(err)}`);
        }
        return false;
      }
      if (stat.isDirectory()) {
        await this.addDirectory(name, stat);
        return true;
      }
      warn(`Skipped special file ${rel || name}`);
      return false;
    };

    if (!rootStat.isDirectory()) {
      await addOne(rootPath, prefix, "", rootStat);
      return result;
    }

    await this.addDirectory(prefix, rootStat);
    const stack: Array<{ abs: string; rel: string }> = [{ abs: rootPath, rel: "" }];
    while (stack.length > 0) {
      if (opts.signal?.aborted) throw new Error("Backup cancelled");
      const { abs, rel } = stack.pop()!;
      let names: string[];
      try {
        names = (await readdir(abs)).sort();
      } catch (err) {
        warn(`Could not read directory ${rel || "."}: ${err instanceof Error ? err.message : String(err)}`);
        opts.onSkipped?.(rel);
        continue;
      }
      const subdirs: Array<{ abs: string; rel: string }> = [];
      for (const entry of names) {
        const childAbs = join(abs, entry);
        const childRel = rel ? `${rel}/${entry}` : entry;
        let stat: Stats;
        try {
          stat = await lstat(childAbs);
        } catch (err) {
          warn(`${childRel} vanished during backup`);
          continue;
        }
        if (opts.exclude?.(childRel, stat.isDirectory())) continue;
        if (stat.isFile()) {
          // Pre-check readability so a permission problem becomes a warning
          // instead of a half-written member.
          try {
            const fh = await open(childAbs, "r");
            await fh.close();
          } catch (err) {
            warn(`Unreadable file skipped: ${childRel} (${err instanceof Error ? err.message : String(err)})`);
            opts.onSkipped?.(childRel);
            continue;
          }
        }
        const descend = await addOne(childAbs, `${prefix}/${childRel}`, childRel, stat);
        if (descend) subdirs.push({ abs: childAbs, rel: childRel });
      }
      // Reverse so the pop() order stays alphabetical
      for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.push(Buffer.concat([ZERO_BLOCK, ZERO_BLOCK]));
    this.gzip.end();
    await this.done;
    if (this.failure) throw this.failure;
  }

  /** Abort writing and delete the partial file. */
  async abort(): Promise<void> {
    this.closed = true;
    this.gzip.destroy();
    await this.done.catch(() => {});
    await rm(this.path, { force: true }).catch(() => {});
  }
}

// ── Reader ──────────────────────────────────────────────────────────────────

class ByteSource {
  private buf: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(private readonly it: AsyncIterator<Buffer>) {}

  private async pull(): Promise<boolean> {
    if (this.ended) return false;
    const r = await this.it.next();
    if (r.done) {
      this.ended = true;
      return false;
    }
    this.buf = this.buf.length === 0 ? r.value : Buffer.concat([this.buf, r.value]);
    return true;
  }

  /** Read exactly n bytes; returns null on clean EOF before any byte. */
  async read(n: number): Promise<Buffer | null> {
    while (this.buf.length < n) {
      if (!(await this.pull())) {
        if (this.buf.length === 0) return null;
        throw new TarFormatError("Unexpected end of archive");
      }
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Yield exactly n bytes in chunks. `progress.left` tracks unread bytes. */
  async *take(n: number, progress: { left: number }): AsyncGenerator<Buffer> {
    progress.left = n;
    while (progress.left > 0) {
      if (this.buf.length === 0 && !(await this.pull())) {
        throw new TarFormatError("Unexpected end of archive");
      }
      const size = Math.min(progress.left, this.buf.length);
      const chunk = this.buf.subarray(0, size);
      this.buf = this.buf.subarray(size);
      progress.left -= size;
      yield chunk;
    }
  }

  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0 && !(await this.pull())) throw new TarFormatError("Unexpected end of archive");
      const size = Math.min(left, this.buf.length);
      this.buf = this.buf.subarray(size);
      left -= size;
    }
  }

  /** Consume the rest of the stream (forces gzip CRC validation). */
  async drain(): Promise<void> {
    this.buf = Buffer.alloc(0);
    while (await this.pull()) this.buf = Buffer.alloc(0);
  }
}

function readString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString("utf-8");
}

function readNumber(buf: Buffer, offset: number, length: number): number {
  // GNU base-256 encoding for large values
  if (buf[offset] & 0x80) {
    let value = 0;
    for (let i = 1; i < length; i++) value = value * 256 + buf[offset + i];
    return value;
  }
  const str = readString(buf, offset, length).trim();
  if (str === "") return 0;
  if (!/^[0-7]+$/.test(str)) throw new TarFormatError(`Invalid numeric header field "${str}"`);
  return parseInt(str, 8);
}

function verifyChecksum(block: Buffer): void {
  const stored = readNumber(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  if (sum !== stored) throw new TarFormatError("Header checksum mismatch — archive is corrupt");
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const len = parseInt(data.subarray(pos, space).toString("ascii"), 10);
    if (!Number.isFinite(len) || len <= 0) throw new TarFormatError("Invalid pax header");
    const record = data.subarray(space + 1, pos + len - 1).toString("utf-8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

function normalizeMemberName(name: string): string {
  return name.replace(/^\.\/+/, "").replace(/\/+$/, "");
}

export type TarEntryHandler = (header: TarEntryHeader, body: AsyncIterable<Buffer>) => Promise<void>;

/**
 * Stream every member of a .tar.gz archive through `onEntry`. Validates
 * header checksums, detects truncation and reads to the end of the gzip
 * stream so CRC errors surface.
 */
export async function readTarGz(archivePath: string, onEntry: TarEntryHandler): Promise<{ entries: number }> {
  const src = createReadStream(archivePath, { highWaterMark: 256 * 1024 });
  const gunzip = createGunzip();
  src.on("error", (err) => gunzip.destroy(err));
  src.pipe(gunzip);
  const source = new ByteSource(gunzip[Symbol.asyncIterator]() as AsyncIterator<Buffer>);
  let entries = 0;
  let pax: Record<string, string> = {};
  let gnuLongName: string | null = null;
  let gnuLongLink: string | null = null;

  try {
    for (;;) {
      const block = await source.read(BLOCK);
      if (block === null) throw new TarFormatError("Archive ended without end-of-archive marker");
      if (block.equals(ZERO_BLOCK)) {
        await source.drain();
        break;
      }
      verifyChecksum(block);
      const typeflag = String.fromCharCode(block[156] || 0x30);
      let size = readNumber(block, 124, 12);

      if (typeflag === "x" || typeflag === "g" || typeflag === "L" || typeflag === "K") {
        const data = (await source.read(size)) ?? Buffer.alloc(0);
        await source.skip(padding(size).length);
        if (typeflag === "x") pax = { ...pax, ...parsePax(data) };
        else if (typeflag === "L") gnuLongName = readString(data, 0, data.length);
        else if (typeflag === "K") gnuLongLink = readString(data, 0, data.length);
        continue;
      }

      let name = readString(block, 0, 100);
      const magic = readString(block, 257, 6);
      if (magic.startsWith("ustar")) {
        const prefix = readString(block, 345, 155);
        if (prefix) name = `${prefix}/${name}`;
      }
      if (gnuLongName !== null) name = gnuLongName;
      if (pax.path !== undefined) name = pax.path;
      let linkname = readString(block, 157, 100);
      if (gnuLongLink !== null) linkname = gnuLongLink;
      if (pax.linkpath !== undefined) linkname = pax.linkpath;
      if (pax.size !== undefined) size = parseInt(pax.size, 10);

      const type: TarEntryType =
        typeflag === "0" || typeflag === "\u0000" || typeflag === "7"
          ? "file"
          : typeflag === "5"
            ? "directory"
            : typeflag === "2"
              ? "symlink"
              : typeflag === "1"
                ? "hardlink"
                : "other";
      const dataSize = type === "file" || type === "other" ? size : 0;
      const header: TarEntryHeader = {
        name: normalizeMemberName(name),
        type,
        mode: readNumber(block, 100, 8),
        uid: pax.uid !== undefined ? parseInt(pax.uid, 10) : readNumber(block, 108, 8),
        gid: pax.gid !== undefined ? parseInt(pax.gid, 10) : readNumber(block, 116, 8),
        size: dataSize,
        mtime: pax.mtime !== undefined ? parseFloat(pax.mtime) : readNumber(block, 136, 12),
        linkname,
      };
      pax = {};
      gnuLongName = null;
      gnuLongLink = null;

      const progress = { left: dataSize };
      const body = source.take(dataSize, progress);
      await onEntry(header, body);
      // Skip whatever the handler didn't consume, then the block padding
      if (progress.left > 0) await source.skip(progress.left);
      await source.skip(padding(dataSize).length);
      entries++;
    }
  } finally {
    src.destroy();
    gunzip.destroy();
  }
  return { entries };
}

// ── Extraction ──────────────────────────────────────────────────────────────

export interface ExtractedFile {
  name: string;
  path: string;
  size: number;
  sha256: string;
}

export interface ExtractTarget {
  /** Directory the member is written under */
  root: string;
  /** Path relative to root ("" = the root directory itself) */
  rel: string;
}

export interface ExtractOptions {
  /**
   * Map a member to its destination. Return null to skip the member.
   * Defaults to { root: destDir, rel: member name }.
   */
  resolveTarget?: (name: string) => ExtractTarget | null;
  /** chown extracted entries (only effective when running as root) */
  preserveOwner?: boolean;
  onFile?: (file: ExtractedFile) => void;
  signal?: AbortSignal;
}

/** Resolve a member path inside destDir, rejecting traversal. */
export function safeJoin(destDir: string, memberPath: string): string {
  if (memberPath.startsWith("/") || memberPath.includes("\u0000")) {
    throw new TarFormatError(`Unsafe archive entry "${memberPath}"`);
  }
  const parts = memberPath.split("/");
  if (parts.some((p) => p === "..")) throw new TarFormatError(`Unsafe archive entry "${memberPath}"`);
  const root = resolve(destDir);
  const full = resolve(root, memberPath);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new TarFormatError(`Unsafe archive entry "${memberPath}"`);
  }
  return full;
}

const canChown = typeof process.getuid === "function" && process.getuid() === 0;

/**
 * Extract an archive into `destDir` (or per-member roots via resolveTarget).
 * Never writes through symlinks created by the archive itself, never outside
 * the target root, and strips setuid/setgid bits.
 */
export async function extractTarGz(archivePath: string, destDir: string, opts: ExtractOptions = {}): Promise<{ files: number; bytes: number }> {
  const createdLinks = new Set<string>();
  const createdRoots = new Set<string>();
  const dirMeta: Array<{ path: string; mode: number; mtime: number; uid: number; gid: number }> = [];
  let files = 0;
  let bytes = 0;

  const resolveMember = (name: string): ExtractTarget | null =>
    opts.resolveTarget ? opts.resolveTarget(name) : { root: destDir, rel: name };
  const linkKey = (root: string, rel: string) => `${resolve(root)}\u0000${rel}`;
  const assertNoLinkInPath = (t: ExtractTarget) => {
    const parts = t.rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (createdLinks.has(linkKey(t.root, parts.slice(0, i).join("/")))) {
        throw new TarFormatError(`Archive entry "${t.rel}" would be written through a symlink`);
      }
    }
  };
  const ensureRoot = async (root: string) => {
    if (createdRoots.has(root)) return;
    await mkdir(root, { recursive: true });
    createdRoots.add(root);
  };

  await readTarGz(archivePath, async (header, body) => {
    if (opts.signal?.aborted) throw new Error("Operation cancelled");
    const t = resolveMember(header.name);
    if (t === null) return;
    if (t.rel === "") {
      if (header.type === "directory") {
        await ensureRoot(t.root);
        dirMeta.push({ path: resolve(t.root), mode: header.mode, mtime: header.mtime, uid: header.uid, gid: header.gid });
      }
      return;
    }
    const target = safeJoin(t.root, t.rel);
    assertNoLinkInPath(t);
    await ensureRoot(t.root);
    const key = linkKey(t.root, t.rel);

    switch (header.type) {
      case "directory": {
        await mkdir(target, { recursive: true });
        dirMeta.push({ path: target, mode: header.mode, mtime: header.mtime, uid: header.uid, gid: header.gid });
        createdLinks.delete(key);
        return;
      }
      case "symlink": {
        await mkdir(dirname(target), { recursive: true });
        await rm(target, { force: true, recursive: true });
        await symlink(header.linkname, target);
        createdLinks.add(key);
        if (opts.preserveOwner && canChown) await lchown(target, header.uid, header.gid).catch(() => {});
        return;
      }
      case "hardlink": {
        const lt = resolveMember(normalizeMemberName(header.linkname));
        if (lt === null) return;
        assertNoLinkInPath(lt);
        const linkTarget = safeJoin(lt.root, lt.rel);
        await mkdir(dirname(target), { recursive: true });
        await rm(target, { force: true });
        await link(linkTarget, target);
        return;
      }
      case "file": {
        await mkdir(dirname(target), { recursive: true });
        // Replace whatever is there (possibly a symlink) without following it
        await unlink(target).catch(() => {});
        const fh = await open(
          target,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0),
          0o600,
        );
        const hash = createHash("sha256");
        let size = 0;
        try {
          for await (const chunk of body) {
            if (opts.signal?.aborted) throw new Error("Operation cancelled");
            hash.update(chunk);
            size += chunk.length;
            await fh.write(chunk);
          }
        } finally {
          await fh.close();
        }
        createdLinks.delete(key);
        await chmod(target, header.mode & 0o1777);
        if (opts.preserveOwner && canChown) await lchown(target, header.uid, header.gid).catch(() => {});
        await utimes(target, header.mtime, header.mtime).catch(() => {});
        files++;
        bytes += size;
        opts.onFile?.({ name: header.name, path: target, size, sha256: hash.digest("hex") });
        return;
      }
      default:
        return;
    }
  });

  // Apply directory metadata deepest-first so child writes don't bump mtimes
  dirMeta.sort((a, b) => b.path.length - a.path.length);
  for (const d of dirMeta) {
    await chmod(d.path, (d.mode & 0o1777) | 0o700).catch(() => {});
    if (opts.preserveOwner && canChown) await lchown(d.path, d.uid, d.gid).catch(() => {});
    await utimes(d.path, d.mtime, d.mtime).catch(() => {});
  }
  return { files, bytes };
}
