"use client";

import { memo, useRef, useMemo, useState, useCallback } from "react";
import { toast } from "sonner";
import { CORE_URL } from "@/lib/constants";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  HugeiconsIcon,
  Add01Icon,
  Cancel01Icon,
  Image01Icon,
  KeyboardIcon,
  ArrowDown01Icon,
  Refresh01Icon,
  SystemUpdate01Icon,
} from "@/components/icons";
import { StatusDot } from "@/components/ui/status-dot";
import { WINDOW_SIDEBAR_REPLACES, WINDOW_SIDEBAR_SHOWS } from "@/components/ui/source-list";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { nextSessionName, type TerminalSessionSummary } from "./use-terminal-sessions";
import {
  canEndTerminalSession,
  useEndSessionConfirm,
  type TerminalSessionActionResult,
} from "./terminal-sidebar";
import type { TerminalConnectionStatus } from "./terminal-inner";

interface TerminalSessionToolbarProps {
  userSessions: TerminalSessionSummary[];
  systemSessions: TerminalSessionSummary[];
  selectedSessionId?: string;
  selectedSessionName?: string;
  loading?: boolean;
  onSelect: (id: string) => void;
  /** Resolve `{ ok: false, error }` to show the failure in the picker. */
  onCreate: (name?: string) => void | Promise<void | TerminalSessionActionResult>;
  /** Resolve `{ ok: false, error }` (or reject) to keep the confirm open with the reason. */
  onDelete: (sessionId: string) => void | Promise<void | TerminalSessionActionResult>;
  onRefresh: () => void;
  /** Set while the session list can't be refreshed. */
  refreshError?: string | null;
  onImageUpload?: (file: File) => void;
  showKeyboardToggle?: boolean;
  keyboardMode?: "virtual" | "physical";
  onToggleKeyboard?: () => void;
  connectionStatus?: TerminalConnectionStatus | null;
  onReconnect?: () => void;
  className?: string;
}

function SessionRow({
  session,
  isSelected,
  isSystem,
  isDeletable,
  onSelect,
  onDelete,
}: {
  session: TerminalSessionSummary;
  isSelected: boolean;
  isSystem?: boolean;
  isDeletable?: boolean;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  const isAttached = session.clients > 0;
  const timeText = isAttached ? "Attached" : relativeTime(new Date(session.lastActivityAt).toISOString());
  return (
    <div
      className={cn(
        "group flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 transition-colors duration-150 pointer-coarse:min-h-11",
        isSelected ? "bg-muted" : "hover:bg-muted/60",
      )}
    >
      <button
        type="button"
        aria-current={isSelected ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => onSelect(session.id)}
      >
        <StatusDot
          state={isAttached ? "healthy" : "stopped"}
          size="sm"
          hideLabel
          label={isAttached ? "Attached" : "Detached"}
        />
        <span className={cn("truncate text-sm", isSystem ? "text-muted-foreground" : "text-foreground")}>
          {session.name}
        </span>
      </button>
      <div className="relative flex w-16 shrink-0 items-center justify-end">
        <span
          className={cn(
            "text-xs text-muted-foreground transition-opacity duration-150",
            isDeletable && "group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:opacity-0",
          )}
        >
          {timeText}
        </span>
        {isDeletable && onDelete && (
          <button
            type="button"
            aria-label={`End ${session.name}`}
            title={`End ${session.name}`}
            className="absolute inset-y-0 right-0 flex w-6 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none transition-opacity duration-150 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:w-11 pointer-coarse:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(session.id);
            }}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

type RebuildState = "idle" | "building" | "success" | "error";

function RebuildButton() {
  const isDev = process.env.NODE_ENV === "development";
  const [state, setState] = useState<RebuildState>("idle");

  const handleRebuild = useCallback(async () => {
    if (state === "building") return;
    setState("building");

    try {
      const res = await fetch(`${CORE_URL}/api/evolution/rebuild-dashboard`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json() as { ok?: boolean; skipped?: boolean; reason?: string; buildError?: string; duration?: number };

      if (data.skipped) {
        toast("Dev mode — hot reload active", { duration: 2000 });
        setState("idle");
        return;
      }

      if (data.ok) {
        setState("success");
        toast.success(`Rebuilt in ${((data.duration ?? 0) / 1000).toFixed(1)}s — refresh to see changes`);
        setTimeout(() => setState("idle"), 2000);
      } else {
        setState("error");
        const toastId = toast.error("Build failed", {
          description: "Auto-fix with Claude Code?",
          duration: 10000,
          action: {
            label: "Fix",
            onClick: async () => {
              toast.dismiss(toastId);
              toast.loading("Auto-fixing…", { id: "autofix" });
              try {
                const fixRes = await fetch(`${CORE_URL}/api/evolution/rebuild-dashboard/autofix`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  credentials: "include",
                  body: JSON.stringify({ buildError: data.buildError }),
                });
                const fixData = await fixRes.json() as { ok?: boolean; runId?: string };
                if (fixData.ok) {
                  toast.success("Autofix started — check Intelligence page", { id: "autofix" });
                } else {
                  toast.error("Autofix failed to start", { id: "autofix" });
                }
              } catch {
                toast.error("Network error", { id: "autofix" });
              }
            },
          },
        });
        setTimeout(() => setState("idle"), 3000);
      }
    } catch {
      setState("error");
      toast.error("Could not reach server");
      setTimeout(() => setState("idle"), 3000);
    }
  }, [state]);

  if (isDev) return null;

  const label =
    state === "building" ? "Rebuilding…" :
    state === "success" ? "Rebuilt" :
    state === "error" ? "Build failed" :
    "Rebuild";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 gap-1.5 px-2 text-xs transition-colors hover:bg-foreground/10",
            state === "building" ? "text-status-info" :
            state === "success" ? "text-status-healthy" :
            state === "error" ? "text-status-critical" :
            "text-muted-foreground hover:text-foreground",
          )}
          onClick={handleRebuild}
          disabled={state === "building"}
        >
          <HugeiconsIcon
            icon={SystemUpdate01Icon}
            size={13}
            className={state === "building" ? "motion-safe:animate-spin" : ""}
          />
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs max-w-48 text-center">
        Rebuild Talome after code changes
      </TooltipContent>
    </Tooltip>
  );
}

