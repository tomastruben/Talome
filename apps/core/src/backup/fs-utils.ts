import { createReadStream, readFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve, sep, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** Root directory for app backups. Resolved lazily so tests can override it. */
export function getBackupRoot(): string {
  if (process.env.TALOME_APP_BACKUP_DIR) return resolve(process.env.TALOME_APP_BACKUP_DIR);
  return join(process.env.HOME || homedir(), ".talome", "backups", "apps");
}

/** True when `child` is `parent` or lives underneath it. */
export function isWithin(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest("hex");
}

export interface WalkedFile {
  /** POSIX path relative to the walked root */
  rel: string;
  abs: string;
  size: number;
}

/** List regular files below `root` (symlinks are not followed). */
export async function listFiles(root: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: "" }];
  while (stack.length > 0) {
    const { abs, rel } = stack.pop()!;
    const names = await readdir(abs);
    for (const name of names) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = await lstat(childAbs);
      if (st.isDirectory()) stack.push({ abs: childAbs, rel: childRel });
      else if (st.isFile()) out.push({ rel: childRel, abs: childAbs, size: st.size });
    }
  }
  return out;
}

let cachedVersion: string | null = null;

/** Talome version recorded in manifests. */
export function getTalomeVersion(): string {
  if (process.env.TALOME_VERSION) return process.env.TALOME_VERSION;
  if (cachedVersion) return cachedVersion;
  const here = dirname(fileURLToPath(import.meta.url));
  // src/backup → ../../package.json (apps/core), then the monorepo root
  for (const candidate of [join(here, "..", "..", "package.json"), join(here, "..", "..", "..", "..", "package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as { version?: string };
      if (pkg.version) {
        cachedVersion = pkg.version;
        return pkg.version;
      }
    } catch {
      // try next
    }
  }
  cachedVersion = "unknown";
  return cachedVersion;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Filesystem-safe timestamp: 2026-01-31T02-00-00-000Z */
export function timestampSlug(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-");
}
