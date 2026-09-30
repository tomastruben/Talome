"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { getDirectCoreUrl } from "@/lib/constants";
import { parseDegradedBody } from "@/lib/health";

export type OnlineStatus = "online" | "degraded" | "offline";

export interface HealthState {
  status: OnlineStatus;
  checks: Record<string, "ok" | "error">;
  uptime: number;
  checkedAt: string;
  /** When the current non-online status began (ISO), null while online. */
  since: string | null;
  /**
   * False when the last check never reached core (the request failed, or a
   * proxy answered 502 or a bare 503). While "degraded" is only a count of
   * network failures below the offline threshold, the server can't be asked
   * anything, so nothing that runs on it (the Assistant) may be offered.
   */
  reachable: boolean;
}

export interface UseIsOnlineResult extends HealthState {
  /** Check again now (Retry), instead of waiting for the next poll. */
  recheck: () => void;
}

const DEFAULT_HEALTH: HealthState = { status: "online", checks: {}, uptime: 0, checkedAt: new Date(0).toISOString(), since: null, reachable: true };

export { failingChecksLabel, parseDegradedBody } from "@/lib/health";

// Network-level failures required before declaring full offline mode.
const OFFLINE_THRESHOLD = 5;
// Consecutive degraded signals required before surfacing degraded state.
const DEGRADED_THRESHOLD = 3;
const POLL_ONLINE_MS = 30_000;
const POLL_DEGRADED_MS = 8_000;
const POLL_OFFLINE_MS = 5_000;

export function useIsOnline(): UseIsOnlineResult {
  const [health, setHealth] = useState<HealthState>(DEFAULT_HEALTH);
  const healthRef = useRef<HealthState>(DEFAULT_HEALTH);
  const networkFailuresRef = useRef(0);
  const degradedSignalsRef = useRef(0);

  const setHealthStable = useCallback((next: Omit<HealthState, "checkedAt" | "since">) => {
    const now = new Date().toISOString();
    const previous = healthRef.current;
    const since = next.status === "online"
      ? null
      : previous.status === "online" || !previous.since ? now : previous.since;
    const withTimestamp: HealthState = { ...next, checkedAt: now, since };
    healthRef.current = withTimestamp;
    setHealth(withTimestamp);
  }, []);

  const setDegradedIfConfirmed = useCallback((next: Omit<HealthState, "checkedAt" | "since">) => {
    const wasOnline = healthRef.current.status === "online";
    if (degradedSignalsRef.current >= DEGRADED_THRESHOLD || !wasOnline) {
      setHealthStable(next);
    }
  }, [setHealthStable]);

  const check = useCallback(async () => {
    try {
      const res = await fetch(`${getDirectCoreUrl()}/api/health`, {
        signal: AbortSignal.timeout(5000),
        cache: "no-store",
      });

      if (res.status === 503) {
        const degraded = parseDegradedBody(await res.json().catch(() => null));
        if (degraded) {
          networkFailuresRef.current = 0;
          degradedSignalsRef.current += 1;
          setDegradedIfConfirmed({ status: "degraded", ...degraded, reachable: true });
          return;
        }
      }

      // 502 (bad gateway) and a bare 503 mean core itself is unreachable
      if (res.status === 502 || res.status === 503) {
        networkFailuresRef.current += 1;
        degradedSignalsRef.current += 1;
        if (networkFailuresRef.current >= OFFLINE_THRESHOLD) {
          setHealthStable({ status: "offline", checks: {}, uptime: 0, reachable: false });
        } else {
          setDegradedIfConfirmed({ status: "degraded", checks: {}, uptime: 0, reachable: false });
        }
        return;
      }

      if (res.ok) {
        networkFailuresRef.current = 0;
        const data = await res.json().catch(() => null);

        const status: OnlineStatus =
          !res.ok ? "degraded"
          : data?.status === "degraded" ? "degraded"
          : "online";

        if (status === "degraded") {
          degradedSignalsRef.current += 1;
          setDegradedIfConfirmed({
            status: "degraded",
            checks: data?.checks ?? {},
            uptime: data?.uptime ?? 0,
            reachable: true,
          });
        } else {
          degradedSignalsRef.current = 0;
          setHealthStable({
            status: "online",
            checks: data?.checks ?? {},
            uptime: data?.uptime ?? 0,
            reachable: true,
          });
        }
        return;
      }

      networkFailuresRef.current = 0;
      degradedSignalsRef.current += 1;
      setDegradedIfConfirmed({ status: "degraded", checks: {}, uptime: 0, reachable: true });
    } catch {
      networkFailuresRef.current += 1;
      degradedSignalsRef.current += 1;
      if (networkFailuresRef.current >= OFFLINE_THRESHOLD) {
        setHealthStable({ status: "offline", checks: {}, uptime: 0, reachable: false });
      } else {
        setDegradedIfConfirmed({ status: "degraded", checks: {}, uptime: 0, reachable: false });
      }
    }
  }, [setHealthStable, setDegradedIfConfirmed]);

  const [recheckToken, setRecheckToken] = useState(0);
  const recheck = useCallback(() => setRecheckToken((n) => n + 1), []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const run = async () => {
      await check();
      if (stopped) return;
      const currentStatus = healthRef.current.status;
      const nextDelay =
        currentStatus === "offline" ? POLL_OFFLINE_MS
        : currentStatus === "degraded" ? POLL_DEGRADED_MS
        : POLL_ONLINE_MS;
      timer = setTimeout(run, nextDelay);
    };

    timer = setTimeout(run, 0);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [check, recheckToken]);

  return { ...health, recheck };
}
