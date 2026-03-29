"use client";

import dynamic from "next/dynamic";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon, ComputerTerminal01Icon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { CORE_URL } from "@/lib/constants";
import { useKeyboardMode } from "@/hooks/use-keyboard-mode";
import { TerminalSessionToolbar } from "./terminal-session-toolbar";
import { useTerminalSessions } from "./use-terminal-sessions";

const TerminalInner = dynamic(
  () => import("./terminal-inner").then((m) => ({ default: m.TerminalInner })),
  { ssr: false },
);

interface TerminalSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialCommand?: string | null;
}

export function TerminalSheet({ open, onOpenChange, initialCommand }: TerminalSheetProps) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const persistentMode = !initialCommand;
  const keyboard = useKeyboardMode();
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
  } = useTerminalSessions({
    enabled: open,
    persistent: persistentMode,
  });

  // Close on Escape only when the terminal itself doesn't have focus.
  // xterm handles its own Escape key, so we must not steal it.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = document.activeElement;
      if (active && (active.closest(".terminal-host") || active.closest(".xterm"))) return;
      onOpenChange(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) {
      // Don't clear token on close — the persistent session stays alive on the server.
      // We only clear on explicit retry (error state).
      setError(null);
      return;
    }

    // Only fetch a new auth token if we don't have one yet
    if (token) return;

    let cancelled = false;

    async function fetchSession() {
      const MAX_RETRIES = 3;
      const RETRY_DELAY_MS = 1000;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (cancelled) return;
        try {
          const res = await fetch(`${CORE_URL}/api/terminal/session`, { method: "POST" });
          if (!res.ok) throw new Error(`Status ${res.status}`);
          const { token: t } = await res.json() as { token: string };
          if (!cancelled) setToken(t);
          return; // success
        } catch (err) {
          if (cancelled) return;
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          } else {
            if (!cancelled) setError(String(err));
          }
        }
      }
    }

    fetchSession();
    return () => { cancelled = true; };
  }, [open, token]);

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

  return (
    <>
      {/* Backdrop — click to close but doesn't block assistant dock (z-40) */}
      {open && (
        <div
          className="fixed inset-0 z-[45] bg-black/30 transition-opacity"
          onClick={() => onOpenChange(false)}
        />
      )}

      {/* Panel — slides in from right, sits below assistant dock z-level so both are usable */}
      <div
        className={cn(
          "fixed inset-y-0 right-0 z-[46] w-[720px] max-w-full flex flex-col border-l shadow-lg transition-transform duration-300 ease-in-out",
          open ? "translate-x-0" : "translate-x-full pointer-events-none"
        )}
        style={{ background: "#0d1117" }}
      >
        <div className="px-4 py-3 border-b border-white/10 flex-shrink-0 flex flex-row items-center justify-between">
          <div className="flex items-center gap-2 text-[#e6edf3] text-sm font-medium">
            <HugeiconsIcon icon={ComputerTerminal01Icon} size={16} className="text-[#8b949e]" />
            Terminal
            {initialCommand && (
              <span className="text-[10px] text-[#8b949e]/60 font-normal ml-1">Claude Code</span>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-[#8b949e] hover:text-[#e6edf3] hover:bg-white/10 h-7 text-xs"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
        </div>

        {persistentMode && (
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
            showKeyboardToggle={keyboard.showToggle}
            keyboardMode={keyboard.mode}
            onToggleKeyboard={keyboard.toggle}
          />
        )}

        <div className="flex-1 overflow-hidden">
          {!open ? null : error ? (
            <div className="flex flex-col items-center justify-center h-full gap-4 px-8">
              <HugeiconsIcon icon={ComputerTerminal01Icon} size={40} className="text-[#8b949e]" />
              <div className="text-center">
                <p className="text-[#e6edf3] font-medium mb-1">Connection Failed</p>
                <p className="text-red-400 text-sm">{error}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="border-white/20 text-[#e6edf3] hover:bg-white/10"
                onClick={() => { setError(null); setToken(null); }}
              >
                Retry
              </Button>
            </div>
          ) : token ? (
            <TerminalInner
              key={persistentMode ? selectedSessionId ?? "sess_default" : "ephemeral"}
              token={token}
              initialCommand={initialCommand}
              sessionId={persistentMode ? selectedSessionId : undefined}
              sessionName={persistentMode ? selectedSession?.name : undefined}
              inputMode={keyboard.inputMode}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="flex items-center gap-2 text-[#8b949e] text-sm">
                <div className="size-3 rounded-full border-2 border-[#8b949e]/40 border-t-[#8b949e] animate-spin" />
                Connecting…
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
