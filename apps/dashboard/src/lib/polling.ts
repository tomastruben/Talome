"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Shared polling cadences for the dashboard.
 *
 * Rule of thumb: poll fast only while something is visibly in progress
 * (install, optimization job, download, action); otherwise fall back to a
 * slow cadence. SWR already pauses `refreshInterval` polling while the tab is
 * hidden (refreshWhenHidden defaults to false); `useVisibleInterval` gives
 * plain setInterval loops the same behaviour.
 */
export const POLL_FAST_MS = 3_000;
export const POLL_ACTIVE_MS = 5_000;
export const POLL_IDLE_MS = 30_000;
export const POLL_SLOW_MS = 60_000;

export interface AdaptiveIntervalOptions {
  /** Interval while active (default POLL_FAST_MS). */
  fast?: number;
  /** Interval while idle (default POLL_IDLE_MS). */
  slow?: number;
}

/** Pure helper: fast interval while `active`, slow otherwise. */
export function pickPollInterval(active: boolean, options: AdaptiveIntervalOptions = {}): number {
  const fast = options.fast ?? POLL_FAST_MS;
  const slow = options.slow ?? POLL_IDLE_MS;
  return active ? fast : slow;
}

/** Job statuses that mean "something is still happening". */
const IN_PROGRESS_JOB_STATUSES = new Set(["running", "queued", "pending", "processing"]);

/** True when any job in the list is still running/queued. */
export function hasInProgressJobs(
  jobs: ReadonlyArray<{ status?: string | null } | null | undefined> | null | undefined,
): boolean {
  if (!Array.isArray(jobs)) return false;
  return jobs.some((j) => !!j && typeof j.status === "string" && IN_PROGRESS_JOB_STATUSES.has(j.status));
}

/**
 * SWR `refreshInterval` function for `{ jobs: [...] }` optimization job
 * payloads: fast while any job is running/queued, slow otherwise.
 */
export function optimizationJobsRefreshInterval(
  data: { jobs?: ReadonlyArray<{ status?: string | null }> | null } | null | undefined,
  options: AdaptiveIntervalOptions = {},
): number {
  return pickPollInterval(hasInProgressJobs(data?.jobs), options);
}

/** Installed-app statuses that mean an install/update is still in flight. */
const TRANSITIONAL_INSTALL_STATUSES = new Set(["installing", "updating"]);

/** True when any app (catalog entry with `installed`) is installing/updating. */
export function hasTransitionalInstall(
  apps: ReadonlyArray<{ installed?: { status?: string | null } | null } | null | undefined> | null | undefined,
): boolean {
  if (!Array.isArray(apps)) return false;
  return apps.some((a) => {
    const status = a?.installed?.status;
    return typeof status === "string" && TRANSITIONAL_INSTALL_STATUSES.has(status);
  });
}

/** True when a single installed-app status is transitional. */
export function isTransitionalInstallStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && TRANSITIONAL_INSTALL_STATUSES.has(status);
}

export interface UseAdaptiveIntervalOptions extends AdaptiveIntervalOptions {
  /**
   * Keep polling fast for this long after `active` turns false, so the UI
   * catches the settled state of a just-finished action (default 0).
   */
  graceMs?: number;
}

/**
 * React hook variant of `pickPollInterval` with an optional grace window:
 * returns `fast` while `active` and for `graceMs` after it turns false.
 */
export function useAdaptiveInterval(active: boolean, options: UseAdaptiveIntervalOptions = {}): number {
  const { fast = POLL_FAST_MS, slow = POLL_IDLE_MS, graceMs = 0 } = options;
  const [prevActive, setPrevActive] = useState(active);
  const [inGrace, setInGrace] = useState(false);

  // Derive grace state from the active → inactive transition during render
  // (React's "adjusting state when a prop changes" pattern).
  if (active !== prevActive) {
    setPrevActive(active);
    setInGrace(!active && graceMs > 0);
  }

  useEffect(() => {
    if (!inGrace) return;
    const timer = setTimeout(() => setInGrace(false), graceMs);
    return () => clearTimeout(timer);
  }, [inGrace, graceMs]);

  return active || inGrace ? fast : slow;
}

/** True when the document is visible (always true outside the browser). */
export function isDocumentVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

export interface UseVisibleIntervalOptions {
  /** Run the callback once immediately when the effect starts (default false). */
  immediate?: boolean;
}

/**
 * `setInterval` that only ticks while the tab is visible and is always
 * cleared on unmount / delay change. When the tab becomes visible again and
 * at least one interval has elapsed since the last run, the callback fires
 * once right away so the UI catches up.
 *
 * Pass `null` (or a non-positive delay) to stop polling.
 */
export function useVisibleInterval(
  callback: () => void,
  delayMs: number | null,
  options: UseVisibleIntervalOptions = {},
): void {
  const { immediate = false } = options;
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delayMs === null || delayMs <= 0) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    let lastRun = Date.now();

    const run = () => {
      lastRun = Date.now();
      callbackRef.current();
    };

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => {
        if (isDocumentVisible()) run();
      }, delayMs);
    };

    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibilityChange = () => {
      if (isDocumentVisible()) {
        if (Date.now() - lastRun >= delayMs) run();
        start();
      } else {
        stop();
      }
    };

    if (immediate) run();
    if (isDocumentVisible()) start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [delayMs, immediate]);
}
