"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Width (px) of the backups list at which each row's Back up now, Verify now
 * and Restore fit inline beside the app, its last backup and its
 * verification; below it they move into the row's menu.
 */
export const INLINE_BACKUP_ACTIONS_MIN_WIDTH = 896;

/** Whether an element `width` px wide fits the inline row actions. */
export function fitsInlineBackupActions(width: number): boolean {
  return width >= INLINE_BACKUP_ACTIONS_MIN_WIDTH;
}

/**
 * Whether the element the returned ref is attached to is at least `minWidth`
 * wide, kept current as it resizes. It measures the element itself (in a
 * desktop window, the window's content column; in classic, the page beside
 * the app sidebar), not the screen, because a window's screen is the whole
 * window. False until measured, and where ResizeObserver doesn't exist.
 *
 * For choices CSS container queries can't make, such as what a menu that
 * renders in a portal (outside every container) lists.
 */
export function useMinWidth<T extends HTMLElement>(minWidth: number): [(node: T | null) => void, boolean] {
  const [wide, setWide] = useState(false);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback(
    (node: T | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node || typeof ResizeObserver === "undefined") return;
      // Observing reports the current size at once, then every change.
      const observer = new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setWide(entry.contentRect.width >= minWidth);
      });
      observer.observe(node);
      observerRef.current = observer;
    },
    [minWidth],
  );

  return [ref, wide];
}
