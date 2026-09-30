"use client";

import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon, AlertCircleIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/format";
import { SKELETON_DELAY_MS, SKELETON_MIN_VISIBLE_MS } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * What a loading region shows (spec §4.8):
 * - `"wait"`: nothing yet — the first SKELETON_DELAY_MS of a load, so fast
 *   loads never flash a skeleton;
 * - `"skeleton"`: the load is slow; once shown, the skeleton stays at least
 *   SKELETON_MIN_VISIBLE_MS so it never blinks;
 * - `"ready"`: render the result (data, empty or error).
 */
export type LoadingPhase = "wait" | "skeleton" | "ready";

export function useLoadingPhase(
  loading: boolean,
  { delayMs = SKELETON_DELAY_MS, minVisibleMs = SKELETON_MIN_VISIBLE_MS }: { delayMs?: number; minVisibleMs?: number } = {},
): LoadingPhase {
  // Every state change happens in a timer callback; the phase is derived.
  const [shown, setShown] = useState(false);
  const [minElapsed, setMinElapsed] = useState(true);

  // A slow load: show the skeleton after the delay.
  useEffect(() => {
    if (!loading || shown) return;
    const timer = window.setTimeout(() => {
      setShown(true);
      setMinElapsed(false);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [loading, shown, delayMs]);

  // Once shown, keep it at least minVisibleMs, even if the load finishes sooner.
  useEffect(() => {
    if (!shown || minElapsed) return;
    const timer = window.setTimeout(() => setMinElapsed(true), minVisibleMs);
    return () => window.clearTimeout(timer);
  }, [shown, minElapsed, minVisibleMs]);

  // Done and the minimum has passed: reset for the next load.
  useEffect(() => {
    if (loading || !shown || !minElapsed) return;
    const timer = window.setTimeout(() => setShown(false), 0);
    return () => window.clearTimeout(timer);
  }, [loading, shown, minElapsed]);

  if (loading) return shown ? "skeleton" : "wait";
  return shown && !minElapsed ? "skeleton" : "ready";
}

/**
 * When the data on screen was last loaded successfully (epoch ms), so a
 * failed refresh can say "showing data from 3 min ago". Pass `markLoaded`
 * as (or call it from) the SWR `onSuccess` option.
 */
export function useLoadedAt(): { loadedAt: number | null; markLoaded: () => void } {
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const markLoaded = useCallback(() => setLoadedAt(Date.now()), []);
  return { loadedAt, markLoaded };
}

/** "Couldn't refresh · showing data from 3 min ago" (the sentence, without Retry). */
export function staleMessage(loadedAt: number | null, subject = "data"): string {
  const when = loadedAt ? relativeTime(new Date(loadedAt).toISOString()) : null;
  if (!when) return `Couldn't refresh · showing the last ${subject} Talome loaded`;
  return when === "just now"
    ? `Couldn't refresh · showing ${subject} from just now`
    : `Couldn't refresh · showing ${subject} from ${when}`;
}

/**
 * The inline row above last-known data when a refresh failed (spec §4.8).
 * The data below stays at full contrast; this row says it may be old and
 * offers Retry.
 */
export function StaleRow({
  loadedAt,
  onRetry,
  retrying = false,
  subject,
  className,
}: {
  loadedAt: number | null;
  onRetry: () => void;
  retrying?: boolean;
  /** What is shown: "data" by default, "files", "backups"… */
  subject?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      data-slot="stale-row"
      className={cn("flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground", className)}
    >
      <HugeiconsIcon icon={AlertCircleIcon} size={14} strokeWidth={1.5} className="shrink-0 text-status-critical" aria-hidden="true" />
      <span>{staleMessage(loadedAt, subject)}</span>
      <span aria-hidden="true">·</span>
      <Button variant="ghost" size="xs" onClick={onRetry} busy={retrying} busyLabel="Retrying…">
        Retry
      </Button>
    </div>
  );
}
