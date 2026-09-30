"use client";

import { useEffect, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Milliseconds until the next wall-clock minute begins (at least 1ms). */
export function msUntilNextMinute(now: number): number {
  return Math.max(1, 60_000 - (now % 60_000));
}

/**
 * The menu-bar clock. It ticks on the minute boundary (the old 30s interval
 * from mount could show the wrong minute for up to 30 seconds) and re-syncs
 * when the tab becomes visible again, since timers stall in background tabs.
 */
export function DesktopClock() {
  const [now, setNow] = useState(() => new Date());

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
    schedule();
    document.addEventListener("visibilitychange", resync);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", resync);
    };
  }, []);

  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const full = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" }).format(now);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Focusable, so the full date reaches keyboard users too (the tooltip opens on focus). */}
        <time
          tabIndex={0}
          dateTime={now.toISOString()}
          className="rounded-md px-1 text-xs tabular-nums text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          suppressHydrationWarning
        >
          {time}
        </time>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>{full}</TooltipContent>
    </Tooltip>
  );
}
