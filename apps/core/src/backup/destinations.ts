/**
 * Backup destinations — where completed backups are copied in addition to
 * the local backup root.
 *
 *  - "local":  a directory (external disk, NAS mount, ...)
 *  - "rclone": an rclone path. Either an existing remote from the user's
 *              rclone.conf ("b2:bucket/talome"), or a Talome-managed remote
 *              whose credentials are stored encrypted in settings and passed
 *              to rclone via RCLONE_CONFIG_* environment variables.
 */

import { randomUUID } from "node:crypto";
import { cp, mkdir, rm, writeFile, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { getSetting, setSetting } from "../utils/settings.js";
import { errorMessage, getBackupRoot, isWithin } from "./fs-utils.js";
import { rcloneCopyFrom, rcloneExists, rclonePurge, rcloneSync, runRclone } from "./rclone.js";

export interface BackupDestination {
  id: string;
  name: string;
  type: "local" | "rclone";
  target: string;
  remoteType: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface PublicBackupDestination extends BackupDestination {
  hasCredentials: boolean;
}

const PARAM_KEY = /^[a-z0-9_]{1,64}$/i;

export const createDestinationSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    type: z.enum(["local", "rclone"]),
    target: z.string().trim().min(1).max(1024),
    /** rclone backend (s3, b2, sftp, drive, ...) for a Talome-managed remote */
    remoteType: z
      .string()
      .regex(/^[a-z0-9]+$/)
      .max(32)
      .nullable()
      .optional(),
    /** rclone backend parameters, e.g. { access_key_id, secret_access_key, region } */
    credentials: z.record(z.string().regex(PARAM_KEY), z.string().max(8192)).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.target.startsWith("-")) ctx.addIssue({ code: "custom", message: "Invalid target", path: ["target"] });
    if (v.type === "local" && !isAbsolute(v.target)) {
      ctx.addIssue({ code: "custom", message: "Local destinations need an absolute path", path: ["target"] });
    }
    if (v.type === "rclone" && !v.remoteType && !v.target.includes(":")) {
      ctx.addIssue({ code: "custom", message: "Use remote:path for an existing rclone remote, or set remoteType", path: ["target"] });
    }
    if (v.type === "local" && (v.remoteType || v.credentials)) {
      ctx.addIssue({ code: "custom", message: "Local destinations take no credentials", path: ["credentials"] });
    }
  });
export type CreateDestinationInput = z.infer<typeof createDestinationSchema>;

function secretKey(id: string): string {
  return `backup_destination_${id}_secret`;
}

interface DestinationRow {
  id: string;
  name: string;
  type: string;
  target: string;
  remote_type: string | null;
  enabled: number;
  created_at: string;
}

