"use client";

import { useSyncExternalStore } from "react";

const ANY_HOVER_MEDIA_QUERY = "(any-hover: hover)";
const ANY_FINE_POINTER_MEDIA_QUERY = "(any-pointer: fine)";

export interface DesktopModeEnvironment {
  width: number;
  height: number;
  hasHoverCapablePointer: boolean;
  hasFinePointer: boolean;
}

/**
 * Desktop mode needs both enough canvas and a desktop-like pointing device.
 * `any-hover`/`any-pointer` intentionally include secondary inputs, which lets
 * iPadOS opt in when a trackpad, mouse, or hover-capable Apple Pencil is present
 * without exposing the mode on touch-only phones and tablets.
 */
export function canUseDesktopMode({
  width,
  height,
  hasHoverCapablePointer,
  hasFinePointer,
}: DesktopModeEnvironment) {
  const hasDesktopCanvas = width >= 700 && height >= 600;
  const hasDesktopInput = hasHoverCapablePointer || hasFinePointer;
  return hasDesktopCanvas && hasDesktopInput;
}

export function isDesktopModeAvailableNow() {
  if (typeof window === "undefined") return false;
  return canUseDesktopMode({
    width: window.innerWidth,
    height: window.innerHeight,
    hasHoverCapablePointer: window.matchMedia(ANY_HOVER_MEDIA_QUERY).matches,
    hasFinePointer: window.matchMedia(ANY_FINE_POINTER_MEDIA_QUERY).matches,
  });
}

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
  const mediaQueries = [
    ANY_HOVER_MEDIA_QUERY,
    ANY_FINE_POINTER_MEDIA_QUERY,
  ].map((query) => window.matchMedia(query));
  mediaQueries.forEach((mediaQuery) => {
    mediaQuery.addEventListener("change", onStoreChange);
  });
  window.addEventListener("resize", onStoreChange);
  window.visualViewport?.addEventListener("resize", onStoreChange);
  return () => {
    mediaQueries.forEach((mediaQuery) => {
      mediaQuery.removeEventListener("change", onStoreChange);
    });
    window.removeEventListener("resize", onStoreChange);
    window.visualViewport?.removeEventListener("resize", onStoreChange);
  };
}

function getSnapshot() {
  return isDesktopModeAvailableNow();
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
