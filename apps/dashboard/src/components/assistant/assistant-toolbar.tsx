"use client";

import { HugeiconsIcon, Add01Icon, KeyboardIcon } from "@/components/icons";
import { DesktopAppToolbar } from "@/components/desktop/desktop-app-toolbar";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { WINDOW_SIDEBAR_REPLACES } from "@/components/ui/source-list";
import { cn } from "@/lib/utils";

/**
 * Starts a new chat, which is also the way back to the chat list (the home
 * view lists your chats under "How can I help?"). The same control at the
 * trailing end of the classic header and of a narrow window's toolbar row; a
 * window wide enough for the chat sidebar has the sidebar's "New chat" row
 * instead, so each layout has one way home.
 */
export function NewChatButton({ onSelect, className }: { onSelect: () => void; className?: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onSelect}
      className={cn("text-muted-foreground hover:text-foreground pointer-coarse:h-11", className)}
    >
      <HugeiconsIcon icon={Add01Icon} size={14} aria-hidden="true" />
      New chat
    </Button>
  );
}

/**
 * The Assistant's toolbar row in a desktop window. The title bar holds only
 * the window controls, Back (when it returns somewhere else) and the title,
 * so the chat's verb lives here, at the trailing end. The page renders it
 * while a chat is open; it hides exactly when the sidebar shows, whose "New
 * chat" row does the same job (and the home view is already a new chat).
 */
export function AssistantToolbar({ onNew }: { onNew: () => void }) {
  return (
    <DesktopAppToolbar
      data-assistant-toolbar=""
      className={cn("flex shrink-0 items-center justify-end gap-2", WINDOW_SIDEBAR_REPLACES)}
    >
      <NewChatButton onSelect={onNew} />
    </DesktopAppToolbar>
  );
}

/**
 * Turns the on-screen keyboard on or off for the composer (touch screens
 * only, where it can be held back for a hardware keyboard). The same named,
 * pressed-state control as the Terminal's, with the same stored preference,
 * and a 44px target on touch. It always renders, hidden where it doesn't
 * apply, so the Tooltip tree keeps its shape between server and client
 * (Radix ids would shift otherwise).
 */
export function ComposerKeyboardToggle({
  mode,
  shown,
  onToggle,
}: {
  mode: "virtual" | "physical";
  shown: boolean;
  onToggle: () => void;
}) {
  const on = mode === "virtual";
  return (
    <PromptInputButton
      tooltip={on ? "Virtual keyboard on" : "Virtual keyboard off"}
      aria-label="Virtual keyboard"
      aria-pressed={on}
      hidden={!shown}
      onClick={onToggle}
      className={cn(
        "pointer-coarse:size-11",
        on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <HugeiconsIcon icon={KeyboardIcon} size={16} aria-hidden="true" />
    </PromptInputButton>
  );
}
