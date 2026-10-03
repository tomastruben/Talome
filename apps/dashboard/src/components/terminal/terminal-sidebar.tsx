"use client";

import { useCallback, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  Add01Icon,
  AiMagicIcon,
  Cancel01Icon,
  ComputerTerminal01Icon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { announce } from "@/components/ui/live-announcer";
import {
  SourceList,
  SourceListItem,
  SourceListSection,
  SourceListSkeleton,
} from "@/components/ui/source-list";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu";
import { RenameTerminalSession } from "./terminal-input-tools";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot } from "@/components/ui/status-dot";
import { relativeTime } from "@/lib/format";
import {
  TERMINAL_DEFAULT_SESSION_ID,
  type TerminalSessionSummary,
} from "./use-terminal-sessions";

/** What a session action reports back to the control that asked for it. */
export type TerminalSessionActionResult =
  | { ok: true; name?: string }
  | { ok: false; error: string };

type SessionRef = { id: string; name: string };

/**
 * Which sessions can be ended: every one but Default, yours and the agents'
 * alike. The sidebar and the session picker both ask this, so a window and
 * classic mode always offer the same End actions.
 */
export function canEndTerminalSession(sessionId: string): boolean {
  return sessionId !== TERMINAL_DEFAULT_SESSION_ID;
}

/**
 * The one confirmation for ending a session, shared by the sidebar and the
 * session picker. The dialog runs the delete, shows a failure inline with
 * Retry, and closes only once the session is gone.
 */
export function useEndSessionConfirm(
  onDelete: (sessionId: string) => void | Promise<void | TerminalSessionActionResult>,
) {
  const confirm = useConfirm();
  return useCallback(
    (session: SessionRef) =>
      confirm({
        tier: "destructive",
        title: `End “${session.name}”?`,
        consequence: "Its shell and anything still running in it stop, and attached clients disconnect.",
        recovery: "This can't be undone. Your other sessions keep running.",
        irreversible: true,
        confirmLabel: "End session",
        busyLabel: `Ending ${session.name}…`,
        run: async () => {
          const result = await onDelete(session.id);
          if (result && !result.ok) throw new Error(result.error);
        },
        receipt: `Ended ${session.name}`,
      }),
    [confirm, onDelete],
  );
}

interface TerminalSidebarProps {
  /** User sessions, including the selected one while the daemon hasn't listed it yet. */
  userSessions: TerminalSessionSummary[];
  systemSessions: TerminalSessionSummary[];
  /** The sessions the daemon actually listed (empty while it can't be reached). */
  listedSessions: TerminalSessionSummary[];
  selectedSessionId?: string;
  /** False until the first fetch of the session list settles. */
  loaded: boolean;
  /** Set while the session list can't be fetched. */
  error: string | null;
  /** False without a terminal token, or while the page shows its connection error. */
  canCreate: boolean;
  onSelect: (sessionId: string) => void;
  onCreate: () => Promise<TerminalSessionActionResult>;
  onDelete: (sessionId: string) => Promise<TerminalSessionActionResult>;
  onRetry: () => void;
  onRename: (sessionId: string, name: string) => Promise<void>;
}

function lastActiveTitle(session: TerminalSessionSummary): string {
  const lastActive = `Last active ${relativeTime(new Date(session.lastActivityAt).toISOString())}`;
  return session.recovered ? `${lastActive} · Restored after a restart` : lastActive;
}

function SessionRow({
  session,
  icon,
  active,
  listed,
  onSelect,
  onEnd,
  onRename,
  canRename,
}: {
  session: TerminalSessionSummary;
  icon: IconSvgElement;
  active: boolean;
  /** Whether the daemon listed this session (only then are its times real). */
  listed: boolean;
  onSelect: (sessionId: string) => void;
  onEnd?: (session: SessionRef) => void;
  onRename: (sessionId: string, name: string) => Promise<void>;
  canRename: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "F2" && canRename && listed) {
      event.preventDefault();
      setRenaming(true);
    } else if (onEnd && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      onEnd(session);
    }
  };

  const attachmentTitle = session.clients > 0
    ? `Attached to ${session.clients} browser ${session.clients === 1 ? "client" : "clients"}. This does not indicate a running command.`
    : "No browser client attached. The shell keeps running.";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="group/terminal-session relative">
          <SourceListItem
            className="pr-16 pointer-coarse:pr-16"
            icon={icon}
            label={session.name}
            active={active}
            title={listed ? lastActiveTitle(session) : undefined}
            trailing={
              listed ? (
                <StatusDot state={session.clients > 0 ? "healthy" : "stopped"} size="sm" hideLabel
                  label={session.clients > 0 ? "Attached" : "Detached"} title={attachmentTitle} />
              ) : undefined
            }
            onSelect={() => onSelect(session.id)}
            onKeyDown={handleKeyDown}
            action={
              onEnd
                ? { icon: Cancel01Icon, label: `End ${session.name}`, onSelect: () => onEnd(session) }
                : undefined
            }
          />
          <RenameTerminalSession name={session.name} onRename={(name) => onRename(session.id, name)}
            open={renaming} onOpenChange={setRenaming} accessibleLabel={`Rename ${session.name}`}
            disabled={!canRename || !listed}
            className={`absolute right-8 top-1/2 size-6 -translate-y-1/2 rounded-full p-0 transition-opacity duration-150 ease-out pointer-coarse:opacity-100 group-hover/terminal-session:opacity-100 group-focus-within/terminal-session:opacity-100 ${active ? "opacity-100" : "opacity-0"}`} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="rounded-xl">
        <ContextMenuItem disabled={!canRename || !listed} onSelect={() => setRenaming(true)}>Rename session</ContextMenuItem>
        {onEnd && <ContextMenuItem variant="destructive" onSelect={() => onEnd(session)}>End session…</ContextMenuItem>}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A muted one-line problem with an inline Retry, for the sidebar's narrow column. */
