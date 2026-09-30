"use client";

import { useEffect, useState } from "react";
import { PopText } from "@/components/ui/micro";
import { useUser } from "@/hooks/use-user";
import { cn } from "@/lib/utils";
import { Widget } from "./widget";

export function greetingFor(hour: number): string {
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** The current time, refreshed often enough that the minute never lags. */
function useNow(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 15_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);
  return now;
}

/** A hello, the time and the date. Compact (one column) drops the hello. */
export function ClockWidget({ compact = false }: { compact?: boolean }) {
  const now = useNow();
  const { user } = useUser();
  const name = user?.username ? user.username.charAt(0).toUpperCase() + user.username.slice(1) : undefined;

  return (
    <Widget>
      <div className={cn("flex h-full min-h-28 flex-col justify-center gap-1 px-4 py-3", compact && "items-start")}>
        {now ? (
          <>
            {!compact && (
              <p className="truncate text-sm text-muted-foreground">
                {greetingFor(now.getHours())}{name ? `, ${name}` : ""}
              </p>
            )}
            <PopText
              value={now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              className="text-2xl font-medium tracking-tight"
            />
            <p className="truncate text-sm text-muted-foreground" suppressHydrationWarning>
              {now.toLocaleDateString([], compact
                ? { weekday: "short", month: "short", day: "numeric" }
                : { weekday: "long", month: "long", day: "numeric" })}
            </p>
          </>
        ) : null}
      </div>
    </Widget>
  );
}
