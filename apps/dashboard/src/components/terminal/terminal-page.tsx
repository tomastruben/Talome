"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { terminalCommandAtom, launchTerminalAgentAtom, terminalSessionAtom, terminalFollowUpAtom, terminalAutoAtom, terminalRemoteAtom, terminalRemoteActiveAtom, type TerminalAgent } from "@/atoms/terminal";
import { HugeiconsIcon, ComputerTerminal01Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { CORE_URL } from "@/lib/constants";
import { useKeyboardMode } from "@/hooks/use-keyboard-mode";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";
import { desktopAppActionsAtom, type DesktopAppAction } from "@/atoms/desktop-app-actions";
import type { TerminalInnerHandle, TerminalConnectionStatus } from "./terminal-inner";
import { TerminalSessionToolbar } from "./terminal-session-toolbar";
import { useTerminalSessions } from "./use-terminal-sessions";
import { useTerminalHeaderAction } from "./use-terminal-header-action";

const TerminalInner = dynamic(
  () => import("./terminal-inner").then((m) => ({ default: m.TerminalInner })),
  { ssr: false },
);

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
  const tmuxCmd = opts?.resume
    ? `cd ${quoted} && tmux new-session -A -s talome-claude "claude${flagStr}"`
    : `cd ${quoted} && tmux new-session -s ${sessionName} "claude${flagStr}"`;
  const fallback = `cd ${quoted} && claude${flagStr}`;
  return `${unset} if command -v tmux >/dev/null 2>&1; then ${tmuxCmd}; else ${fallback}; fi`;
}

function buildCodexCommand(projectRoot: string, resume: boolean): string {
  const quoted = projectRoot.includes(" ") ? `"${projectRoot}"` : projectRoot;
  const command = resume ? "codex resume --last" : "codex";
  const sessionName = resume ? "talome-codex" : `talome-codex-${Date.now()}`;
  const tmuxCmd = resume
    ? `cd ${quoted} && tmux new-session -A -s ${sessionName} "${command}"`
    : `cd ${quoted} && tmux new-session -s ${sessionName} "${command}"`;
  const fallback = `cd ${quoted} && ${command}`;
  return `if command -v tmux >/dev/null 2>&1; then ${tmuxCmd}; else ${fallback}; fi`;
}

export function TerminalPage() {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    userSessions,
    systemSessions,
    selectedSessionId,
    selectedSession,
    setSelectedSessionId,
    createNewSession,
    deleteSession,
    refreshSessions,
    loading: sessionsLoading,
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

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (cancelled) return;
        try {
          const [sessionRes, rootRes] = await Promise.all([
            fetch(`${CORE_URL}/api/terminal/session`, { method: "POST" }),
            fetch(`${CORE_URL}/api/terminal/project-root`),
          ]);
          if (!sessionRes.ok) throw new Error(`Status ${sessionRes.status}`);
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
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          } else {
            setError(String(err));
          }
        }
      }
    }

    init();
    return () => { cancelled = true; };
  }, []);

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
    launchClaudeCode(resume);
  }, [launchClaudeCode, projectRoot]);

  const handleCreateSession = useCallback(async (name?: string) => {
    try {
      await createNewSession(name);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [createNewSession]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    if (!sessionId || sessionId === "sess_default") return;
    try {
      await deleteSession(sessionId);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [deleteSession]);

  const handleRefreshSessions = useCallback(async () => {
    try {
      await refreshSessions({ throwOnError: true });
      setError(null);
    } catch (err) {
      setError(String(err));
    }
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
        disabled: terminalHeaderAction.disabled,
        items: [
          ...terminalHeaderAction.agentItems,
          ...terminalHeaderAction.commandItems.map((item, index) => ({
            ...item,
            separatorBefore: index === 0,
          })),
        ],
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
  }

  return (
    <div
      className="absolute inset-0 flex flex-col overflow-hidden"
      style={{ background: "#0d1117" }}
    >
      {error ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-4 px-8">
          <HugeiconsIcon
            icon={ComputerTerminal01Icon}
            size={40}
            className="text-[#8b949e]"
          />
          <div className="text-center">
            <p className="text-[#e6edf3] font-medium mb-1">Connection Failed</p>
            <p className="text-status-critical text-sm">{error}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="border-white/20 text-[#e6edf3] hover:bg-white/10"
            onClick={retry}
          >
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
          <div className="flex items-center gap-2 text-[#8b949e] text-sm">
            <div className="size-3 rounded-full border-2 border-[#8b949e]/40 border-t-[#8b949e] animate-spin" />
            Connecting…
          </div>
        </div>
      )}
    </div>
  );
}
