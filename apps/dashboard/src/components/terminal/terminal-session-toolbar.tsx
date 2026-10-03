"use client";

import { memo, useRef, useMemo, useState, useCallback } from "react";
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
} from "@/components/icons";
import { StatusDot } from "@/components/ui/status-dot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { nextSessionName, type TerminalSessionSummary } from "./use-terminal-sessions";
import {
  canEndTerminalSession,
  useEndSessionConfirm,
  type TerminalSessionActionResult,
} from "./terminal-sidebar";
import type { TerminalConnectionStatus } from "./terminal-inner";
import { RenameTerminalSession } from "./terminal-input-tools";

export interface TerminalSessionPickerProps {
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
  onRename?: (name: string) => Promise<void>;
  /** Set while the session list can't be refreshed. */
  refreshError?: string | null;
  /** False while the terminal can't be reached (locked, signed out): no new sessions. */
  canCreate?: boolean;
  className?: string;
}

interface TerminalSessionToolbarProps extends TerminalSessionPickerProps {
  onImageUpload?: (file: File) => void;
  showKeyboardToggle?: boolean;
  keyboardMode?: "virtual" | "physical";
  onToggleKeyboard?: () => void;
  connectionStatus?: TerminalConnectionStatus | null;
  onReconnect?: () => void;
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
        {/* With a pointer the time gives way to End on hover or focus. On touch
            End is always shown, so the time leaves the layout: `hidden`, not
            opacity, which the global touch rule (globals.css) forces back to 1. */}
        <span
          data-session-time=""
          className={cn(
            "text-xs text-muted-foreground transition-opacity duration-150",
            isDeletable && "group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:hidden",
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

/**
 * The session switcher: the current session's name, opening a list of every
 * session with New session and End. Classic mode and narrow windows use it;
 * a window wide enough for the sidebar lists the sessions there instead.
 */
export function TerminalSessionPicker({
  userSessions,
  systemSessions,
  selectedSessionId,
  selectedSessionName,
  loading,
  onSelect,
  onCreate,
  onDelete,
  onRefresh,
  onRename,
  refreshError,
  canCreate = true,
  className,
}: TerminalSessionPickerProps) {
  const safeSelected = selectedSessionId ?? "sess_default";
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [createMode, setCreateMode] = useState(false);
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
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

  const sessionName = selectedSessionName ?? "Default";

  function resetCreate() {
    setCreateMode(false);
    setCreateName("");
    setCreateError(null);
  }

  async function handleCreate() {
    if (creating || !canCreate) return;
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
    <div className={cn("flex min-w-0", className)}>
      <Popover
        open={popoverOpen}
        onOpenChange={(open) => {
          setPopoverOpen(open);
          if (!open) resetCreate();
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            title="Switch session"
            className="h-8 min-w-0 shrink gap-1.5 px-2 font-normal text-foreground pointer-coarse:h-11"
          >
            <span className="truncate">{sessionName}</span>
            {otherActiveCount > 0 && (
              <>
                <span
                  aria-hidden="true"
                  className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-secondary text-xs tabular-nums text-muted-foreground"
                >
                  {otherActiveCount}
                </span>
                <span className="sr-only">
                  , {otherActiveCount} other {otherActiveCount === 1 ? "session" : "sessions"} attached
                </span>
              </>
            )}
            <HugeiconsIcon icon={ArrowDown01Icon} size={12} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          </Button>
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
            {onRename && <RenameTerminalSession key={safeSelected} name={sessionName} onRename={onRename} disabled={!canCreate} labelled className="w-full justify-start" />}
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
                  className="h-8 text-sm pointer-coarse:h-11"
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
                    className="pointer-coarse:h-11 pointer-coarse:px-3"
                    disabled={creating}
                    onClick={resetCreate}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="xs"
                    className="pointer-coarse:h-11 pointer-coarse:px-3"
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
                  className="h-7 flex-1 justify-start gap-1.5 text-xs text-muted-foreground hover:text-foreground pointer-coarse:h-11"
                  disabled={!canCreate}
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
                      className="size-7 text-muted-foreground hover:text-foreground pointer-coarse:size-11"
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
  );
}

/**
 * The connection while it isn't simply up: a breathing info dot while it
 * reconnects (work in flight), a static critical dot once it's gone, with
 * Reconnect. The text gives way before the controls beside it do.
 */
export function TerminalConnectionState({
  status,
  onReconnect,
  className,
}: {
  status?: TerminalConnectionStatus | null;
  onReconnect?: () => void;
  className?: string;
}) {
  if (status === "reconnecting") {
    return (
      <div role="status" className={cn("flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground", className)}>
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-status-info motion-safe:animate-breathe" />
        <span className="truncate">Reconnecting…</span>
      </div>
    );
  }
  if (status === "disconnected") {
    return (
      <div role="status" className={cn("flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground", className)}>
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-status-critical" />
        <span className="truncate">Disconnected</span>
        {onReconnect && (
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 text-foreground/80 hover:text-foreground pointer-coarse:h-11 pointer-coarse:min-w-11"
            onClick={onReconnect}
          >
            <HugeiconsIcon icon={Refresh01Icon} size={12} aria-hidden="true" />
            {/* Icon-only where the row is narrow (a phone); the name stays for screen readers */}
            <span className="sr-only @md:not-sr-only">Reconnect</span>
          </Button>
        )}
      </div>
    );
  }
  return null;
}

/** Virtual keyboard on or off (touch devices only, where the system keyboard can be suppressed). */
export function TerminalKeyboardToggle({
  mode,
  onToggle,
  className,
}: {
  mode?: "virtual" | "physical";
  onToggle: () => void;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Virtual keyboard"
          aria-pressed={mode === "virtual"}
          className={cn(
            "size-8 pointer-coarse:size-11",
            mode === "virtual" ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            className,
          )}
          onClick={onToggle}
        >
          <HugeiconsIcon icon={KeyboardIcon} size={16} aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {mode === "virtual" ? "Virtual keyboard on" : "Virtual keyboard off"}
      </TooltipContent>
    </Tooltip>
  );
}

/** A hidden file input for attaching an image to the terminal, and a way to open it. */
export function useAttachImage(onImageUpload?: (file: File) => void) {
  const inputRef = useRef<HTMLInputElement>(null);
  const open = useCallback(() => inputRef.current?.click(), []);
  const input = onImageUpload ? (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      className="hidden"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) onImageUpload(file);
        e.target.value = "";
      }}
    />
  ) : null;
  return { input, open };
}

export function TerminalAttachImageButton({
  onClick,
  disabled,
  className,
}: {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Attach image"
          disabled={disabled}
          className={cn("size-8 text-muted-foreground hover:text-foreground pointer-coarse:size-11", className)}
          onClick={onClick}
        >
          <HugeiconsIcon icon={Image01Icon} size={16} aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        Attach image
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The session row of the slide-over terminal (terminal-sheet.tsx), on its
 * dark surface: the session picker, the connection state, and the keyboard
 * and image controls. The Terminal page has its own toolbar (terminal-toolbar.tsx).
 */
function SessionToolbar({
  onImageUpload,
  showKeyboardToggle,
  keyboardMode,
  onToggleKeyboard,
  connectionStatus,
  onReconnect,
  className,
  ...picker
}: TerminalSessionToolbarProps) {
  const attach = useAttachImage(onImageUpload);

  return (
    <div className={className}>
      <div className="flex min-w-0 items-center gap-1.5 border-b border-border px-3 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <TerminalSessionPicker {...picker} />
          <TerminalConnectionState status={connectionStatus} onReconnect={onReconnect} />
        </div>
        {showKeyboardToggle && onToggleKeyboard && (
          <TerminalKeyboardToggle mode={keyboardMode} onToggle={onToggleKeyboard} />
        )}
        {attach.input}
        {onImageUpload && <TerminalAttachImageButton onClick={attach.open} />}
      </div>
    </div>
  );
}

export const TerminalSessionToolbar = memo(SessionToolbar);
