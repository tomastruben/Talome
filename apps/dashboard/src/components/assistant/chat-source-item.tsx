"use client";

import type { ConversationItem } from "@/components/assistant/assistant-context";
import { HugeiconsIcon } from "@/components/icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SourceListItem, type SourceListItemAction } from "@/components/ui/source-list";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A chat's name as every list shows it. */
export function chatTitle(conversation: Pick<ConversationItem, "title">): string {
  return conversation.title.trim() || "Untitled conversation";
}

const PLATFORM_LABELS: Record<string, string> = {
  telegram: "Telegram",
  discord: "Discord",
};

/**
 * What tells two similar chats apart at a glance: where a bot chat lives
 * ("Telegram"), otherwise when it was last active ("2d ago").
 */
export function chatRowMeta(conversation: Pick<ConversationItem, "platform" | "updatedAt">): string {
  return PLATFORM_LABELS[conversation.platform] ?? relativeTime(conversation.updatedAt);
}

/**
 * The open chat keeps its Delete button on screen. SourceListItem shows a
 * row's action on hover and focus only, so this reaches it from outside:
 * the action is the button after the row's button
 * (`div.group/source-row > button + button`, see source-list.tsx).
 */
export const CHAT_ROW_ACTION_SHOWN = "[&>div>button+button]:opacity-100";

/**
 * A chat in the Assistant's window sidebar (a Finder-style source list).
 *
 * - The full title shows on hover (`title`), since many chats share a long
 *   opening ("Help the user work with the LiteMol…").
 * - A muted time, or the bot platform, tells similar chats apart. It sits
 *   where Delete appears, and steps aside when Delete shows (hover, keyboard
 *   focus); on touch, where Delete is always shown, it stays hidden.
 * - Delete is on the row (on hover and focus, always on the open chat) and in
 *   the row's context menu (right-click, or long-press on touch). It is the
 *   same undoable delete as the classic history list: the caller's `action`.
 *   Deleting the open chat leaves it at once; Undo reopens it (the page's
 *   `requestDelete`).
 */
export function ChatSourceItem({
  conversation,
  active,
  onSelect,
  action,
}: {
  conversation: ConversationItem;
  active: boolean;
  onSelect: () => void;
  /** Delete, run from the row's button and from its context menu */
  action: SourceListItemAction;
}) {
  const title = chatTitle(conversation);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-chat-row=""
          className={cn(
            "min-w-0 rounded-lg data-[state=open]:bg-foreground/5",
            active && CHAT_ROW_ACTION_SHOWN,
          )}
        >
          <SourceListItem
            label={title}
            title={title}
            active={active}
            onSelect={onSelect}
            // The open chat keeps the room SourceListItem leaves for Delete;
            // the others lend it to the time, which Delete replaces on hover
            className={active ? undefined : "pr-2.5"}
            trailing={
              active ? undefined : (
                <span
                  className={cn(
                    "transition-opacity duration-150 ease-out",
                    "group-hover/source-row:opacity-0 group-focus-within/source-row:opacity-0",
                    "pointer-coarse:hidden",
                  )}
                >
                  {/* Read as "title, 2d ago", not run together */}
                  <span className="sr-only">,</span>{" "}
                  {chatRowMeta(conversation)}
                </span>
              )
            }
            action={action}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem variant="destructive" onSelect={action.onSelect}>
          <HugeiconsIcon icon={action.icon} size={14} aria-hidden="true" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
