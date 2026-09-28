/**
 * Backup verification — proves a backup can actually be restored.
 *
 *  1. manifest.json parses and matches the archive checksum
 *  2. test-restore: the archive is extracted into a temp dir, every file is
 *     re-hashed from disk and compared with the manifest (missing / extra /
 *     modified files are errors)
 *  3. every SQLite database in the extracted copy passes PRAGMA integrity_check
 *  4. SQL dumps are non-empty, start with the dump header and end with the
 *     completion marker
 *  5. the compose snapshot matches its recorded checksum
 *
 * When there isn't enough free space for a test restore, the archive is
 * verified by streaming (checksums only) and the result says so.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, statfs } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { writeNotification } from "../db/notifications.js";
import { getDestination, fetchFromDestination } from "./destinations.js";
import { validateSqlDump } from "./dumps.js";
import { errorMessage, getBackupRoot, listFiles, sha256File } from "./fs-utils.js";
import { checkSqliteIntegrity } from "./sqlite-check.js";
import { hasSqliteMagic } from "./sqlite-integrity.js";
import { endVerify, tryStartVerify } from "./state.js";
import { getBackupRow, setVerifyState, type BackupRow } from "./store.js";
import { extractTarGz, readTarGz } from "./tar.js";
import {
  ARCHIVE_FILE_NAME,
  ARCHIVE_META_DIR,
  MANIFEST_FILE_NAME,
  backupManifestSchema,
  type BackupManifest,
  type VerifyBackupResult,
  type VerifyCheck,
} from "./types.js";

const MAX_LISTED_ERRORS = 20;
const SQLITE_NAME = /\.(db|sqlite|sqlite3|db3)$/i;
const SQLITE_SIDECAR = /-(wal|shm|journal)$/i;

export interface VerifyOptions {
  /** Skip the test restore and only stream-verify checksums */
  streamOnly?: boolean;
  signal?: AbortSignal;
}

export async function loadManifest(path: string): Promise<{ ok: true; manifest: BackupManifest } | { ok: false; error: string }> {
  try {
    const raw = JSON.parse(await readFile(path, "utf-8")) as unknown;
    const parsed = backupManifestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `manifest is invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}` };
    return { ok: true, manifest: parsed.data };
  } catch (err) {
    return { ok: false, error: `manifest unreadable: ${errorMessage(err)}` };
  }
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

async function readHeader(path: string): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function summarize(errors: string[]): string[] {
  if (errors.length <= MAX_LISTED_ERRORS) return errors;
  return [...errors.slice(0, MAX_LISTED_ERRORS), `…and ${errors.length - MAX_LISTED_ERRORS} more`];
}

/** Compare a list of (path, size, sha256) with the manifest's file list. */
export function compareWithManifest(
  manifest: Pick<BackupManifest, "files">,
  actual: Array<{ path: string; size: number; sha256: string }>,
): string[] {
  const errors: string[] = [];
  const expected = new Map(manifest.files.map((f) => [f.path, f]));
  const seen = new Set<string>();
  for (const a of actual) {
    if (a.path === `${ARCHIVE_META_DIR}/${MANIFEST_FILE_NAME}`) continue;
    const e = expected.get(a.path);
    if (!e) {
      errors.push(`unexpected file ${a.path}`);
      continue;
    }
    seen.add(a.path);
    if (e.size !== a.size) errors.push(`size mismatch ${a.path} (${a.size} ≠ ${e.size})`);
    else if (e.sha256 !== a.sha256) errors.push(`checksum mismatch ${a.path}`);
  }
  for (const path of expected.keys()) if (!seen.has(path)) errors.push(`missing file ${path}`);
  return errors;
}

async function resolveArchive(row: BackupRow, workDir: string): Promise<{ archive: string; manifestPath: string | null; fetched: boolean } | { error: string }> {
  const archive = row.file_path;
  if (archive && existsSync(archive)) return { archive, manifestPath: row.manifest_path, fetched: false };
  // Local copy gone — try the destination copy
  if (row.cloud_target && row.destination_id) {
    const dest = getDestination(row.destination_id);
    if (dest) {
      const localDir = join(workDir, "fetched");
      const r = await fetchFromDestination(dest, row.cloud_target, localDir);
      if (r.ok && existsSync(join(localDir, ARCHIVE_FILE_NAME))) {
        return { archive: join(localDir, ARCHIVE_FILE_NAME), manifestPath: join(localDir, MANIFEST_FILE_NAME), fetched: true };
      }
      return { error: `archive missing locally and could not be fetched from ${dest.name}: ${r.error ?? "not found"}` };
    }
  }
  return { error: "archive file is missing" };
}

/**
 * Verify a backup by id. Stores verify_status / verified_at / verify_detail.
 * Never throws. Stable signature.
 */
