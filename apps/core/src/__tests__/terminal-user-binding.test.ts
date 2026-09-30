/**
 * An open dashboard terminal (an unrestricted host shell) must end when the
 * admin who opened it is deleted, demoted or signed out everywhere. Before,
 * the daemon checked only the one-time PTY token at connect time, so the
 * shell stayed usable until the tab was closed.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  bindTerminalToUser,
  createTerminalUserGuard,
  terminalBindingValid,
} from "../terminal-user-binding.js";

let sqlite: Database.Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL, session_version INTEGER NOT NULL DEFAULT 0)`);
  sqlite.prepare("INSERT INTO users (id, role) VALUES (?, ?)").run("admin-1", "admin");
  sqlite.prepare("INSERT INTO users (id, role) VALUES (?, ?)").run("member-1", "member");
});

describe("binding a terminal to the admin who opened it", () => {
  it("binds admins only", () => {
    expect(bindTerminalToUser(sqlite, "admin-1")).toEqual({ userId: "admin-1", sessionVersion: 0 });
    expect(bindTerminalToUser(sqlite, "member-1")).toBeNull();
    expect(bindTerminalToUser(sqlite, "nobody")).toBeNull();
  });

  it("a binding stops being valid on demotion, deletion or a session-version bump", () => {
    const binding = bindTerminalToUser(sqlite, "admin-1")!;
    expect(terminalBindingValid(sqlite, binding)).toBe(true);

    sqlite.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ?").run("admin-1");
    expect(terminalBindingValid(sqlite, binding)).toBe(false);

    const rebound = bindTerminalToUser(sqlite, "admin-1")!;
    sqlite.prepare("UPDATE users SET role = 'member' WHERE id = ?").run("admin-1");
    expect(terminalBindingValid(sqlite, rebound)).toBe(false);

    sqlite.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run("admin-1");
    expect(terminalBindingValid(sqlite, rebound)).toBe(true);
    sqlite.prepare("DELETE FROM users WHERE id = ?").run("admin-1");
    expect(terminalBindingValid(sqlite, rebound)).toBe(false);
  });

  it("works against a database without session_version (not migrated yet)", () => {
    const old = new Database(":memory:");
    old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL)`);
    old.prepare("INSERT INTO users VALUES ('a', 'admin')").run();
    const binding = bindTerminalToUser(old, "a");
    expect(binding).toEqual({ userId: "a", sessionVersion: 0 });
    expect(terminalBindingValid(old, binding!)).toBe(true);
  });
});

describe("the daemon's socket guard", () => {
  it("closes an open socket once its admin is demoted (input and periodic sweep)", () => {
    const closed: string[] = [];
    const guard = createTerminalUserGuard<string>(sqlite, (ws) => closed.push(ws), { recheckMs: 0 });
    guard.track("ws-a", bindTerminalToUser(sqlite, "admin-1")!);
    guard.track("ws-b", bindTerminalToUser(sqlite, "admin-1")!);

    expect(guard.check("ws-a")).toBe(true);
    expect(closed).toEqual([]);

    sqlite.prepare("UPDATE users SET role = 'member', session_version = session_version + 1 WHERE id = ?").run("admin-1");

    // Next keystroke on ws-a is refused and the socket closed.
    expect(guard.check("ws-a")).toBe(false);
    expect(closed).toEqual(["ws-a"]);
    // An idle socket is closed by the sweep.
    expect(guard.sweep()).toBe(1);
    expect(closed).toEqual(["ws-a", "ws-b"]);
    // Closed sockets are no longer tracked.
    expect(guard.sweep()).toBe(0);
  });

  it("unbound sockets (MCP or backup tokens) are left to their own checks", () => {
    const closed: string[] = [];
    const guard = createTerminalUserGuard<string>(sqlite, (ws) => closed.push(ws), { recheckMs: 0 });
    expect(guard.check("ws-mcp")).toBe(true);
    expect(guard.sweep()).toBe(0);
    expect(closed).toEqual([]);
  });

  it("re-reads the database at most once per recheck interval on input", () => {
    const closed: string[] = [];
    const guard = createTerminalUserGuard<string>(sqlite, (ws) => closed.push(ws), { recheckMs: 1_000 });
    guard.track("ws", bindTerminalToUser(sqlite, "admin-1")!);
    sqlite.prepare("DELETE FROM users WHERE id = ?").run("admin-1");
    const t = Date.now();
    expect(guard.check("ws", t + 10)).toBe(true); // within the interval
    expect(guard.check("ws", t + 1_500)).toBe(false);
    expect(closed).toEqual(["ws"]);
  });
});
