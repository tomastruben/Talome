"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useSetAtom } from "jotai";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type { TerminalInnerHandle, TerminalConnectionStatus } from "@/components/terminal/terminal-inner";

const TerminalInner = dynamic(
  () => import("./terminal-inner").then((m) => ({ default: m.TerminalInner })),
  { ssr: false },
);
import { CORE_URL } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import {
  HugeiconsIcon,
  MinimizeScreenIcon,
  CheckmarkCircle01Icon,
  ComputerTerminal01Icon,
  Image01Icon,
  KeyboardIcon,
  Refresh01Icon,
  SourceCodeCircleIcon,
} from "@/components/icons";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { terminalSessionAtom } from "@/atoms/terminal";
import { useKeyboardMode } from "@/hooks/use-keyboard-mode";

export interface CompleteResponse {
  ok: boolean;
  typeErrors?: string;
}

interface ClaudeTerminalProps {
  sessionName: string;
  /** Shell command to start Claude Code. Omit for reattach (session already running). */
  command?: string;
  taskPrompt: string;
  /** Session title shown in the terminal header. */
  title?: string;
  completeLabel?: string;
  /**
   * Called when "Complete" is clicked. Should call the server to typecheck + commit.
   * If it returns `{ ok: false, typeErrors }`, the terminal stays open and the
   * errors are sent to Claude Code for fixing. Return `{ ok: true }` to dismiss.
   */
  onComplete: () => Promise<CompleteResponse>;
  onCancel: () => void;
  completing?: boolean;
}