function rowToDestination(row: DestinationRow): BackupDestination {
  return {
    id: row.id,
    name: row.name,
    type: row.type === "local" ? "local" : "rclone",
    target: row.target,
    remoteType: row.remote_type,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export function listDestinations(): PublicBackupDestination[] {
  const rows = db.all(sql`SELECT * FROM backup_destinations ORDER BY created_at ASC`) as DestinationRow[];
  return rows.map((r) => {
    const d = rowToDestination(r);
    return { ...d, hasCredentials: !!getSetting(secretKey(d.id)) };
  });
}

export function getDestination(id: string): BackupDestination | null {
  const row = db.get(sql`SELECT * FROM backup_destinations WHERE id = ${id}`) as DestinationRow | undefined;
  return row ? rowToDestination(row) : null;
}

export function createDestination(input: CreateDestinationInput): { ok: true; destination: PublicBackupDestination } | { ok: false; error: string } {
  const target = input.type === "local" ? resolve(input.target) : input.target;
  if (input.type === "local" && isWithin(getBackupRoot(), target)) {
    return { ok: false, error: "A destination cannot be inside the local backup directory" };
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  db.run(sql`INSERT INTO backup_destinations (id, name, type, target, remote_type, enabled, created_at)
    VALUES (${id}, ${input.name}, ${input.type}, ${target}, ${input.remoteType ?? null}, 1, ${now})`);
  if (input.credentials && Object.keys(input.credentials).length > 0) {
    setSetting(secretKey(id), JSON.stringify(input.credentials));
  }
  const destination = getDestination(id)!;
  return { ok: true, destination: { ...destination, hasCredentials: !!input.credentials && Object.keys(input.credentials).length > 0 } };
}

export function deleteDestination(id: string): boolean {
  const existing = getDestination(id);
  if (!existing) return false;
  db.run(sql`DELETE FROM backup_destinations WHERE id = ${id}`);
  db.run(sql`DELETE FROM settings WHERE key = ${secretKey(id)}`);
  return true;
}

/** Name of the Talome-managed rclone remote for a destination. */
export function managedRemoteName(id: string): string {
  return `talome${id.replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase()}`;
}

/**
 * Build the rclone environment + root path for a destination. Credentials go
 * into RCLONE_CONFIG_<REMOTE>_<PARAM> variables only.
 */
export function buildRcloneTarget(dest: Pick<BackupDestination, "id" | "type" | "target" | "remoteType">): {
  root: string;
  env: Record<string, string>;
} {
  if (dest.type !== "rclone" || !dest.remoteType) return { root: dest.target.replace(/\/+$/, ""), env: {} };
  const remote = managedRemoteName(dest.id);
  const prefix = `RCLONE_CONFIG_${remote.toUpperCase()}_`;
  const env: Record<string, string> = { [`${prefix}TYPE`]: dest.remoteType };
  const raw = getSetting(secretKey(dest.id));
  if (raw) {
    try {
      const params = JSON.parse(raw) as Record<string, string>;
      for (const [key, value] of Object.entries(params)) {
        if (!PARAM_KEY.test(key) || key.toLowerCase() === "type") continue;
        env[`${prefix}${key.toUpperCase()}`] = String(value);
      }
    } catch {
      // corrupt secret — rclone will report missing credentials
    }
  }
  return { root: `${remote}:${dest.target.replace(/^\/+/, "").replace(/\/+$/, "")}`, env };
}

/** Destination used by a legacy `cloud_target` string on a schedule. */
export function legacyCloudTargetDestination(cloudTarget: string): BackupDestination {
  return {
    id: "legacy",
    name: cloudTarget,
    type: cloudTarget.startsWith("/") ? "local" : "rclone",
    target: cloudTarget,
    remoteType: null,
    enabled: true,
    createdAt: new Date(0).toISOString(),
  };
}

function joinRemote(root: string, ...parts: string[]): string {
  const sep = root.endsWith(":") ? "" : "/";
  return `${root}${sep}${parts.join("/")}`;
}

/** Copy a finished backup directory to the destination. Never throws. */
export async function copyToDestination(
  dest: BackupDestination,
  localBackupDir: string,
  appId: string,
  dirName: string,
): Promise<{ ok: true; location: string } | { ok: false; error: string }> {
  try {
    if (dest.type === "local") {
      const location = join(dest.target, appId, dirName);
      await mkdir(join(dest.target, appId), { recursive: true });
      await cp(localBackupDir, location, { recursive: true, errorOnExist: false, force: true });
      return { ok: true, location };
    }
    const { root, env } = buildRcloneTarget(dest);
    const location = joinRemote(root, appId, dirName);
    const r = await rcloneSync(localBackupDir, location, { env });
    return r.success ? { ok: true, location } : { ok: false, error: r.error ?? "rclone copy failed" };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Remove a backup copy from the destination. Never throws. */
export async function deleteFromDestination(dest: BackupDestination, location: string): Promise<{ ok: boolean; error?: string }> {
  try {
    if (dest.type === "local") {
      if (!isWithin(dest.target, location) || resolve(location) === resolve(dest.target)) {
        return { ok: false, error: "Refusing to delete outside the destination" };
      }
      await rm(location, { recursive: true, force: true });
      return { ok: true };
    }
    const { env } = buildRcloneTarget(dest);
    const r = await rclonePurge(location, { env });
    return { ok: r.success, error: r.error };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Fetch a backup copy from a destination into a local directory. */
export async function fetchFromDestination(dest: BackupDestination, location: string, localDir: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await mkdir(localDir, { recursive: true });
    if (dest.type === "local") {
      await cp(location, localDir, { recursive: true });
      return { ok: true };
    }
    const { env } = buildRcloneTarget(dest);
    const r = await rcloneCopyFrom(location, localDir, { env });
    return { ok: r.success, error: r.error };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Probe that a destination is writable/reachable. */
export async function testDestination(dest: BackupDestination): Promise<{ ok: boolean; error?: string }> {
  try {
    if (dest.type === "local") {
      await mkdir(dest.target, { recursive: true });
      const probe = join(dest.target, `.talome-probe-${randomUUID()}`);
      await writeFile(probe, "ok");
      await unlink(probe);
      return { ok: true };
    }
    const { root, env } = buildRcloneTarget(dest);
    const mk = await runRclone(["mkdir", root], { env, timeoutMs: 30_000 });
    if (!mk.success) return { ok: false, error: mk.error };
    const exists = await rcloneExists(root, { env, timeoutMs: 30_000 });
    return exists ? { ok: true } : { ok: false, error: "Remote path is not reachable" };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
