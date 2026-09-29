/**
 * Backup terminal password — the terminal daemon's own login, for when the
 * main Talome server is down and the dashboard terminal is unreachable.
 *
 * Logging in with the password (POST /backup-auth) is public: that is the
 * point of a backup login. Setting or changing the password is not — the
 * first caller would choose the password and get a host shell. Only the core's
 * terminal proxy may do it (it adds the daemon's internal key and requires a
 * logged-in admin, routes/terminal.ts), so the password is set from the
 * dashboard: Settings -> Security -> Backup terminal. Installs that already
 * have a password keep it and keep logging in as before.
 */

import type { Context, Hono } from "hono";
import type Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const MIN_BACKUP_PASSWORD_LENGTH = 8;
const DEFAULT_BCRYPT_COST = 12;
const DEFAULT_TOKEN_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const LOGIN_BLOCK_MS = 5 * 60 * 1000;

/** Daemon paths under /backup-auth that need no credential. The setup path is deliberately not one. */
export const PUBLIC_BACKUP_AUTH_PATHS: readonly string[] = ["/backup-auth"];

export interface BackupAuthDeps {
  sqlite: Database.Database;
  /** True only for requests from the core's admin-only terminal proxy (X-Daemon-Auth). */
  isAdminProxyRequest: (c: Context) => boolean;
  /** Issued backup tokens: token -> expiresAt (ms). Shared with the daemon's auth checks. */
  tokens: Map<string, number>;
  bootId: string;
  bcryptCost?: number;
  tokenTtlMs?: number;
}

const passwordSchema = z.object({ password: z.string().min(1).max(1024) });

function ensureTable(sqlite: Database.Database): void {
  sqlite.exec("CREATE TABLE IF NOT EXISTS daemon_auth (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
}

function storedHash(sqlite: Database.Database): string | undefined {
  const row = sqlite.prepare("SELECT value FROM daemon_auth WHERE key = 'password_hash'").get() as { value: string } | undefined;
  return row?.value;
}

export function hasBackupPassword(sqlite: Database.Database): boolean {
  ensureTable(sqlite);
  return !!storedHash(sqlite);
}

function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
}

async function readPassword(c: Context): Promise<string | null> {
  const parsed = passwordSchema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data.password : null;
}

export function registerBackupAuthRoutes(app: Hono, deps: BackupAuthDeps): void {
  const { sqlite, tokens } = deps;
  const cost = deps.bcryptCost ?? DEFAULT_BCRYPT_COST;
  const ttl = deps.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  const attempts = new Map<string, { count: number; blockedUntil: number }>();
  ensureTable(sqlite);

  // Whether a password is set (behind the daemon's auth gate).
  app.get("/backup-auth/status", (c) => c.json({ hasPassword: hasBackupPassword(sqlite) }));

  // Set or change the password — admin only, through the core's terminal proxy.
  app.post("/backup-auth/setup", async (c) => {
    if (!deps.isAdminProxyRequest(c)) {
      return c.json(
        { error: "Set the backup terminal password from the Talome dashboard as an admin (Settings -> Security)." },
        403,
      );
    }
    const password = await readPassword(c);
    if (!password || password.length < MIN_BACKUP_PASSWORD_LENGTH) {
      return c.json({ error: `Password must be at least ${MIN_BACKUP_PASSWORD_LENGTH} characters` }, 400);
    }
    const hash = await bcrypt.hash(password, cost);
    sqlite.prepare("INSERT OR REPLACE INTO daemon_auth (key, value) VALUES ('password_hash', ?)").run(hash);
    // A new password ends every backup session opened with the old one.
    tokens.clear();
    return c.json({ ok: true });
  });

  // Log in with the password (public).
  app.post("/backup-auth", async (c) => {
    const ip = clientIp(c);
    const attempt = attempts.get(ip);
    if (attempt && attempt.blockedUntil > Date.now()) {
      return c.json({ error: "Too many attempts. Try again later." }, 429);
    }

    const stored = storedHash(sqlite);
    if (!stored) {
      return c.json(
        { error: "No backup terminal password is set. An admin can set one in the Talome dashboard (Settings -> Security)." },
        400,
      );
    }

    // Legacy hashes (pre-bcrypt) aren't valid bcrypt strings — an admin sets a new one.
    if (!stored.startsWith("$2")) {
      sqlite.prepare("DELETE FROM daemon_auth WHERE key = 'password_hash'").run();
      return c.json(
        { error: "The backup terminal password must be set again. An admin can set it in the Talome dashboard (Settings -> Security)." },
        410,
      );
    }

    const password = await readPassword(c);
    // bcrypt.compare does constant-time comparison internally.
    const valid = password ? await bcrypt.compare(password, stored) : false;
    if (!valid) {
      const prev = attempts.get(ip) || { count: 0, blockedUntil: 0 };
      prev.count++;
      if (prev.count >= MAX_FAILED_LOGINS) prev.blockedUntil = Date.now() + LOGIN_BLOCK_MS;
      attempts.set(ip, prev);
      return c.json({ error: "Invalid password" }, 401);
    }

    attempts.delete(ip);
    const token = `backup_${randomUUID().replace(/-/g, "")}`;
    tokens.set(token, Date.now() + ttl);
    return c.json({ token, bootId: deps.bootId });
  });
}
