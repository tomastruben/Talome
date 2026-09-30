"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

const CHANGE = "talome:launchpad-visibility";
const subscribe = (notify: () => void) => {
  window.addEventListener("storage", notify); window.addEventListener(CHANGE, notify);
  return () => { window.removeEventListener("storage", notify); window.removeEventListener(CHANGE, notify); };
};

/** Personal presentation only; hiding an icon never stops or changes a service. */
export function useLaunchpadVisibility(userId?: string) {
  const key = `talome:launchpad-hidden:v1:${userId ?? "local"}`;
  const read = useCallback(() => { try { return localStorage.getItem(key) ?? "[]"; } catch { return "[]"; } }, [key]);
  const value = useSyncExternalStore(subscribe, read, () => "[]");
  const hidden = useMemo(() => {
    try { const parsed: unknown = JSON.parse(value); return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []); }
    catch { return new Set<string>(); }
  }, [value]);
  const save = useCallback((ids: Set<string>) => {
    try { localStorage.setItem(key, JSON.stringify([...ids])); window.dispatchEvent(new Event(CHANGE)); return true; }
    catch { return false; }
  }, [key]);
  return { hidden, toggle: (id: string) => { const next = new Set(hidden); if (next.has(id)) next.delete(id); else next.add(id); return save(next); }, reset: () => save(new Set()) };
}
