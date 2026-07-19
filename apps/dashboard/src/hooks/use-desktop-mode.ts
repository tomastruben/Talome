"use client";

import { useSyncExternalStore } from "react";

export const DESKTOP_MODE_MEDIA_QUERY =
  "(min-width: 1024px) and (hover: hover) and (pointer: fine)";

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
