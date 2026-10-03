"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CORE_URL, getTerminalDaemonHttpUrl } from "@/lib/constants";
import { useVisibleInterval } from "@/lib/polling";

export type SessionCategory = "user" | "system";

export interface TerminalSessionSummary {
  id: string;
  name: string;
  /** AI-generated concise label for system sessions (e.g. "Docker Config Fix") */
  displayName?: string;
  clients: number;
  createdAt: number;
  lastActivityAt: number;
  uptime: number;
  category: SessionCategory;
  /** True if session was recovered from persistence after a daemon restart. */
  recovered?: boolean;
}

interface TerminalSessionsResponse {
  sessions: Omit<TerminalSessionSummary, "category">[];
}

interface CreateSessionResponse {
  sessionId: string;
  name: string;
  exists: boolean;
  displayName?: string;
}

const SESSION_STORAGE_KEY = "talome_terminal_session";
const DEFAULT_SESSION_ID = "sess_default";

function formatShortDateTime(ms: number): string {
  const d = new Date(ms);
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "pm" : "am";
  const hour = h % 12 || 12;
  return `${month} ${day}, ${hour}:${m}${ampm}`;
}

export const TERMINAL_DEFAULT_SESSION_ID = DEFAULT_SESSION_ID;

/** Shown while the session list can't be fetched from core or the daemon. */
export const TERMINAL_SESSIONS_UNREACHABLE = "The terminal service isn't responding";

function deriveSessionName(id: string, displayName?: string): string {
  if (displayName) return displayName;
  if (id === DEFAULT_SESSION_ID) return "Default";
  if (id === "sess_talome-claude") return "Claude Code";

  // Evolution sessions: show "Evolution · Mar 14, 2:30pm" instead of raw ID
  const evMatch = id.match(/^sess_evolution-ev_(\d+)/);
  if (evMatch) {
    return `Evolution · ${formatShortDateTime(Number(evMatch[1]))}`;
  }

  // Creator sessions: show "App: some-app" instead of raw ID
  const creatorMatch = id.match(/^sess_creator-(.+)/);
  if (creatorMatch) {
    return `App: ${creatorMatch[1].replace(/-/g, " ")}`;
  }

  // Setup sessions: show "Setup: configure" instead of raw ID
  const setupMatch = id.match(/^sess_setup-(.+)/);
  if (setupMatch) {
    return `Setup: ${setupMatch[1].replace(/-/g, " ")}`;
  }

  return id.replace(/^sess_/, "").replace(/-/g, " ");
}

/** System sessions are spawned by Evolution, Creator, or Claude Code. */
function classifySession(id: string): SessionCategory {
  if (
    id.startsWith("sess_evolution-") ||
    id.startsWith("sess_creator-") ||
    id.startsWith("sess_setup-") ||
    id === "sess_talome-claude"
  ) {
    return "system";
  }
  return "user";
}

function withCategory(
  s: Omit<TerminalSessionSummary, "category">,
): TerminalSessionSummary {
  return {
    ...s,
    name: deriveSessionName(s.id, s.displayName),
    category: classifySession(s.id),
  };
}

/**
 * The next free "session-N". Compared against session ids, not display names:
 * names are derived ("session 2"), so comparing names never found a clash and
 * every new session reopened session-1.
 */
export function nextSessionName(existingIds: string[]): string {
  let n = 1;
  const taken = new Set(existingIds.map((id) => id.replace(/^sess_/, "").toLowerCase()));
  while (taken.has(`session-${n}`)) n += 1;
  return `session-${n}`;
}

/** The server's `{ error }` text when it sent one, otherwise the fallback. */
async function responseError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) return body.error;
  } catch { /* not JSON */ }
  return fallback;
}