function SessionToolbar({
  userSessions,
  systemSessions,
  selectedSessionId,
  selectedSessionName,
  loading,
  onSelect,
  onCreate,
  onDelete,
  onRefresh,
  refreshError,
  onImageUpload,
  showKeyboardToggle,
  keyboardMode,
  onToggleKeyboard,
  connectionStatus,
  onReconnect,
  className,
}: TerminalSessionToolbarProps) {
  const safeSelected = selectedSessionId ?? "sess_default";
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [createMode, setCreateMode] = useState(false);
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const endSession = useEndSessionConfirm(onDelete);

  const allSessions = useMemo(
    () => [...userSessions, ...systemSessions],
    [userSessions, systemSessions],
  );

  const suggestedName = useMemo(
    () => nextSessionName(allSessions.map((s) => s.id)),
    [allSessions],
  );

  // Count other active sessions (not the currently selected one)
  const otherActiveCount = useMemo(
    () => allSessions.filter((s) => s.clients > 0 && s.id !== safeSelected).length,
    [allSessions, safeSelected],
  );

  function resetCreate() {
    setCreateMode(false);
    setCreateName("");
    setCreateError(null);
  }

  async function handleCreate() {
    if (creating) return;
    const name = createName.trim() || suggestedName;
    setCreating(true);
    setCreateError(null);
    const result = await onCreate(name);
    setCreating(false);
    if (result && !result.ok) {
      // Keep the name and the picker open, and say what failed.
      setCreateError(result.error);
      return;
    }
    resetCreate();
    setPopoverOpen(false);
  }

  function requestDelete(id: string, name: string) {
    setPopoverOpen(false);
    void endSession({ id, name });
  }

  function handleSelect(id: string) {
    onSelect(id);
    setPopoverOpen(false);
  }

  return (
    <div className={className}>
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5">
        {/* Session picker. In a desktop window wide enough for the sidebar,
            the sidebar lists the sessions instead. */}
        <div className={cn("min-w-0", WINDOW_SIDEBAR_REPLACES)}>
        <Popover
          open={popoverOpen}
          onOpenChange={(open) => {
            setPopoverOpen(open);
            if (!open) resetCreate();
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-sm text-foreground outline-none transition-colors duration-150 hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="truncate">{selectedSessionName ?? "Default"}</span>
              {otherActiveCount > 0 && (
                <span
                  className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-xs tabular-nums text-muted-foreground"
                  aria-label={`${otherActiveCount} other ${otherActiveCount === 1 ? "session" : "sessions"} attached`}
                >
                  {otherActiveCount}
                </span>
              )}
              <HugeiconsIcon icon={ArrowDown01Icon} size={12} className="shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[min(22rem,calc(100vw-2rem))] p-0"
          >
            <div className="max-h-[min(24rem,60svh)] space-y-1 overflow-y-auto p-2">
              {/* User sessions */}
              {userSessions.length > 0 && (
                <div>
                  <p className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
                    Sessions
                  </p>
                  {userSessions.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      isSelected={s.id === safeSelected}
                      isDeletable={canEndTerminalSession(s.id)}
                      onSelect={handleSelect}
                      onDelete={(id) => requestDelete(id, s.name)}
                    />
                  ))}
                </div>
              )}

              {/* System sessions */}
              {systemSessions.length > 0 && (
                <div>
                  <p className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                    System
                  </p>
                  {systemSessions.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      isSelected={s.id === safeSelected}
                      isSystem
                      isDeletable={canEndTerminalSession(s.id)}
                      onSelect={handleSelect}
                      onDelete={(id) => requestDelete(id, s.name)}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2 border-t border-border p-2">
              {refreshError && !createMode && (
                <p role="status" className="px-2.5 text-xs text-muted-foreground">
                  Couldn&apos;t refresh the session list. {refreshError}.
                </p>
              )}
              {createMode ? (
                <div className="space-y-2">
                  <Input
                    autoFocus
                    aria-label="Session name"
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    placeholder={suggestedName}
                    disabled={creating}
                    className="h-8 text-sm"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleCreate();
                      }
                      if (e.key === "Escape") {
                        // Leave the form, not the picker.
                        e.preventDefault();
                        resetCreate();
                      }
                    }}
                  />
                  {createError && (
                    <p role="alert" className="px-0.5 text-xs text-muted-foreground">
                      Couldn&apos;t create the session. {createError}
                    </p>
                  )}
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={creating}
                      onClick={resetCreate}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="xs"
                      busy={creating}
                      busyLabel="Creating session…"
                      onClick={() => void handleCreate()}
                    >
                      {createError ? "Retry" : "Create"}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 flex-1 justify-start gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setCreateMode(true)}
                  >
                    <HugeiconsIcon icon={Add01Icon} size={12} aria-hidden="true" />
                    New session
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Refresh sessions"
                        className="size-7 text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          void onRefresh();
                        }}
                        disabled={loading}
                      >
                        <HugeiconsIcon icon={Refresh01Icon} size={12} aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">Refresh sessions</TooltipContent>
                  </Tooltip>
                </div>
              )}
            </div>
          </PopoverContent>
        </Popover>
        </div>
        {/* With the picker in the sidebar, the toolbar still names the session you're typing into. */}
        <span className={cn(WINDOW_SIDEBAR_SHOWS, "h-7 min-w-0 items-center truncate px-2 text-sm text-foreground")}>
          {selectedSessionName ?? "Default"}
        </span>

        {/* Connection status: a breathing info dot while work is in flight, a
            static critical dot once the connection is gone. */}
        {connectionStatus === "reconnecting" && (
          <div role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-status-info motion-safe:animate-breathe" />
            Reconnecting…
          </div>
        )}
        {connectionStatus === "disconnected" && (
          <div role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-status-critical" />
            Disconnected
            {onReconnect && (
              <Button
                variant="ghost"
                size="xs"
                className="text-foreground/80 hover:text-foreground"
                onClick={onReconnect}
              >
                <HugeiconsIcon icon={Refresh01Icon} size={10} aria-hidden="true" />
                Reconnect
              </Button>
            )}
          </div>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right-side actions */}
        <RebuildButton />
        {showKeyboardToggle && onToggleKeyboard && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Virtual keyboard"
                aria-pressed={keyboardMode === "virtual"}
                className={cn(
                  "size-7 hover:bg-foreground/10",
                  keyboardMode === "virtual" ? "text-foreground" : "text-muted-foreground",
                )}
                onClick={onToggleKeyboard}
              >
                <HugeiconsIcon icon={KeyboardIcon} size={14} aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {keyboardMode === "virtual" ? "Virtual keyboard on" : "Virtual keyboard off"}
            </TooltipContent>
          </Tooltip>
        )}
        {onImageUpload && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onImageUpload(file);
                e.target.value = "";
              }}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Attach image"
                  className="size-7 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <HugeiconsIcon icon={Image01Icon} size={14} aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Attach image
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
}

export const TerminalSessionToolbar = memo(SessionToolbar);