export function ClaudeTerminal({
  sessionName,
  command,
  taskPrompt,
  title,
  completeLabel = "Complete & Verify",
  onComplete,
  onCancel,
  completing = false,
}: ClaudeTerminalProps) {
  const reattach = !command;
  const [token, setToken] = useState<string | null>(null);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [commandSent, setCommandSent] = useState(reattach);
  const [injectionAttempted, setInjectionAttempted] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<TerminalConnectionStatus>("connected");
  const termRef = useRef<TerminalInnerHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const setTerminalSession = useSetAtom(terminalSessionAtom);
  const router = useRouter();
  const keyboard = useKeyboardMode();

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
          if (sessionRes.ok) {
            const data = (await sessionRes.json()) as { token?: string };
            if (data.token && !cancelled) {
              setToken(data.token);
            }
          }
          if (rootRes.ok) {
            const data = (await rootRes.json()) as { path?: string };
            if (data.path && !cancelled) setProjectRoot(data.path);
          }
          return; // success
        } catch {
          if (cancelled) return;
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          }
          // Final attempt failure: silent (same as current behavior)
        }
      }
    }

    void init();
    return () => { cancelled = true; };
  }, []);

  // When command is set, the prompt is baked into the CLI argument —
  // no separate idle-gap injection needed. Mark injection as done immediately.
  const promptBakedInCommand = !!command;

  const handleCommandSent = useCallback(() => {
    setCommandSent(true);
    if (promptBakedInCommand) {
      setInjectionAttempted(true);
    }
  }, [promptBakedInCommand]);

  const handlePromptInjected = useCallback(() => {
    setInjectionAttempted(true);
  }, []);


  const handleConnectionStatus = useCallback((status: TerminalConnectionStatus) => {
    setConnectionStatus(status);
  }, []);

  const handleReconnect = useCallback(() => {
    termRef.current?.retryConnect();
  }, []);

  const handleOpenInTerminal = useCallback(() => {
    setTerminalSession(sessionName);
    router.push("/dashboard/terminal");
  }, [sessionName, setTerminalSession, router]);

  const handleLaunchClaudeCode = useCallback(() => {
    if (!projectRoot) return;
    const unset = "unset CLAUDECODE;";
    const quoted = projectRoot.includes(" ") ? `"${projectRoot}"` : projectRoot;
    const tmuxCmd = `cd ${quoted} && tmux new-session -A -s talome-claude "claude --continue"`;
    const fallback = `cd ${quoted} && claude --continue`;
    const cmd = `${unset} if command -v tmux >/dev/null 2>&1; then ${tmuxCmd}; else ${fallback}; fi`;
    termRef.current?.sendCommand(cmd);
  }, [projectRoot]);

  // Complete: server typechecks → commits if clean. If type errors, send them
  // to Claude Code so it can fix, then user retries.
  const handleCompleteClick = useCallback(async () => {
    let result: CompleteResponse;
    try {
      result = await onComplete();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Complete action failed";
      result = { ok: false, typeErrors: msg };
    }
    if (!result) {
      result = { ok: false, typeErrors: "Complete action returned no result" };
    }
    if (!result.ok && result.typeErrors) {
      termRef.current?.sendCommand(
        `TypeScript errors found. Please fix them:\n\n${result.typeErrors}`
      );
    }
  }, [onComplete]);

  if (!token) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        <Spinner className="mr-2" /> Connecting to terminal...
      </div>
    );
  }

  const statusText = connectionStatus === "disconnected"
    ? "Disconnected"
    : connectionStatus === "reconnecting"
      ? "Reconnecting..."
      : completing
        ? "Verifying..."
        : reattach
          ? "Attached"
          : injectionAttempted
            ? "Working..."
            : commandSent
              ? "Starting..."
              : "Connecting...";

  const statusDotClass = connectionStatus === "disconnected"
    ? "bg-status-critical"
    : connectionStatus === "reconnecting"
      ? "bg-status-warning animate-pulse"
      : "bg-status-healthy animate-pulse";

  return (
    <div className="flex flex-col h-full">
      {/* Window header */}
      <div className="flex items-center justify-between px-3 sm:px-4 py-2 sm:py-2.5 border-b border-white/[0.06] bg-[#161b22]">
        {/* Left: status + title */}
        <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-3">
          <div className={`w-2 h-2 rounded-full shrink-0 ${statusDotClass}`} />
          <div className="min-w-0 flex-1">
            {title ? (
              <p className="text-sm font-medium text-foreground truncate leading-tight">{title}</p>
            ) : (
              <p className="text-sm text-muted-foreground leading-tight">{statusText}</p>
            )}
            {title && (
              <p className="text-xs text-muted-foreground leading-tight mt-0.5">{statusText}</p>
            )}
          </div>
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-0.5 shrink-0">
          {connectionStatus === "disconnected" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-status-warning hover:text-foreground"
                  onClick={handleReconnect}
                  aria-label="Reconnect"
                >
                  <HugeiconsIcon icon={Refresh01Icon} size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Reconnect</TooltipContent>
            </Tooltip>
          )}
          {projectRoot && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground hidden sm:inline-flex"
                  onClick={handleLaunchClaudeCode}
                  aria-label="Launch Claude Code"
                >
                  <HugeiconsIcon icon={SourceCodeCircleIcon} size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Claude Code</TooltipContent>
            </Tooltip>
          )}
          {keyboard.showToggle && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-7 w-7 ${keyboard.mode === "virtual" ? "text-foreground" : "text-muted-foreground"} hover:text-foreground`}
                  onClick={keyboard.toggle}
                  aria-label={keyboard.mode === "virtual" ? "Virtual keyboard on" : "Virtual keyboard off"}
                >
                  <HugeiconsIcon icon={KeyboardIcon} size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {keyboard.mode === "virtual" ? "Virtual keyboard" : "Physical keyboard"}
              </TooltipContent>
            </Tooltip>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) termRef.current?.uploadImage(file);
              e.target.value = "";
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach image"
              >
                <HugeiconsIcon icon={Image01Icon} size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">Attach image</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={handleOpenInTerminal}
                aria-label="Open in full terminal"
              >
                <HugeiconsIcon icon={ComputerTerminal01Icon} size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">Full terminal</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={onCancel}
                disabled={completing}
                aria-label="Minimize"
              >
                <HugeiconsIcon icon={MinimizeScreenIcon} size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">Minimize</TooltipContent>
          </Tooltip>
          <Button
            size="sm"
            className="h-7 text-xs gap-1.5 ml-1.5"
            onClick={handleCompleteClick}
            disabled={completing}
          >
            {completing ? (
              <Spinner className="h-3 w-3" />
            ) : (
              <HugeiconsIcon icon={CheckmarkCircle01Icon} size={13} />
            )}
            <span className="hidden sm:inline">
              {completing ? "Verifying..." : completeLabel}
            </span>
          </Button>
        </div>
      </div>
      <TerminalInner
        ref={termRef}
        token={token}
        sessionId={sessionName}
        sessionName={sessionName}
        initialCommand={command}
        taskPrompt={promptBakedInCommand ? undefined : taskPrompt}
        onCommandSent={handleCommandSent}
        onPromptInjected={handlePromptInjected}
        onConnectionStatus={handleConnectionStatus}
        inputMode={keyboard.inputMode}
      />
    </div>
  );
}
