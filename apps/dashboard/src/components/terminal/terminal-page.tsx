"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { terminalCommandAtom, launchClaudeCodeAtom, terminalSessionAtom, terminalFollowUpAtom, terminalAutoAtom, terminalRemoteAtom, terminalRemoteActiveAtom } from "@/atoms/terminal";
import { HugeiconsIcon, ComputerTerminal01Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { CORE_URL } from "@/lib/constants";
import { useKeyboardMode } from "@/hooks/use-keyboard-mode";
import type { TerminalInnerHandle, TerminalConnectionStatus } from "./terminal-inner";
import { TerminalSessionToolbar } from "./terminal-session-toolbar";
import { useTerminalSessions } from "./use-terminal-sessions";

const TerminalInner = dynamic(
  () => import("./terminal-inner").then((m) => ({ default: m.TerminalInner })),
  { ssr: false },
);

function buildClaudeCodeCommand(projectRoot: string, auto?: boolean, remote?: boolean): string {
  const unset = "unset CLAUDECODE;";
  const flags = [
    "--continue",
    auto ? "--dangerously-skip-permissions" : "",
    remote ? "--remote-control" : "",
  ].filter(Boolean).join(" ");
  const flagStr = flags ? ` ${flags}` : "";
  const tmuxCmd = `cd ${projectRoot} && tmux new-session -A -s talome-claude "claude${flagStr}"`;
  const fallback = `cd ${projectRoot} && claude${flagStr}`;
  return `${unset} if command -v tmux >/dev/null 2>&1; then ${tmuxCmd}; else ${fallback}; fi`;
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
  const setLaunchClaudeCode = useSetAtom(launchClaudeCodeAtom);
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
  const [autoMode] = useAtom(terminalAutoAtom);
  const remote = useAtomValue(terminalRemoteAtom);
  const setRemoteActive = useSetAtom(terminalRemoteActiveAtom);

  useEffect(() => setMounted(true), []);

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

  const launchClaudeCode = useCallback(() => {
    if (!projectRoot) return;
    termRef.current?.sendCommand(buildClaudeCodeCommand(projectRoot, autoMode, remote));
  }, [projectRoot, autoMode, remote]);

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

  // Register the launch callback in the atom so the SiteHeader can access it
  useEffect(() => {
    if (projectRoot && token) {
      setLaunchClaudeCode(() => launchClaudeCode);
    }
    return () => setLaunchClaudeCode(null);
  }, [projectRoot, token, launchClaudeCode, setLaunchClaudeCode]);

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
            onImageUpload={(file) => termRef.current?.uploadImage(file)}
            showKeyboardToggle={keyboard.showToggle}
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