function InlineProblem({
  message,
  title,
  role,
  onRetry,
}: {
  message: string;
  title?: string;
  role: "alert" | "status";
  onRetry: () => void;
}) {
  return (
    <div role={role} className="flex flex-wrap items-center gap-x-1 px-2.5 pt-1 text-xs text-muted-foreground">
      <span title={title}>{message}</span>
      <span aria-hidden="true">·</span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="px-1.5 text-foreground/80 hover:text-foreground pointer-coarse:h-11"
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  );
}

/**
 * The Terminal window's sidebar: a New session row, your sessions (Default
 * first) and the sessions Talome's agents run. It shows only in a desktop
 * window wide enough for it; elsewhere the toolbar's session picker does the
 * same job.
 */
export function TerminalSidebar({
  userSessions,
  systemSessions,
  listedSessions,
  selectedSessionId,
  loaded,
  error,
  canCreate,
  onSelect,
  onCreate,
  onDelete,
  onRetry,
  onRename,
}: TerminalSidebarProps) {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const endSession = useEndSessionConfirm(onDelete);
  const requestEnd = useCallback((session: SessionRef) => {
    void endSession(session);
  }, [endSession]);

  const selected = selectedSessionId ?? TERMINAL_DEFAULT_SESSION_ID;
  const listedIds = useMemo(() => new Set(listedSessions.map((s) => s.id)), [listedSessions]);

  // Default always leads, even before the daemon has started it, so there is
  // always a way back to it.
  const sessionRows = useMemo(() => {
    const listedDefault = userSessions.find((s) => s.id === TERMINAL_DEFAULT_SESSION_ID);
    const defaultSession: TerminalSessionSummary = listedDefault ?? {
      id: TERMINAL_DEFAULT_SESSION_ID,
      name: "Default",
      clients: 0,
      createdAt: 0,
      lastActivityAt: 0,
      uptime: 0,
      category: "user",
    };
    return [defaultSession, ...userSessions.filter((s) => s.id !== TERMINAL_DEFAULT_SESSION_ID)];
  }, [userSessions]);

  const create = useCallback(async () => {
    if (creating || !canCreate) return;
    setCreating(true);
    setCreateError(null);
    const result = await onCreate();
    setCreating(false);
    if (result.ok) {
      announce(`Opened ${result.name ?? "a new session"}`);
    } else {
      setCreateError(result.error);
    }
  }, [canCreate, creating, onCreate]);

  const unreachable = loaded && !!error && listedSessions.length === 0;

  return (
    <SourceList label="Terminal">
      <SourceListSection>
        <SourceListItem
          icon={Add01Icon}
          label="New session"
          disabled={creating || !canCreate}
          trailing={creating ? <Spinner label="Creating a session" className="size-3.5 text-muted-foreground" /> : undefined}
          onSelect={() => void create()}
        />
        {createError && (
          <InlineProblem
            role="alert"
            message="Couldn't create a session"
            title={createError}
            onRetry={() => void create()}
          />
        )}
      </SourceListSection>

      <SourceListSection title="Sessions">
        {!loaded ? (
          // The skeleton is decorative (and waits 200ms); the status says it.
          <div role="status" aria-busy="true">
            <span className="sr-only">Loading sessions…</span>
            <SourceListSkeleton rows={3} />
          </div>
        ) : unreachable ? (
          <InlineProblem role="status" message="Couldn't load sessions." title={error ?? undefined} onRetry={onRetry} />
        ) : (
          <>
            {sessionRows.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                icon={ComputerTerminal01Icon}
                active={session.id === selected}
                listed={listedIds.has(session.id)}
                onSelect={onSelect}
                onRename={onRename}
                canRename={canCreate}
                onEnd={canEndTerminalSession(session.id) ? requestEnd : undefined}
              />
            ))}
            {error && (
              <InlineProblem role="status" message="Couldn't refresh" title={error} onRetry={onRetry} />
            )}
          </>
        )}
      </SourceListSection>

      {loaded && !unreachable && systemSessions.length > 0 && (
        <SourceListSection title="System">
          {/* Agents' sessions can be ended too (a stuck Claude Code, say),
              as in the session picker: same rule, same confirm. */}
          {systemSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              icon={AiMagicIcon}
              active={session.id === selected}
              listed={listedIds.has(session.id)}
              onSelect={onSelect}
              onRename={onRename}
              canRename={canCreate}
              onEnd={canEndTerminalSession(session.id) ? requestEnd : undefined}
            />
          ))}
        </SourceListSection>
      )}
    </SourceList>
  );
}
