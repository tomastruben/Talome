"use client";

import { useState, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  HugeiconsIcon,
  Notification01Icon,
  NotificationSnooze01Icon,
  Cancel01Icon,
} from "@/components/icons";
import { useNotifications } from "@/hooks/use-notifications";
import { NotificationDetailSheet } from "./notification-detail-sheet";
import { cn } from "@/lib/utils";

/** Parse **bold** markers into <strong> elements. */
function renderInlineBold(text: string): ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i} className="font-medium text-muted-foreground">{part}</strong> : part,
  );
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const DOT_STYLES = {
  critical: "bg-destructive",
  warning: "bg-status-warning",
  info: "bg-muted-foreground/60",
};

export function SidebarNotifications() {
  const [open, setOpen] = useState(false);
  const [detailNotification, setDetailNotification] = useState<(typeof notifications)[number] | null>(null);
  const { notifications, unreadCount, hasCritical, isMuted, markRead, markAllRead, dismiss, toggleMute } =
    useNotifications();

  const handleClick = (n: (typeof notifications)[number]) => {
    if (!n.read) markRead(n.id);
    setOpen(false);
    setDetailNotification(n);
  };

  const tooltipLabel = isMuted
    ? "Notifications (muted)"
    : unreadCount > 0
      ? `Notifications (${unreadCount})`
      : "Notifications";

  return (
    <SidebarMenuItem>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <SidebarMenuButton tooltip={tooltipLabel} className="text-muted-foreground hover:text-foreground">
            <HugeiconsIcon
              icon={isMuted ? NotificationSnooze01Icon : Notification01Icon}
              size={20}
              className={cn(isMuted && "opacity-40")}
            />
            <span className={cn(isMuted && "opacity-60")}>Notifications</span>
            {!isMuted && unreadCount > 0 && (
              <span
                className={cn(
                  "ml-auto inline-flex size-2 shrink-0 rounded-full",
                  hasCritical ? "bg-destructive" : "bg-status-warning"
                )}
              />
            )}
            {isMuted && (
              <span className="ml-auto text-[10px] text-muted-foreground leading-none">muted</span>
            )}
          </SidebarMenuButton>
        </PopoverTrigger>

        <PopoverContent
          align="start"
          side="top"
          sideOffset={8}
          className="w-80 p-0 overflow-hidden rounded-xl shadow-lg"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
            <span className="text-sm font-medium">Notifications</span>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Mark all read
                </button>
              )}
              <button
                onClick={toggleMute}
                className={cn(
                  "flex items-center justify-center size-6 rounded-md transition-colors",
                  isMuted
                    ? "text-muted-foreground hover:text-foreground bg-muted/50"
                    : "text-dim-foreground hover:text-foreground",
                )}
                aria-label={isMuted ? "Unmute notifications" : "Mute notifications"}
                title={isMuted ? "Unmute" : "Mute"}
              >
                <HugeiconsIcon
                  icon={isMuted ? NotificationSnooze01Icon : Notification01Icon}
                  size={14}
                  className={cn(isMuted && "opacity-50")}
                />
              </button>
            </div>
          </div>

          {/* Muted banner */}
          {isMuted && (
            <div className="px-4 py-2 bg-muted/30 border-b border-border/40">
              <p className="text-xs text-muted-foreground">Notifications are muted</p>
            </div>
          )}

          <div className="max-h-[360px] overflow-y-auto divide-y divide-border/40">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-2">
                <HugeiconsIcon
                  icon={Notification01Icon}
                  size={20}
                  className="text-dim-foreground"
                />
                <p className="text-xs text-muted-foreground">No notifications</p>
              </div>
            ) : (
              notifications.map((n) => (
                  <div
                    key={n.id}
                    role="button"
                    tabIndex={0}
                    className={cn(
                      "group relative flex gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-muted/30",
                      !n.read && "bg-muted/20",
                    )}
                    onClick={() => handleClick(n)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleClick(n);
                      }
                    }}
                  >
                    <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", DOT_STYLES[n.type])} />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-start gap-2">
                        <p
                          className={cn(
                            "flex-1 min-w-0 text-sm leading-snug line-clamp-2",
                            n.read ? "text-muted-foreground" : "font-medium",
                          )}
                        >
                          {n.title}
                        </p>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            dismiss(n.id);
                          }}
                          className="shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted-foreground/50 hover:text-muted-foreground transition-opacity"
                          aria-label="Dismiss"
                        >
                          <HugeiconsIcon icon={Cancel01Icon} size={12} />
                        </button>
                      </div>
                      {n.body && (
                        <p className="text-xs text-muted-foreground/80 mt-0.5 line-clamp-1">
                          {renderInlineBold(n.body)}
                        </p>
                      )}
                      <p
                        className="mt-1.5 text-xs text-muted-foreground/50 tabular-nums leading-none"
                        suppressHydrationWarning
                      >
                        {timeAgo(n.createdAt)}
                      </p>
                    </div>
                  </div>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>

      <NotificationDetailSheet
        open={!!detailNotification}
        onOpenChange={(v) => { if (!v) setDetailNotification(null); }}
        notification={detailNotification}
      />
    </SidebarMenuItem>
  );
}
