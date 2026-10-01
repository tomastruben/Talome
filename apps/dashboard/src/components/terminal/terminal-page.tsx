"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { terminalCommandAtom, launchTerminalAgentAtom, terminalSessionAtom, terminalFollowUpAtom, terminalAutoAtom, terminalRemoteAtom, terminalRemoteActiveAtom, type TerminalAgent } from "@/atoms/terminal";
import { HugeiconsIcon, ComputerTerminal01Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { WindowSidebarLayout } from "@/components/ui/source-list";
import { CORE_URL } from "@/lib/constants";
import { useKeyboardMode } from "@/hooks/use-keyboard-mode";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";
import { desktopAppActionsAtom, type DesktopAppAction } from "@/atoms/desktop-app-actions";
import type { TerminalInnerHandle, TerminalConnectionStatus } from "./terminal-inner";
import { TerminalSessionToolbar } from "./terminal-session-toolbar";
import { useTerminalSessions } from "./use-terminal-sessions";
import { useTerminalHeaderAction } from "./use-terminal-header-action";
import { TerminalSidebar, type TerminalSessionActionResult } from "./terminal-sidebar";
import { Spinner } from "@/components/ui/spinner";

const TerminalInner = dynamic(
  () => import("./terminal-inner").then((m) => ({ default: m.TerminalInner })),
  { ssr: false },
);

type TmuxAgent = "claude" | "codex" | "kimi";

/**
 * Timestamped AI sessions are intentionally resumable, but each one also keeps
 * the agent and its MCP helper processes alive. Keep the newest previous
 * session for recovery and remove older detached sessions before launching or
 * resuming an agent. This bounds background memory without touching the stable
 * `talome-{agent}` session used by Continue.
 */
export function buildTmuxSessionRetentionCommand(agent: TmuxAgent): string {
  const prefix = `talome-${agent}-`;
  return `tmux list-sessions -F '#{session_name} #{session_activity} #{session_attached}' 2>/dev/null | awk '$3 == 0 && $1 ~ /^${prefix}[0-9]+$/ { print $2, $1 }' | sort -rn | awk 'NR > 1 { print $2 }' | while IFS= read -r stale_session; do [ -n "$stale_session" ] && tmux kill-session -t "$stale_session"; done;`;
}

function buildClaudeCodeCommand(projectRoot: string, opts?: { auto?: boolean; remote?: boolean; resume?: boolean }): string {
  const unset = "unset CLAUDECODE;";
  const flags = [
    opts?.resume ? "--continue" : "",
    opts?.auto ? "--dangerously-skip-permissions" : "",
    opts?.remote ? "--remote-control" : "",
  ].filter(Boolean).join(" ");
  const flagStr = flags ? ` ${flags}` : "";
  const quoted = projectRoot.includes(" ") ? `"${projectRoot}"` : projectRoot;
  const sessionName = opts?.resume ? "talome-claude" : `talome-claude-${Date.now()}`;
  const retainRecentSession = buildTmuxSessionRetentionCommand("claude");
  const tmuxCmd = opts?.resume
    ? `${retainRecentSession} cd ${quoted} && tmux new-session -A -s talome-claude "claude${flagStr}"`
    : `${retainRecentSession} cd ${quoted} && tmux new-session -s ${sessionName} "claude${flagStr}"`;
  const fallback = `cd ${quoted} && claude${flagStr}`;
  return `${unset} if command -v tmux >/dev/null 2>&1; then ${tmuxCmd}; else ${fallback}; fi`;
}

export function buildCodexCommand(projectRoot: string, resume: boolean): string {
  const quoted = projectRoot.includes(" ") ? `"${projectRoot}"` : projectRoot;
  const args = resume ? " resume --last" : "";
  const sessionName = resume ? "talome-codex" : `talome-codex-${Date.now()}`;
  const retainRecentSession = buildTmuxSessionRetentionCommand("codex");
  // Resolve Codex in the interactive shell before entering tmux. A long-lived
  // tmux server can have an older PATH than zsh (notably when Codex comes from
  // the ChatGPT app bundle), so passing the bare `codex` command can exit with
  // "command not found" even though the terminal header correctly detected it.
  const tmuxCommand = `\\"$codex_bin\\"${args}`;
  const tmuxCmd = resume
    ? `${retainRecentSession} cd ${quoted} && tmux new-session -A -s ${sessionName} "${tmuxCommand}"`
    : `${retainRecentSession} cd ${quoted} && tmux new-session -s ${sessionName} "${tmuxCommand}"`;
  const fallback = `cd ${quoted} && "$codex_bin"${args}`;
  const resolveCodex = `codex_bin="$(command -v codex 2>/dev/null)"; if [ -z "$codex_bin" ] && [ -x "/Applications/ChatGPT.app/Contents/Resources/codex" ]; then codex_bin="/Applications/ChatGPT.app/Contents/Resources/codex"; fi`;
  return `${resolveCodex}; if [ -z "$codex_bin" ]; then echo "Codex CLI not found"; elif command -v tmux >/dev/null 2>&1; then ${tmuxCmd}; else ${fallback}; fi`;
}

export function buildKimiCommand(projectRoot: string, resume: boolean, auto = false): string {
  const quoted = projectRoot.includes(" ") ? `"${projectRoot}"` : projectRoot;
  const args = [resume ? "--continue" : "", auto ? "--auto" : ""].filter(Boolean).join(" ");
  const argString = args ? ` ${args}` : "";
  const sessionName = resume ? "talome-kimi" : `talome-kimi-${Date.now()}`;
  const retainRecentSession = buildTmuxSessionRetentionCommand("kimi");
  const tmuxCommand = `\\"$kimi_bin\\"${argString}`;
  const tmuxCmd = resume
    ? `${retainRecentSession} cd ${quoted} && tmux new-session -A -s ${sessionName} "${tmuxCommand}"`
    : `${retainRecentSession} cd ${quoted} && tmux new-session -s ${sessionName} "${tmuxCommand}"`;
  const fallback = `cd ${quoted} && "$kimi_bin"${argString}`;
  const resolveKimi = `kimi_bin="$(command -v kimi 2>/dev/null)"; if [ -z "$kimi_bin" ] && [ -x "$HOME/.kimi-code/bin/kimi" ]; then kimi_bin="$HOME/.kimi-code/bin/kimi"; fi`;
  return `${resolveKimi}; if [ -z "$kimi_bin" ]; then echo "Kimi Code CLI not found. Install it from platform.kimi.ai/docs/guide/kimi-code-cli"; elif command -v tmux >/dev/null 2>&1; then ${tmuxCmd}; else ${fallback}; fi`;
}

/** A terminal-token failure: the server's reason, and whether retrying can help. */
class TerminalTokenError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

const UNREACHABLE_REASON = "Check that the Talome server is reachable, then retry.";

async function tokenFailure(res: Response): Promise<TerminalTokenError> {
  let reason = `The terminal service answered ${res.status}.`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) reason = body.error;
  } catch { /* not JSON */ }
  // A 4xx is a decision (locked mode, signed out), not a hiccup: say it at once.
  return new TerminalTokenError(reason, res.status >= 500);
}

