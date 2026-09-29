/**
 * The terminal daemon's backup password: logging in is public, but setting it
 * is not — before this fix the first caller of /backup-auth/setup chose the
 * password and got a host shell. Only the core's admin-only terminal proxy
 * (X-Daemon-Auth) may set or change it; installs that already have a password
 * keep logging in.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { hasBackupPassword, PUBLIC_BACKUP_AUTH_PATHS, registerBackupAuthRoutes } from "../terminal-backup-auth.js";

const INTERNAL_KEY = "internal-key-from-talome-secret";

let sqlite: Database.Database;
let tokens: Map<string, number>;
let app: Hono;

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const asAdminProxy = { "x-daemon-auth": INTERNAL_KEY };

beforeEach(() => {
  sqlite = new Database(":memory:");
  tokens = new Map();
  app = new Hono();
  registerBackupAuthRoutes(app, {
    sqlite,
    isAdminProxyRequest: (c) => c.req.header("x-daemon-auth") === INTERNAL_KEY,
    tokens,
    bootId: "boot-1",
    bcryptCost: 4,
  });
});

describe("backup terminal password setup", () => {
  it("an unauthenticated caller cannot set the first password (and so gets no token)", async () => {
    expect(hasBackupPassword(sqlite)).toBe(false);

    const setup = await post("/backup-auth/setup", { password: "attacker-password" });
    expect(setup.status).toBe(403);
    expect(hasBackupPassword(sqlite)).toBe(false);

    // A forged internal header does not help.
    const forged = await post("/backup-auth/setup", { password: "attacker-password" }, { "x-daemon-auth": "guess" });
    expect(forged.status).toBe(403);
    expect(hasBackupPassword(sqlite)).toBe(false);

    const login = await post("/backup-auth", { password: "attacker-password" });
    expect(login.status).toBe(400);
    expect(tokens.size).toBe(0);
  });

  it("the setup path is not public on the daemon", () => {
    expect(PUBLIC_BACKUP_AUTH_PATHS).toEqual(["/backup-auth"]);
    const daemon = readFileSync(join(__dirname, "..", "terminal-daemon.ts"), "utf-8");
    const publicLine = daemon.split("\n").find((l) => l.startsWith("const PUBLIC_DAEMON_PATHS"));
    expect(publicLine).toBeDefined();
    expect(publicLine).not.toContain("/backup-auth/setup");
    expect(daemon).toContain("registerBackupAuthRoutes(app");
    expect(daemon).not.toMatch(/app\.post\("\/backup-auth\/setup"/);
  });

  it("an admin (through the core's terminal proxy) sets it, then the password logs in", async () => {
    const setup = await post("/backup-auth/setup", { password: "owner-password" }, asAdminProxy);
    expect(setup.status).toBe(200);
    expect(hasBackupPassword(sqlite)).toBe(true);

    const wrong = await post("/backup-auth", { password: "nope-nope" });
    expect(wrong.status).toBe(401);
    expect(tokens.size).toBe(0);

    const login = await post("/backup-auth", { password: "owner-password" });
    expect(login.status).toBe(200);
    const { token, bootId } = (await login.json()) as { token: string; bootId: string };
    expect(token).toMatch(/^backup_[0-9a-f]{32}$/);
    expect(bootId).toBe("boot-1");
    expect(tokens.get(token)).toBeGreaterThan(Date.now());
  });

  it("rejects a short password", async () => {
    const setup = await post("/backup-auth/setup", { password: "short" }, asAdminProxy);
    expect(setup.status).toBe(400);
    expect(hasBackupPassword(sqlite)).toBe(false);
  });

  it("an existing install keeps its password; only an admin can change it, which ends old sessions", async () => {
    sqlite.exec("CREATE TABLE IF NOT EXISTS daemon_auth (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const existing = await bcrypt.hash("existing-password", 4);
    sqlite.prepare("INSERT INTO daemon_auth (key, value) VALUES ('password_hash', ?)").run(existing);

    const login = await post("/backup-auth", { password: "existing-password" });
    expect(login.status).toBe(200);
    expect(tokens.size).toBe(1);

    const takeover = await post("/backup-auth/setup", { password: "attacker-password" });
    expect(takeover.status).toBe(403);
    expect((await post("/backup-auth", { password: "existing-password" })).status).toBe(200);

    const changed = await post("/backup-auth/setup", { password: "new-owner-password" }, asAdminProxy);
    expect(changed.status).toBe(200);
    expect(tokens.size).toBe(0);
    expect((await post("/backup-auth", { password: "existing-password" })).status).toBe(401);
    expect((await post("/backup-auth", { password: "new-owner-password" })).status).toBe(200);
  });

  it("a legacy (pre-bcrypt) hash is cleared, and re-setup still needs an admin", async () => {
    sqlite.exec("CREATE TABLE IF NOT EXISTS daemon_auth (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    sqlite.prepare("INSERT INTO daemon_auth (key, value) VALUES ('password_hash', 'sha256:abc')").run();

    const login = await post("/backup-auth", { password: "whatever-pass" });
    expect(login.status).toBe(410);
    expect(hasBackupPassword(sqlite)).toBe(false);

    expect((await post("/backup-auth/setup", { password: "attacker-password" })).status).toBe(403);
    expect(hasBackupPassword(sqlite)).toBe(false);
  });

  it("locks out an address after repeated wrong passwords", async () => {
    await post("/backup-auth/setup", { password: "owner-password" }, asAdminProxy);
    for (let i = 0; i < 5; i++) {
      expect((await post("/backup-auth", { password: "wrong-password" }, { "x-real-ip": "10.0.0.9" })).status).toBe(401);
    }
    expect((await post("/backup-auth", { password: "owner-password" }, { "x-real-ip": "10.0.0.9" })).status).toBe(429);
  });
});
