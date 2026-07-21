"use client";

import { useSyncExternalStore } from "react";

export const DESKTOP_MODE_MEDIA_QUERY =
  "(min-width: 1024px) and (hover: hover) and (pointer: fine)";

export type DashboardModePreference = "classic" | "desktop";

const DASHBOARD_MODE_STORAGE_PREFIX = "talome:dashboard-mode:v1";

function dashboardModeStorageKey(userId: string) {
  return `${DASHBOARD_MODE_STORAGE_PREFIX}:${userId}`;
}

export function readDashboardModePreference(userId?: string) {
  if (!userId || typeof window === "undefined") return undefined;
  try {
    const value = localStorage.getItem(dashboardModeStorageKey(userId));
    return value === "classic" || value === "desktop" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeDashboardModePreference(
  userId: string | undefined,
  mode: DashboardModePreference,
) {
  if (!userId || typeof window === "undefined") return false;
  try {
    localStorage.setItem(dashboardModeStorageKey(userId), mode);
    return true;
  } catch {
    return false;
  }
}

export async function persistDashboardModePreference(
  userId: string | undefined,
  mode: DashboardModePreference,
) {
  writeDashboardModePreference(userId, mode);
  if (!userId) return false;
  try {
    const response = await fetch("/api/auth/preferences/desktop", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function subscribe(onStoreChange: () => void) {
  const mediaQuery = window.matchMedia(DESKTOP_MODE_MEDIA_QUERY);
  mediaQuery.addEventListener("change", onStoreChange);
  return () => mediaQuery.removeEventListener("change", onStoreChange);
}

function getSnapshot() {
  return window.matchMedia(DESKTOP_MODE_MEDIA_QUERY).matches;
}

function getServerSnapshot() {
  return false;
}

export function useDesktopModeAvailable() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const subscribeToFrameContext = () => () => {};

function getEmbeddedFrameSnapshot() {
  return window.self !== window.top;
}

export function useIsEmbeddedFrame() {
  return useSyncExternalStore(
    subscribeToFrameContext,
    getEmbeddedFrameSnapshot,
    getServerSnapshot,
  );
}