function failureMessage(err: unknown, fallback: string): string {
  if (err instanceof TerminalTokenError) return err.message;
  // fetch() rejects with a TypeError when the server can't be reached.
  if (err instanceof TypeError) return UNREACHABLE_REASON;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function TerminalPage() {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Retry so the token effect runs again.
  const [attempt, setAttempt] = useState(0);
  const [pendingCommand, setPendingCommand] = useAtom(terminalCommandAtom);
  const [pendingSession, setPendingSession] = useAtom(terminalSessionAtom);
  const [followUp, setFollowUp] = useAtom(terminalFollowUpAtom);
  const followUpRef = useRef(followUp);
  followUpRef.current = followUp;
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const termRef = useRef<TerminalInnerHandle>(null);
  const setLaunchTerminalAgent = useSetAtom(launchTerminalAgentAtom);
  const setDesktopAppActions = useSetAtom(desktopAppActionsAtom);
  const embeddedFrame = useIsEmbeddedFrame();
  const {
    sessions,
    userSessions,
    systemSessions,
    selectedSessionId,
    selectedSession,
    setSelectedSessionId,
    createNewSession,
    deleteSession,
    refreshSessions,
    loading: sessionsLoading,
    loaded: sessionsLoaded,
    error: sessionsError,
  } = useTerminalSessions({ enabled: true, persistent: true });
  const keyboard = useKeyboardMode();
  const [connectionStatus, setConnectionStatus] = useState<TerminalConnectionStatus | null>(null);
  const terminalHeaderAction = useTerminalHeaderAction();
  const [autoMode, setAutoMode] = useAtom(terminalAutoAtom);
  const [remote, setRemote] = useAtom(terminalRemoteAtom);
  const remoteActive = useAtomValue(terminalRemoteActiveAtom);
  const setRemoteActive = useSetAtom(terminalRemoteActiveAtom);

  useEffect(() => setMounted(true), []);

  // The embedded desktop app has no SiteHeader, so hydrate the same terminal
  // preferences that the classic terminal header uses.
  useEffect(() => {
    setAutoMode(localStorage.getItem("talome-auto-mode") === "true");
    setRemote(localStorage.getItem("talome-remote-mode") === "true");
  }, [setAutoMode, setRemote]);

  // Clear remote-active when session changes or terminal unmounts
  useEffect(() => {
    setRemoteActive(false);
    return () => setRemoteActive(false);
  }, [selectedSessionId, setRemoteActive]);

  // Switch to a session requested by another page (e.g. creator/evolution).
  // We must switch session before the TerminalInner mounts with the old session
  // key, otherwise the pending command would be sent to the wrong session.
  useEffect(() => {
    if (pendingSession) {
      setSelectedSessionId(pendingSession);
      setPendingSession(null);
    }
  }, [pendingSession, setSelectedSessionId, setPendingSession]);

  // While a session switch is pending, don't pass the command to TerminalInner
  // yet — it would fire on the old session before the key change takes effect.
  const effectiveCommand = pendingSession ? null : pendingCommand;

  useEffect(() => {
    let cancelled = false;

    async function init() {
      const MAX_RETRIES = 3;
      const RETRY_DELAY_MS = 1000;

      for (let tryNumber = 1; tryNumber <= MAX_RETRIES; tryNumber++) {
        if (cancelled) return;
        try {
          const [sessionRes, rootRes] = await Promise.all([
            fetch(`${CORE_URL}/api/terminal/session`, { method: "POST" }),
            fetch(`${CORE_URL}/api/terminal/project-root`),
          ]);
          if (!sessionRes.ok) throw await tokenFailure(sessionRes);
          const { token } = (await sessionRes.json()) as { token: string };
          const { path } = rootRes.ok
            ? ((await rootRes.json()) as { path: string })
            : { path: null };
          if (!cancelled) {
            setToken(token);
            if (path) setProjectRoot(path);
          }
          return; // success
        } catch (err) {
          if (cancelled) return;
          const retryable = !(err instanceof TerminalTokenError) || err.retryable;
          if (retryable && tryNumber < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          } else {
            setError(failureMessage(err, UNREACHABLE_REASON));
            return;
          }
        }
      }
    }

    void init();
    return () => { cancelled = true; };
  }, [attempt]);

  const launchClaudeCode = useCallback((resume = true) => {
    if (!projectRoot) return;
    termRef.current?.sendCommand(buildClaudeCodeCommand(projectRoot, { auto: autoMode, remote, resume }));
  }, [projectRoot, autoMode, remote]);

  const launchTerminalAgent = useCallback((agent: TerminalAgent, resume: boolean) => {
    if (!projectRoot) return;
    if (agent === "codex") {
      termRef.current?.sendCommand(buildCodexCommand(projectRoot, resume));
      return;
    }
    if (agent === "kimi") {
      termRef.current?.sendCommand(buildKimiCommand(projectRoot, resume, autoMode));
      return;
    }
    launchClaudeCode(resume);
  }, [autoMode, launchClaudeCode, projectRoot]);

  // Session actions report their own outcome where they were asked for (the
  // sidebar row, the picker's footer, the confirm dialog). They never replace
  // a working terminal with the connection-error screen.
  const handleCreateSession = useCallback(async (name?: string): Promise<TerminalSessionActionResult> => {
    try {
      const created = await createNewSession(name);
      return { ok: true, name: created?.name };
    } catch (err) {
      return { ok: false, error: failureMessage(err, UNREACHABLE_REASON) };
    }
  }, [createNewSession]);

  const handleDeleteSession = useCallback(async (sessionId: string): Promise<TerminalSessionActionResult> => {
    if (!sessionId || sessionId === "sess_default") {
      return { ok: false, error: "The default session can't be ended." };
    }
    try {
      await deleteSession(sessionId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: failureMessage(err, UNREACHABLE_REASON) };
    }
  }, [deleteSession]);

  // A failed refresh keeps the list and says "Couldn't refresh" (the hook's error).
  const handleRefreshSessions = useCallback(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const handleImageUpload = useCallback((file: File) => {
    termRef.current?.uploadImage(file);
  }, []);

  const handleToggleAutoMode = useCallback(() => {
    const next = !autoMode;
    setAutoMode(next);
    localStorage.setItem("talome-auto-mode", String(next));
  }, [autoMode, setAutoMode]);

  const handleToggleRemote = useCallback(() => {
    const next = !remote;
    setRemote(next);
    localStorage.setItem("talome-remote-mode", String(next));
  }, [remote, setRemote]);

  useEffect(() => {
    if (!embeddedFrame) return;

    const actions: DesktopAppAction[] = [
      {
        id: "terminal-auto",
        label: "Auto",
        kind: "toggle",
        active: autoMode,
        onSelect: handleToggleAutoMode,
      },
      {
        id: "terminal-remote",
        label: remoteActive ? "Remote session active" : "Remote",
        icon: "remote",
        active: remote,
        onSelect: handleToggleRemote,
      },
      {
        id: "terminal-agent",
        label: terminalHeaderAction.label,
        icon: "source-code",
        kind: "menu",
        items: terminalHeaderAction.agentItems,
      },
      {
        id: "terminal-session",
        label: "Session",
        kind: "menu",
        disabled: terminalHeaderAction.disabled,
        items: terminalHeaderAction.commandItems,
      },
    ];

    setDesktopAppActions(actions);
    return () => setDesktopAppActions([]);
  }, [
    embeddedFrame,
    autoMode,
    handleToggleAutoMode,
    handleToggleRemote,
    remote,
    remoteActive,
    setDesktopAppActions,
    terminalHeaderAction.agentItems,
    terminalHeaderAction.commandItems,
    terminalHeaderAction.disabled,
    terminalHeaderAction.label,
  ]);

  // Register one launch callback for both the classic SiteHeader and Desktop titlebar bridge.
  useEffect(() => {
    if (projectRoot && token) {
      setLaunchTerminalAgent(() => launchTerminalAgent);
    }
    return () => setLaunchTerminalAgent(null);
  }, [projectRoot, token, launchTerminalAgent, setLaunchTerminalAgent]);

  function retry() {
    setToken(null);
    setError(null);
    setAttempt((n) => n + 1);
  }

  const sidebar = (
    <TerminalSidebar
      userSessions={userSessions}
      systemSessions={systemSessions}
      listedSessions={sessions}
      selectedSessionId={selectedSessionId}
      loaded={sessionsLoaded}
      error={sessionsError}
      canCreate={!!token && !error}
      onSelect={setSelectedSessionId}
      onCreate={handleCreateSession}
      onDelete={handleDeleteSession}
      onRetry={handleRefreshSessions}
    />
  );

  return (
    <WindowSidebarLayout sidebar={sidebar}>
    <div
      // The terminal stays dark in both themes, so its status and text tokens
      // use the dark values (the light ones are too dark for this surface).
      className="dark absolute inset-0 flex flex-col overflow-hidden bg-terminal text-terminal-foreground"
    >
      {error ? (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <HugeiconsIcon
            icon={ComputerTerminal01Icon}
            size={32}
            strokeWidth={1.5}
            aria-hidden="true"
            className="text-muted-foreground"
          />
          <div className="grid max-w-sm gap-1">
            <p className="text-sm font-medium text-terminal-foreground">Couldn&apos;t connect to the terminal</p>
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
          <Button variant="outline" size="sm" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : token && mounted ? (
        <>
          <TerminalSessionToolbar
            userSessions={userSessions}
            systemSessions={systemSessions}
            selectedSessionId={selectedSessionId}
            selectedSessionName={selectedSession?.name}
            loading={sessionsLoading}
            refreshError={sessionsError}
            onSelect={setSelectedSessionId}
            onCreate={handleCreateSession}
            onDelete={handleDeleteSession}
            onRefresh={handleRefreshSessions}
            onImageUpload={handleImageUpload}
            showKeyboardToggle={!embeddedFrame && keyboard.showToggle}
            keyboardMode={keyboard.mode}
            onToggleKeyboard={keyboard.toggle}
            connectionStatus={connectionStatus}
            onReconnect={() => termRef.current?.retryConnect()}
          />
          <TerminalInner
            key={selectedSessionId ?? "sess_default"}
            ref={termRef}
            token={token}
            initialCommand={effectiveCommand}
            onConnectionStatus={setConnectionStatus}
            onCommandSent={() => {
              setPendingCommand(null);
              // Send a follow-up prompt (e.g. task prompt for Claude Code) after a delay.
              // Use the ref to always read the latest value, avoiding stale closures.
              const text = followUpRef.current;
              if (text) {
                setFollowUp(null);
                setTimeout(() => termRef.current?.sendCommand(text), 1500);
              }
            }}
            sessionId={selectedSessionId}
            sessionName={selectedSession?.name}
            inputMode={keyboard.inputMode}
            onRemoteSession={setRemoteActive}
          />
        </>
      ) : (
        <div className="flex items-center justify-center flex-1">
          <div className="flex items-center gap-2 text-terminal-foreground/70 text-sm">
            <Spinner decorative className="size-3.5" />
            Connecting…
          </div>
        </div>
      )}
    </div>
    </WindowSidebarLayout>
  );
}
