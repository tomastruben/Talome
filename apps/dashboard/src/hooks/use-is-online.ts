"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { getHostUrl } from "@/lib/constants";

export type OnlineStatus = "online" | "degraded" | "offline";

export interface HealthState {
  status: OnlineStatus;
  checks: Record<string, "ok" | "error">;
  uptime: number;
  checkedAt: string;
}

const DEFAULT_HEALTH: HealthState = { status: "online", checks: {}, uptime: 0, checkedAt: new Date(0).toISOString() };

// Network-level failures required before declaring full offline mode.
const OFFLINE_THRESHOLD = 5;
// Consecutive degraded signals required before surfacing degraded state.
const DEGRADED_THRESHOLD = 3;
const POLL_ONLINE_MS = 30_000;
const POLL_DEGRADED_MS = 8_000;
const POLL_OFFLINE_MS = 5_000;

export function useIsOnline(): HealthState {
  const [health, setHealth] = useState<HealthState>(DEFAULT_HEALTH);
  const healthRef = useRef<HealthState>(DEFAULT_HEALTH);
  const networkFailuresRef = useRef(0);
  const degradedSignalsRef = useRef(0);

  const setHealthStable = useCallback((next: Omit<HealthState, "checkedAt">) => {
    const withTimestamp: HealthState = { ...next, checkedAt: new Date().toISOString() };
    healthRef.current = withTimestamp;
    setHealth(withTimestamp);
  }, []);

  const setDegradedIfConfirmed = useCallback((next: Omit<HealthState, "checkedAt">) => {
    const wasOnline = healthRef.current.status === "online";
    if (degradedSignalsRef.current >= DEGRADED_THRESHOLD || !wasOnline) {
      setHealthStable(next);
    }
  }, [setHealthStable]);

  const check = useCallback(async () => {
    try {
      const res = await fetch(`${getHostUrl(4000)}/api/health`, {
        signal: AbortSignal.timeout(5000),
        cache: "no-store",
      });

      // 502 (bad gateway) and 503 (service unavailable) both indicate core is unreachable/degraded
      if (res.status === 502 || res.status === 503) {
        networkFailuresRef.current += 1;
        degradedSignalsRef.current += 1;
        if (networkFailuresRef.current >= OFFLINE_THRESHOLD) {
          setHealthStable({ status: "offline", checks: {}, uptime: 0 });
        } else {
          setDegradedIfConfirmed({ status: "degraded", checks: {}, uptime: 0 });
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
          });
        } else {
          degradedSignalsRef.current = 0;
          setHealthStable({
            status: "online",
            checks: data?.checks ?? {},
            uptime: data?.uptime ?? 0,
          });
        }
        return;
      }

      networkFailuresRef.current = 0;
      degradedSignalsRef.current += 1;
      setDegradedIfConfirmed({ status: "degraded", checks: {}, uptime: 0 });
    } catch {
      networkFailuresRef.current += 1;
      degradedSignalsRef.current += 1;
      if (networkFailuresRef.current >= OFFLINE_THRESHOLD) {
        setHealthStable({ status: "offline", checks: {}, uptime: 0 });
      } else {
        setDegradedIfConfirmed({ status: "degraded", checks: {}, uptime: 0 });
      }
    }
  }, [setHealthStable, setDegradedIfConfirmed]);

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
  }, [check]);

  return health;
}
