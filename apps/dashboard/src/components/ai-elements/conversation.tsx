"use client";

import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HugeiconsIcon, ArrowDown01Icon, Download01Icon } from "@/components/icons";
import { createContext, useCallback, useContext } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

/**
 * Lets content inside a conversation release the stick-to-bottom lock before
 * it grows on purpose (a tool result's "Show all"), so the view stays where
 * the person was reading instead of jumping to the new bottom. Null outside a
 * conversation.
 */
const ConversationScrollLockContext = createContext<(() => void) | null>(null);

export function useConversationScrollLock(): (() => void) | null {
  return useContext(ConversationScrollLockContext);
}

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, children, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("group/conversation relative flex-1 overflow-y-hidden", className)}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  >
    {(context) => (
      // stopScroll is a stable callback, so consumers don't re-render on scroll
      <ConversationScrollLockContext.Provider value={context.stopScroll}>
        {typeof children === "function" ? children(context) : children}
      </ConversationScrollLockContext.Provider>
    )}
  </StickToBottom>
);

export type ConversationContentProps = ComponentProps<
  typeof StickToBottom.Content
>;

export const ConversationContent = ({
  className,
  ...props
}: ConversationContentProps) => (
  <StickToBottom.Content
    className={cn("flex flex-col gap-6 p-4", className)}
    {...props}
  />
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

/**
 * Shown while you're scrolled up. It sits in the bottom 2.25rem of the
 * conversation, a band the page's scroller mask keeps clear while the button
 * is there (`data-conversation-scroll-button`, read by `bottomFade` in
 * app/dashboard/assistant/page.tsx), so it never covers text you can read.
 * On touch the target grows to 44px around it.
 *
 * It floats over the conversation, so it stays opaque at rest and on hover:
 * in a window --muted and --accent are see-through fills for the glass, so
 * the dark hover is the opaque popover surface (light's outline hover is
 * already opaque), and data-floating keeps any card fill inside it opaque.
 */
export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "absolute bottom-1 left-1/2 -translate-x-1/2 rounded-full dark:bg-background dark:hover:bg-surface-popover animate-in fade-in-0 duration-150 ease-enter pointer-coarse:after:absolute pointer-coarse:after:-inset-1.5",
          className
        )}
        onClick={handleScrollToBottom}
        size="icon-sm"
        type="button"
        variant="outline"
        aria-label="Scroll to bottom"
        data-conversation-scroll-button=""
        data-floating=""
        {...props}
      >
        <HugeiconsIcon icon={ArrowDown01Icon} size={16} />
      </Button>
    )
  );
};

export interface ConversationMessage {
  role: "user" | "assistant" | "system" | "data" | "tool";
  content: string;
}

export type ConversationDownloadProps = Omit<
  ComponentProps<typeof Button>,
  "onClick"
> & {
  messages: ConversationMessage[];
  filename?: string;
  formatMessage?: (message: ConversationMessage, index: number) => string;
};

const defaultFormatMessage = (message: ConversationMessage): string => {
  const roleLabel =
    message.role.charAt(0).toUpperCase() + message.role.slice(1);
  return `**${roleLabel}:** ${message.content}`;
};

export const messagesToMarkdown = (
  messages: ConversationMessage[],
  formatMessage: (
    message: ConversationMessage,
    index: number
  ) => string = defaultFormatMessage
): string => messages.map((msg, i) => formatMessage(msg, i)).join("\n\n");

export const ConversationDownload = ({
  messages,
  filename = "conversation.md",
  formatMessage = defaultFormatMessage,
  className,
  children,
  ...props
}: ConversationDownloadProps) => {
  const handleDownload = useCallback(() => {
    const markdown = messagesToMarkdown(messages, formatMessage);
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [messages, filename, formatMessage]);

  // Floats over the conversation: opaque at rest and on hover (see ConversationScrollButton)
  return (
    <Button
      className={cn(
        "absolute top-4 right-4 rounded-full dark:bg-background dark:hover:bg-surface-popover",
        className
      )}
      data-floating=""
      onClick={handleDownload}
      size="icon"
      type="button"
      variant="outline"
      aria-label="Download conversation"
      {...props}
    >
      {children ?? <HugeiconsIcon icon={Download01Icon} size={16} />}
    </Button>
  );
};
