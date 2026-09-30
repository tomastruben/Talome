"use client";

import { useEffect, useMemo, useState } from "react";
import {
  SERVICE_DOWN_GRACE_MS,
  advanceServiceWindowGates,
  isServiceUnavailable,
  showsServiceUnavailable,
  type DesktopServiceState,
  type ServiceWindowEntry,
  type ServiceWindowGate,
} from "@/lib/desktop-service-state";

const SEPARATOR = "\u0000";

function entriesKey(entries: readonly ServiceWindowEntry[]): string {
  return entries.map((e) => [e.windowId, e.state ?? "", e.frameLoaded ? "1" : "0"].join(SEPARATOR)).join("\n");
}

function entriesFromKey(key: string): ServiceWindowEntry[] {
  if (!key) return [];
  return key.split("\n").map((line) => {
    const [windowId, state, loaded] = line.split(SEPARATOR);
    return { windowId, state: (state || undefined) as DesktopServiceState | undefined, frameLoaded: loaded === "1" };
  });
}

/**
 * Which desktop windows show Talome's "isn't running" state instead of their
 * page. A page that already loaded is kept through a restart or an update's
 * recreate, and replaced only after the service has been down for
 * SERVICE_DOWN_GRACE_MS; a window opened while its service is down shows the
 * state at once.
 */
export function useServiceWindowGates(
  entries: readonly ServiceWindowEntry[],
  graceMs = SERVICE_DOWN_GRACE_MS,
): (windowId: string) => boolean {
  const key = entriesKey(entries);
  const stable = useMemo(() => entriesFromKey(key), [key]);
  const [gates, setGates] = useState<Record<string, ServiceWindowGate>>({});

  useEffect(() => {
    const advance = () => setGates((previous) => advanceServiceWindowGates(previous, stable, Date.now(), graceMs));
    const first = setTimeout(advance, 0);
    // Re-check while a loaded page waits out the grace period.
    const waiting = stable.some((entry) => entry.frameLoaded && isServiceUnavailable(entry.state));
    const interval = waiting ? setInterval(advance, 1_000) : undefined;
    return () => {
      clearTimeout(first);
      if (interval) clearInterval(interval);
    };
  }, [graceMs, stable]);

  return (windowId: string) => {
    const entry = stable.find((candidate) => candidate.windowId === windowId);
    return entry ? showsServiceUnavailable(entry, gates[windowId]) : false;
  };
}
