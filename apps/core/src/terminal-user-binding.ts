/**
 * Terminal sessions opened from the dashboard are bound to the admin who
 * opened them, so an open host shell ends when that admin loses access.
 *
 * The dashboard gets a one-time PTY token through the core's admin-only
 * proxy (routes/terminal.ts), which tells the daemon who asked
 * (TERMINAL_USER_HEADER). The daemon records the user and their session
 * version with the token; once the WebSocket is open it re-reads the users
 * table (same SQLite file) and closes the socket when the user was deleted,
 * is no longer an admin, or had their sessions ended (users.session_version
 * bumped by a role change or password reset). Without this, a demoted or
 * deleted admin kept an unrestricted shell until they closed the tab.
 *
 * Kept free of daemon side effects so it can be unit-tested.
 */
import type Database from "better-sqlite3";

/** Set by the core's terminal proxy (after the client's headers) on daemon requests. */
export const TERMINAL_USER_HEADER = "x-talome-user-id";

export interface TerminalUserBinding {
  userId: string;
  /** users.session_version when the terminal was opened. */
  sessionVersion: number;
}

interface UserAccess {
  role: string;
  sessionVersion: number;
}

/** The user's role and session version; null when missing or unreadable (fail closed). */
function readUserAccess(sqlite: Database.Database, userId: string): UserAccess | null {
  try {
    const row = sqlite.prepare("SELECT role, session_version AS sv FROM users WHERE id = ?").get(userId) as
      | { role: string; sv: number | null }
      | undefined;
    return row ? { role: row.role, sessionVersion: row.sv ?? 0 } : null;
  } catch {
    // A database the core has not migrated yet has no session_version.
    try {
      const row = sqlite.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | undefined;
      return row ? { role: row.role, sessionVersion: 0 } : null;
    } catch {
      return null;
    }
  }
}

/** Bind a new terminal to `userId`; null when that user is not (or no longer) an admin. */
export function bindTerminalToUser(sqlite: Database.Database, userId: string): TerminalUserBinding | null {
  const access = readUserAccess(sqlite, userId);
  if (!access || access.role !== "admin") return null;
  return { userId, sessionVersion: access.sessionVersion };
}

/** Whether a bound terminal may stay open: same user, still an admin, sessions not ended since. */
export function terminalBindingValid(sqlite: Database.Database, binding: TerminalUserBinding): boolean {
  const access = readUserAccess(sqlite, binding.userId);
  return !!access && access.role === "admin" && access.sessionVersion === binding.sessionVersion;
}

export interface TerminalUserGuard<S> {
  track(socket: S, binding: TerminalUserBinding): void;
  untrack(socket: S): void;
  /**
   * Re-check one socket before acting on its input (throttled to one DB read
   * per `recheckMs`). False — and the socket is closed — when its user lost
   * access. Unbound sockets (MCP/backup tokens, checked by their own rules)
   * always pass.
   */
  check(socket: S, now?: number): boolean;
  /** Re-check every bound socket now (for idle ones); returns how many were closed. */
  sweep(): number;
}

export function createTerminalUserGuard<S>(
  sqlite: Database.Database,
  close: (socket: S) => void,
  options: { recheckMs?: number } = {},
): TerminalUserGuard<S> {
  const recheckMs = options.recheckMs ?? 1_000;
  const bound = new Map<S, { binding: TerminalUserBinding; checkedAt: number }>();

  const revoke = (socket: S) => {
    bound.delete(socket);
    try {
      close(socket);
    } catch {
      /* already closed */
    }
  };

  return {
    track(socket, binding) {
      bound.set(socket, { binding, checkedAt: Date.now() });
    },
    untrack(socket) {
      bound.delete(socket);
    },
    check(socket, now = Date.now()) {
      const entry = bound.get(socket);
      if (!entry) return true;
      if (now - entry.checkedAt < recheckMs) return true;
      if (!terminalBindingValid(sqlite, entry.binding)) {
        revoke(socket);
        return false;
      }
      entry.checkedAt = now;
      return true;
    },
    sweep() {
      let closed = 0;
      const now = Date.now();
      for (const [socket, entry] of [...bound]) {
        if (terminalBindingValid(sqlite, entry.binding)) {
          entry.checkedAt = now;
        } else {
          revoke(socket);
          closed += 1;
        }
      }
      return closed;
    },
  };
}
