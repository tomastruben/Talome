"use client";

import { memo, useRef, useMemo, useState, useCallback } from "react";
import { toast } from "sonner";
import { CORE_URL } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  HugeiconsIcon,
  Add01Icon,
  AlertCircleIcon,
  Delete02Icon,
  Image01Icon,
  KeyboardIcon,
  ArrowDown01Icon,
  Refresh01Icon,
  SystemUpdate01Icon,
} from "@/components/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TerminalSessionSummary } from "./use-terminal-sessions";
import type { TerminalConnectionStatus } from "./terminal-inner";

function formatRelativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

interface TerminalSessionToolbarProps {
  userSessions: TerminalSessionSummary[];
  systemSessions: TerminalSessionSummary[];
  selectedSessionId?: string;
  selectedSessionName?: string;
  loading?: boolean;
  onSelect: (id: string) => void;
  onCreate: (name?: string) => void | Promise<void>;
  onDelete: (sessionId: string) => void | Promise<void>;
  onRefresh: () => void;
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
  const isActive = session.clients > 0;
  const timeText = isActive ? "active" : formatRelativeTime(session.lastActivityAt);
  return (
    <div
      className={`group flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md transition-colors ${
        isSelected ? "bg-white/5" : "hover:bg-white/5"
      }`}
    >
      <button
        type="button"
        className="flex items-center gap-2 flex-1 min-w-0 text-left"
        onClick={() => onSelect(session.id)}
      >
        <span
          className={`size-1.5 rounded-full shrink-0 ${
            isActive
              ? "bg-[oklch(0.723_0.191_149.58)]"
              : "bg-[oklch(0.269_0_0)]"
          }`}
        />
        <span className={`text-sm truncate ${isSystem ? "text-[#8b949e]" : "text-[#e6edf3]"}`}>
          {session.name}
        </span>
      </button>
      <div className="shrink-0 w-14 relative flex items-center justify-end">
        <span className={`text-xs text-[#8b949e] transition-opacity duration-150 ${isDeletable ? "group-hover:opacity-0" : ""}`}>
          {timeText}
        </span>
        {isDeletable && onDelete && (
          <button
            type="button"
            className="absolute inset-y-0 right-0 flex items-center opacity-0 group-hover:opacity-100 p-0.5 rounded text-[#8b949e]/50 hover:text-status-critical transition-all duration-150"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(session.id);
            }}
          >
            <HugeiconsIcon icon={Delete02Icon} size={12} />
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
              toast.loading("Auto-fixing...", { id: "autofix" });
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
          className={`h-7 gap-1.5 px-2 text-xs transition-colors ${
            state === "building" ? "text-status-warning" :
            state === "success" ? "text-status-healthy" :
            state === "error" ? "text-status-critical" :
            "text-[#8b949e] hover:text-[#e6edf3]"
          } hover:bg-white/10`}
          onClick={handleRebuild}
          disabled={state === "building"}
        >
          <HugeiconsIcon
            icon={SystemUpdate01Icon}
            size={13}
            className={state === "building" ? "animate-spin" : ""}
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
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const allSessions = useMemo(
    () => [...userSessions, ...systemSessions],
    [userSessions, systemSessions],
  );

  const suggestedName = useMemo(() => {
    const taken = new Set(allSessions.map((s) => s.name.toLowerCase()));
    let n = 1;
    while (taken.has(`session-${n}`)) n += 1;
    return `session-${n}`;
  }, [allSessions]);

  // Count other active sessions (not the currently selected one)
  const otherActiveCount = useMemo(
    () => allSessions.filter((s) => s.clients > 0 && s.id !== safeSelected).length,
    [allSessions, safeSelected],
  );

  async function handleCreate() {
    const name = createName.trim() || suggestedName;
    await onCreate(name);
    setCreateName("");
    setCreateMode(false);
    setCreateDialogOpen(false);
    setPopoverOpen(false);
  }

  function requestDelete(id: string, name: string) {
    setDeleteTarget({ id, name });
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    await onDelete(deleteTarget.id);
    setDeleteTarget(null);
    setPopoverOpen(false);
  }

  function handleSelect(id: string) {
    onSelect(id);
    setPopoverOpen(false);
  }

  return (
    <div className={className}>
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-white/10">
        {/* Session selector — opens categorized popover */}
        <Popover
          open={popoverOpen}
          onOpenChange={(open) => {
            setPopoverOpen(open);
            if (!open) setCreateMode(false);
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1.5 h-7 px-2 rounded-md text-sm text-[#e6edf3] hover:bg-white/10 transition-colors min-w-0"
            >
              <span className="truncate">{selectedSessionName ?? "default"}</span>
              {otherActiveCount > 0 && (
                <span className="inline-flex items-center justify-center size-4 rounded-full bg-white/10 text-xs text-[#8b949e] shrink-0">
                  {otherActiveCount}
                </span>
              )}
              <HugeiconsIcon icon={ArrowDown01Icon} size={12} className="text-[#8b949e] shrink-0" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[min(22rem,calc(100vw-2rem))] p-0 border-white/10 bg-[#11161d] text-[#e6edf3]"
          >
            <div className="p-2 space-y-1 max-h-[min(24rem,60svh)] overflow-y-auto">
              {/* User sessions */}
              {userSessions.length > 0 && (
                <div>
                  <p className="px-2.5 pt-1.5 pb-1 text-xs uppercase tracking-wide text-[#8b949e]">
                    Sessions
                  </p>
                  {userSessions.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      isSelected={s.id === safeSelected}
                      isDeletable={s.id !== "sess_default"}
                      onSelect={handleSelect}
                      onDelete={(id) => requestDelete(id, s.name)}
                    />
                  ))}
                </div>
              )}

              {/* System sessions */}
              {systemSessions.length > 0 && (
                <div>
                  <p className="px-2.5 pt-2 pb-1 text-xs uppercase tracking-wide text-[#8b949e]">
                    System
                  </p>
                  {systemSessions.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      isSelected={s.id === safeSelected}
                      isSystem
                      isDeletable
                      onSelect={handleSelect}
                      onDelete={(id) => requestDelete(id, s.name)}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="border-t border-white/10 p-2">
              {createMode ? (
                <div className="space-y-2">
                  <Input
                    autoFocus
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    placeholder={suggestedName}
                    className="h-7 text-xs border-white/15 bg-black/20 text-[#e6edf3] placeholder:text-[#8b949e]/70"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleCreate();
                      }
                      if (e.key === "Escape") {
                        setCreateMode(false);
                        setCreateName("");
                      }
                    }}
                  />
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-[#8b949e] hover:text-[#e6edf3] hover:bg-white/10"
                      onClick={() => {
                        setCreateMode(false);
                        setCreateName("");
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      className="h-6 px-2 text-xs bg-white/10 text-[#e6edf3] hover:bg-white/20"
                      onClick={() => void handleCreate()}
                    >
                      Create
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 flex-1 justify-start gap-1.5 text-xs text-[#8b949e] hover:text-[#e6edf3] hover:bg-white/10"
                    onClick={() => setCreateMode(true)}
                  >
                    <HugeiconsIcon icon={Add01Icon} size={12} />
                    New session
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-[#8b949e] hover:text-[#e6edf3] hover:bg-white/10"
                    onClick={() => {
                      void onRefresh();
                    }}
                    disabled={loading}
                  >
                    <HugeiconsIcon icon={Refresh01Icon} size={12} />
                  </Button>
                </div>
              )}
            </div>
          </PopoverContent>
        </Popover>

        {/* Connection status */}
        {connectionStatus === "reconnecting" && (
          <div className="flex items-center gap-1.5 text-xs text-status-warning">
            <span className="size-1.5 rounded-full bg-status-warning animate-pulse" />
            reconnecting…
          </div>
        )}
        {connectionStatus === "disconnected" && (
          <div className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-status-critical" />
            <span className="text-xs text-status-critical">disconnected</span>
            {onReconnect && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-xs text-status-critical hover:text-status-critical hover:bg-white/10"
                onClick={onReconnect}
              >
                <HugeiconsIcon icon={Refresh01Icon} size={10} className="mr-0.5" />
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
                className={`size-7 hover:bg-white/10 ${keyboardMode === "virtual" ? "text-[#e6edf3]" : "text-[#8b949e]/50"}`}
                onClick={onToggleKeyboard}
              >
                <HugeiconsIcon icon={KeyboardIcon} size={14} />
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
                  className="size-7 text-[#8b949e] hover:text-[#e6edf3] hover:bg-white/10"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <HugeiconsIcon icon={Image01Icon} size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Attach image
              </TooltipContent>
            </Tooltip>
          </>
        )}

        {/* Delete confirmation dialog */}
        <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
          <DialogContent className="max-w-sm" showCloseButton={false}>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <span className="inline-flex size-7 items-center justify-center rounded-md bg-destructive/10 text-destructive">
                  <HugeiconsIcon icon={AlertCircleIcon} size={14} />
                </span>
                <DialogTitle className="text-base">Delete session?</DialogTitle>
              </div>
              <DialogDescription className="pt-1">
                This will terminate <span className="font-medium text-foreground">{deleteTarget?.name}</span> and disconnect any attached clients.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void confirmDelete()}>
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Mobile create dialog */}
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogContent className="max-w-sm" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle className="text-base">New session</DialogTitle>
              <DialogDescription>
                Create a named shell you can switch back to later.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Input
                autoFocus
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder={suggestedName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleCreate();
                  }
                }}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => void handleCreate()}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

export const TerminalSessionToolbar = memo(SessionToolbar);
