"use client";

import { useEffect, useState } from "react";
import { HugeiconsIcon, Moon02Icon, Sun01Icon } from "@/components/icons";
import { PopText } from "@/components/ui/micro";
import { msUntilNextMinute } from "@/components/desktop/desktop-clock";
import { useSystemStats } from "@/hooks/use-system-stats";
import { useUser } from "@/hooks/use-user";
import { Widget, WidgetHeader } from "./widget";

export function greetingFor(hour: number): string {
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** "3d 4h", "5h 12m", "12m": how long the server has been up, at a glance. */
export function formatUptime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${Math.max(minutes, 1)}m`;
}

/**
 * The current time. It ticks on the minute boundary (an interval from mount
 * shows the wrong minute for part of every minute, D-P0-7) and re-syncs when
 * the tab becomes visible again, since timers stall in background tabs.
 */
function useNow(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setNow(new Date());
        schedule();
      }, msUntilNextMinute(Date.now()));
    };
    const resync = () => {
      if (document.visibilityState !== "visible") return;
      setNow(new Date());
      schedule();
    };
    const first = setTimeout(() => setNow(new Date()), 0);
    schedule();
    document.addEventListener("visibilitychange", resync);
    return () => {
      clearTimeout(first);
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", resync);
    };
  }, []);
  return now;
}

/**
 * Built like the stat tiles beside it: a header, the time as the value with
 * its icon, the day underneath, and a footer where the charts sit, here the
 * server's name and how long it has been up.
 */
export function ClockWidget({ compact = false }: { compact?: boolean }) {
  const now = useNow();
  const { user } = useUser();
  const { stats } = useSystemStats();
  const name = user?.username ? user.username.charAt(0).toUpperCase() + user.username.slice(1) : undefined;
  const daytime = now ? now.getHours() >= 6 && now.getHours() < 18 : true;

  return (
    <Widget>
      <WidgetHeader title="Today" />
      <div className="grid gap-1.5 px-4 pt-3 pb-2">
        <div className="flex items-center justify-between">
          {now ? (
            <PopText
              value={now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              className="text-2xl font-medium"
            />
          ) : (
            <span className="h-8" />
          )}
          <div className="rounded-lg bg-muted/35 p-1.5">
            <HugeiconsIcon icon={daytime ? Sun01Icon : Moon02Icon} size={20} className="text-dim-foreground" />
          </div>
        </div>
        <p className="truncate text-xs text-muted-foreground" suppressHydrationWarning>
          {now
            ? compact
              ? now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
              : `${greetingFor(now.getHours())}${name ? `, ${name}` : ""} · ${now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}`
            : " "}
        </p>
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
        {stats ? (
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="size-1.5 shrink-0 rounded-full bg-status-healthy" aria-hidden />
              <span className="truncate">Up {formatUptime(stats.uptime)}</span>
            </span>
            {!compact && <span className="truncate">{stats.hostname}</span>}
          </>
        ) : (
          <span>&nbsp;</span>
        )}
      </div>
    </Widget>
  );
}