export function useTerminalSessions({
  enabled = true,
  persistent = true,
}: {
  enabled?: boolean;
  persistent?: boolean;
}) {
  const [sessions, setSessions] = useState<TerminalSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  /** Flips once, when the first refresh settles (success or failure). */
  const [loaded, setLoaded] = useState(false);
  /** Set while the list can't be fetched; cleared by the next success. */
  const [error, setError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(undefined);
  const initialSelectionDone = useRef(false);

  // Start on default — the first fetch may auto-switch to an active session.
  // The terminalSessionAtom override (from Evolution/Creator) is handled in terminal-page.tsx
  // before this value is read.
  useEffect(() => {
    if (!persistent) {
      setSelectedSessionId(undefined);
      return;
    }
    initialSelectionDone.current = false;
    const stored = localStorage.getItem(SESSION_STORAGE_KEY);
    setSelectedSessionId(stored || DEFAULT_SESSION_ID);
  }, [persistent]);

  // Persist manual switches to localStorage (for within-session memory only —
  // the mount always resets to default).
  useEffect(() => {
    if (!persistent || !selectedSessionId) return;
    localStorage.setItem(SESSION_STORAGE_KEY, selectedSessionId);
  }, [persistent, selectedSessionId]);

  const refreshSessions = useCallback(async ({ throwOnError = false }: { throwOnError?: boolean } = {}) => {
    if (!enabled || !persistent) return;
    setLoading(true);
    try {
      let data: TerminalSessionsResponse | null = null;

      // Primary path: fetch from core API
      try {
        const res = await fetch(`${CORE_URL}/api/terminal/sessions`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        data = (await res.json()) as TerminalSessionsResponse;
      } catch {
        // Core is down — try daemon directly
        try {
          const directRes = await fetch(`${getTerminalDaemonHttpUrl()}/sessions`);
          if (directRes.ok) {
            data = (await directRes.json()) as TerminalSessionsResponse;
          }
        } catch { /* daemon also down */ }
      }

      if (!data) {
        // Both core and daemon unreachable — try to spawn daemon via core
        try {
          await fetch(`${CORE_URL}/api/terminal/ensure-daemon`, { method: "POST" });
          // Retry daemon after spawn
          const retryRes = await fetch(`${getTerminalDaemonHttpUrl()}/sessions`);
          if (retryRes.ok) {
            data = (await retryRes.json()) as TerminalSessionsResponse;
          }
        } catch { /* all recovery failed */ }
      }

      if (!data) {
        setError(TERMINAL_SESSIONS_UNREACHABLE);
        if (throwOnError) throw new Error(TERMINAL_SESSIONS_UNREACHABLE);
        return;
      }

      const active = (data.sessions ?? []).map(withCategory);
      setError(null);
      // The daemon's session list is the source of truth. Replace the local
      // list entirely so dead sessions (idle timeout, process exit) are removed.
      setSessions(active);

      // On the first fetch, if a session is currently active (has connected
      // clients), prefer it over the default. This way, if evolution is running,
      // the user sees it. If nothing is running, they get a clean default.
      if (!initialSelectionDone.current) {
        initialSelectionDone.current = true;

        // Clean up stale localStorage — if stored session doesn't exist on
        // daemon, reset to default to avoid phantom session UI.
        const stored = localStorage.getItem(SESSION_STORAGE_KEY);
        if (stored && stored !== DEFAULT_SESSION_ID && !active.some((s) => s.id === stored)) {
          setSelectedSessionId(DEFAULT_SESSION_ID);
          localStorage.removeItem(SESSION_STORAGE_KEY);
        }

        const activeSession = active.find((s) => s.clients > 0 && s.id !== DEFAULT_SESSION_ID);
        if (activeSession) {
          setSelectedSessionId(activeSession.id);
        }
      }
    } catch (err) {
      if (throwOnError) throw err;
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [enabled, persistent]);

  useEffect(() => {
    if (!enabled || !persistent) return;
    void refreshSessions();
  }, [enabled, persistent, refreshSessions]);
  // Refresh the session list every 15s while visible (paused when hidden).
  const pollSessions = useCallback(() => { void refreshSessions(); }, [refreshSessions]);
  useVisibleInterval(pollSessions, enabled && persistent ? 15_000 : null);

  const selectedSession = useMemo(() => {
    if (!selectedSessionId) return undefined;
    const existing = sessions.find((s) => s.id === selectedSessionId);
    if (existing) return existing;
    return {
      id: selectedSessionId,
      name: deriveSessionName(selectedSessionId),
      clients: 0,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      uptime: 0,
      category: classifySession(selectedSessionId),
    } satisfies TerminalSessionSummary;
  }, [selectedSessionId, sessions]);

  const sessionOptions = useMemo(() => {
    if (!selectedSession) return sessions;
    if (sessions.some((s) => s.id === selectedSession.id)) return sessions;
    return [selectedSession, ...sessions];
  }, [selectedSession, sessions]);

  const userSessions = useMemo(
    () => sessionOptions.filter((s) => s.category === "user"),
    [sessionOptions],
  );

  const systemSessions = useMemo(
    () => sessionOptions.filter((s) => s.category === "system"),
    [sessionOptions],
  );

  const createNewSession = useCallback(async (preferredName?: string): Promise<{ id: string; name: string } | undefined> => {
    if (!persistent) return undefined;
    const fallbackName = nextSessionName(sessions.map((s) => s.id));
    const name = preferredName?.trim() || fallbackName;
    const res = await fetch(`${CORE_URL}/api/terminal/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      throw new Error(await responseError(res, `The terminal service answered ${res.status}.`));
    }
    const data = (await res.json()) as CreateSessionResponse;
    const now = Date.now();
    setSessions((prev) => {
      if (prev.some((s) => s.id === data.sessionId)) return prev;
      return [
        withCategory({
          id: data.sessionId,
          name: data.name,
          clients: 0,
          createdAt: now,
          lastActivityAt: now,
          uptime: 0,
        }),
        ...prev,
      ];
    });
    setSelectedSessionId(data.sessionId);
    // The session exists now; a failed refresh shows as the list's own error
    // ("Couldn't refresh"), not as a failed create.
    await refreshSessions();
    return { id: data.sessionId, name: deriveSessionName(data.sessionId, data.displayName) };
  }, [persistent, sessions, refreshSessions]);

  const deleteSession = useCallback(async (sessionId: string) => {
    if (!persistent) return;
    const res = await fetch(`${CORE_URL}/api/terminal/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(await responseError(res, `The terminal service answered ${res.status}.`));
    }
    if (selectedSessionId === sessionId) {
      setSelectedSessionId(DEFAULT_SESSION_ID);
    }
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    // Ended is ended; a failed refresh shows as the list's own error.
    await refreshSessions();
  }, [persistent, selectedSessionId, refreshSessions]);

  const renameSession = useCallback(async (sessionId: string, name: string) => {
    const displayName = name.trim();
    if (!displayName || displayName.length > 80) throw new Error("Use a name between 1 and 80 characters.");
    const res = await fetch(`${CORE_URL}/api/terminal/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName }),
    });
    if (!res.ok) throw new Error(await responseError(res, "Couldn't rename the session. Try again."));
    setSessions((prev) => prev.map((session) => session.id === sessionId ? { ...session, name: displayName, displayName } : session));
  }, []);

  return {
    sessions,
    sessionOptions,
    userSessions,
    systemSessions,
    selectedSession,
    selectedSessionId,
    setSelectedSessionId,
    refreshSessions,
    createNewSession,
    deleteSession,
    renameSession,
    loading,
    loaded,
    error,
    persistent,
  };
}
