"use client";

import type { ReactNode } from "react";
import { HugeiconsIcon, Cancel01Icon } from "@/components/icons";
import type { AppNotification } from "@/hooks/use-notifications";
import { cn } from "@/lib/utils";

/** Parse **bold** markers into <strong> elements. */
export function renderInlineBold(text: string): ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i} className="font-medium text-foreground">{part}</strong> : part,
  );
}

export function notificationTimeAgo(dateStr: string, now = Date.now()): string {
  const then = new Date(dateStr).getTime();
  if (!Number.isFinite(then)) return "Never";
  const m = Math.floor((now - then) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export const NOTIFICATION_DOT_CLASS: Record<AppNotification["type"], string> = {
  critical: "bg-status-critical",
  warning: "bg-status-warning",
  info: "bg-muted-foreground/60",
};

const SEVERITY_PREFIX: Record<AppNotification["type"], string> = {
  critical: "Critical: ",
  warning: "Warning: ",
  info: "",
};

/**
 * One notification in the bell and sidebar lists: a button for the row's
 * content and a sibling Dismiss button (never an interactive element nested
 * inside another). Dismiss is revealed on hover and focus, always shown on
 * touch.
 */
export function NotificationRow({
  notification: n,
  onOpen,
  onDismiss,
}: {
  notification: Pick<AppNotification, "id" | "type" | "title" | "body" | "read" | "createdAt">;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex transition-colors duration-150 hover:bg-muted/30",
        !n.read && "bg-muted/20",
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 gap-3 py-3 pl-4 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onOpen}
      >
        <span aria-hidden="true" className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", NOTIFICATION_DOT_CLASS[n.type])} />
        <span className="block min-w-0 flex-1">
          <span className={cn("block text-sm leading-snug line-clamp-2", n.read ? "text-muted-foreground" : "font-medium")}>
            <span className="sr-only">{SEVERITY_PREFIX[n.type]}</span>
            {n.title}
          </span>
          {n.body && (
            <span className="mt-0.5 block text-xs text-muted-foreground line-clamp-1">{renderInlineBold(n.body)}</span>
          )}
          <span className="mt-1.5 block text-xs text-muted-foreground tabular-nums leading-none" suppressHydrationWarning>
            {notificationTimeAgo(n.createdAt)}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="mr-2 mt-2.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity duration-150 outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 pointer-coarse:size-11 pointer-coarse:mt-0 pointer-coarse:opacity-100"
        aria-label={`Dismiss ${n.title}`}
      >
        <HugeiconsIcon icon={Cancel01Icon} size={12} />
      </button>
    </div>
  );
}
