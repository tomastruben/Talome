"use client";

import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  HugeiconsIcon,
  Notification01Icon,
  NotificationSnooze01Icon,
} from "@/components/icons";
import { useNotifications } from "@/hooks/use-notifications";
import { NotificationDetailSheet } from "./notification-detail-sheet";
import { NotificationRow } from "./notification-row";
import { cn } from "@/lib/utils";

interface NotificationsBellProps {
  triggerClassName?: string;
  iconSize?: number;
  dotClassName?: string;
  /** Which side of the trigger the panel opens on */
  side?: "top" | "bottom";
}

export function NotificationsBell({
  triggerClassName,
  iconSize = 18,
  dotClassName,
  side = "bottom",
}: NotificationsBellProps = {}) {
  const [open, setOpen] = useState(false);
  const [detailNotification, setDetailNotification] = useState<(typeof notifications)[number] | null>(null);
  const { notifications, unreadCount, hasCritical, isMuted, markRead, markAllRead, dismiss, toggleMute } =
    useNotifications();

  const handleOpen = (val: boolean) => {
    setOpen(val);
  };

  const handleClick = (n: (typeof notifications)[number]) => {
    if (!n.read) markRead(n.id);
    setOpen(false);
    setDetailNotification(n);
  };

  return (
    <>
    <Popover open={open} onOpenChange={handleOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "relative flex items-center justify-center size-8 rounded-md text-muted-foreground hover:text-foreground transition-colors",
            triggerClassName,
          )}
          aria-label={
            isMuted
              ? "Notifications (muted)"
              : unreadCount > 0
                ? `Notifications, ${unreadCount} unread${hasCritical ? ", including critical" : ""}`
                : "Notifications"
          }
        >
          <HugeiconsIcon
            icon={isMuted ? NotificationSnooze01Icon : Notification01Icon}
            size={iconSize}
            strokeWidth={1.5}
            className={cn(isMuted && "opacity-40")}
          />
          {!isMuted && unreadCount > 0 && (
            <span
              className={cn(
                "absolute top-1 right-1 flex size-1.5 items-center justify-center rounded-full",
                hasCritical ? "bg-status-critical" : "bg-status-warning",
                dotClassName,
              )}
            />
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        side={side}
        align="end"
        sideOffset={side === "top" ? 12 : 6}
        className="w-80 p-0 overflow-hidden rounded-xl shadow-lg"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
          <span className="text-sm font-medium">Notifications</span>
          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Mark all read
              </button>
            )}
            <button
              type="button"
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

        {/* List */}
        <div className="max-h-[360px] overflow-y-auto divide-y divide-border/40">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 gap-2">
              <HugeiconsIcon icon={Notification01Icon} size={20} className="text-dim-foreground" />
              <p className="text-xs text-muted-foreground">No notifications</p>
            </div>
          ) : (
            notifications.map((n) => (
                <NotificationRow key={n.id} notification={n} onOpen={() => handleClick(n)} onDismiss={() => dismiss(n.id)} />
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
    </>
  );
}