export async function verifyBackup(backupId: string, opts: VerifyOptions = {}): Promise<VerifyBackupResult> {
  const verifiedAt = new Date().toISOString();
  const row = getBackupRow(backupId);
  if (!row) return { success: false, backupId, status: "failed", verifiedAt, checks: [], errors: ["Backup not found"] };
  if (row.status !== "completed") {
    return { success: false, backupId, status: "failed", verifiedAt, checks: [], errors: [`Backup is ${row.status}, not completed`] };
  }
  if (!tryStartVerify(backupId)) {
    return { success: false, backupId, status: "failed", verifiedAt, checks: [], errors: ["Verification already running"] };
  }

  const previous = { status: row.verify_status, at: row.verified_at, detail: row.verify_detail };
  setVerifyState(backupId, "running", previous.at, previous.detail);
  const checks: VerifyCheck[] = [];
  const errors: string[] = [];
  const workDir = join(getBackupRoot(), ".verify", `${backupId}-${randomUUID().slice(0, 8)}`);
  const add = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, detail });
    if (!ok) errors.push(detail ? `${name}: ${detail}` : name);
  };

  try {
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const located = await resolveArchive(row, workDir);
    if ("error" in located) {
      add("archive present", false, located.error);
      return await finish();
    }
    add("archive present", true, located.fetched ? "fetched from destination" : undefined);

    // ── Manifest ─────────────────────────────────────────────────────────
    let manifest: BackupManifest | null = null;
    if (located.manifestPath) {
      const m = await loadManifest(located.manifestPath);
      if (m.ok) {
        manifest = m.manifest;
        add("manifest", true);
      } else {
        add("manifest", false, m.error);
      }
    } else {
      checks.push({ name: "manifest", ok: true, detail: "legacy backup without manifest — checksums unavailable" });
    }

    if (manifest?.archive) {
      const sha = await sha256File(located.archive);
      add("archive checksum", sha === manifest.archive.sha256, sha === manifest.archive.sha256 ? undefined : "archive was modified or corrupted");
      if (row.archive_sha256 && row.archive_sha256 !== manifest.archive.sha256) add("manifest matches record", false, "manifest checksum differs from database record");
    }

    // ── Test restore (or streaming verification) ─────────────────────────
    const needed = manifest ? manifest.totals.bytes : 0;
    const free = await freeBytes(dirname(workDir));
    const canExtract = !opts.streamOnly && (free === null || needed === 0 || free > needed * 1.1 + 64 * 1024 * 1024);

    if (!canExtract) {
      const streamed: Array<{ path: string; size: number; sha256: string }> = [];
      try {
        await readTarGz(located.archive, async (header, body) => {
          if (header.type !== "file") return;
          const hash = createHash("sha256");
          let size = 0;
          for await (const chunk of body) {
            hash.update(chunk);
            size += chunk.length;
          }
          streamed.push({ path: header.name, size, sha256: hash.digest("hex") });
        });
        add("archive readable", true, `${streamed.length} files streamed (test restore skipped: not enough free space)`);
      } catch (err) {
        add("archive readable", false, errorMessage(err));
      }
      if (manifest) {
        const diff = compareWithManifest(manifest, streamed);
        add("file checksums", diff.length === 0, diff.length ? summarize(diff).join("; ") : `${manifest.files.length} files match`);
      }
      return await finish();
    }

    const extractDir = join(workDir, "restore");
    try {
      await extractTarGz(located.archive, extractDir, { signal: opts.signal });
      add("archive readable", true);
    } catch (err) {
      add("archive readable", false, errorMessage(err));
      return await finish();
    }

    const onDisk = await listFiles(extractDir);
    const hashed: Array<{ path: string; size: number; sha256: string }> = [];
    for (const f of onDisk) hashed.push({ path: f.rel, size: f.size, sha256: await sha256File(f.abs) });
    if (manifest) {
      const diff = compareWithManifest(manifest, hashed);
      add("test restore checksums", diff.length === 0, diff.length ? summarize(diff).join("; ") : `${manifest.files.length} files restored and match`);
    } else {
      add("test restore", true, `${hashed.length} files extracted`);
    }

    // ── SQLite integrity ─────────────────────────────────────────────────
    let sqliteCount = 0;
    for (const f of onDisk) {
      if (SQLITE_SIDECAR.test(f.rel) || f.size < 512) continue;
      if (f.rel.startsWith(`${ARCHIVE_META_DIR}/`)) continue;
      const looksLikeDb = SQLITE_NAME.test(f.rel) || hasSqliteMagic(await readHeader(f.abs));
      if (!looksLikeDb) continue;
      if (!hasSqliteMagic(await readHeader(f.abs))) {
        add(`sqlite ${f.rel}`, false, "file has a database extension but no SQLite header");
        continue;
      }
      sqliteCount++;
      const r = await checkSqliteIntegrity(f.abs, f.size);
      add(`sqlite ${f.rel}`, r.ok, r.ok ? "integrity ok" : r.detail);
    }
    if (sqliteCount === 0) checks.push({ name: "sqlite", ok: true, detail: "no SQLite databases found" });

    // ── SQL dumps ────────────────────────────────────────────────────────
    for (const d of manifest?.dumps ?? []) {
      if (!d.path || d.engine === "redis") continue;
      const p = join(extractDir, d.path);
      if (!existsSync(p)) {
        add(`dump ${d.service}`, false, "dump missing from archive");
        continue;
      }
      const r = await validateSqlDump(p, d.engine);
      add(`dump ${d.service}`, r.ok, r.detail);
    }

    // ── Compose snapshot ─────────────────────────────────────────────────
    if (manifest?.compose) {
      const p = join(extractDir, manifest.compose.archivePath);
      const ok = existsSync(p) && (await sha256File(p)) === manifest.compose.sha256;
      add("compose snapshot", ok, ok ? undefined : "compose snapshot missing or modified");
    }

    return await finish();
  } catch (err) {
    add("verification", false, errorMessage(err));
    return await finish();
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    endVerify(backupId);
  }

  async function finish(): Promise<VerifyBackupResult> {
    const ok = errors.length === 0 && checks.length > 0;
    const status = ok ? "verified" : "failed";
    const detail = JSON.stringify({ checks: checks.slice(0, 200), errors: summarize(errors) });
    setVerifyState(backupId, status, verifiedAt, detail);
    if (!ok) {
      writeNotification(
        "critical",
        `Backup verification failed: ${row!.app_id ?? "backup"}`,
        summarize(errors).slice(0, 3).join("; "),
        row!.app_id ?? undefined,
      );
    }
    return { success: ok, backupId, status, verifiedAt, checks, errors: summarize(errors) };
  }
}
