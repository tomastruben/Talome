"use client";

import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  HugeiconsIcon,
  Notification01Icon,
  NotificationSnooze01Icon,
} from "@/components/icons";
import { useNotifications } from "@/hooks/use-notifications";
import { NotificationDetailSheet } from "./notification-detail-sheet";
import { NotificationRow } from "./notification-row";
import { cn } from "@/lib/utils";

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
                  hasCritical ? "bg-status-critical" : "bg-status-warning"
                )}
              />
            )}
            {isMuted && (
              <span className="ml-auto text-xs text-muted-foreground leading-none">Muted</span>
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
    </SidebarMenuItem>
  );
}
