"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useBugHunt } from "./bug-hunt-context";
import { useBugContext } from "@/hooks/use-bug-context";

/** html-to-image loaded on demand — only needed when user triggers a screenshot */
const loadToPng = () => import("html-to-image").then((m) => m.toPng);

// The overlay pulls in the evolution terminal (xterm) and result views —
// only load it the first time Bug Hunt is opened.
const BugHuntOverlay = dynamic(
  () => import("./bug-hunt-overlay").then((m) => ({ default: m.BugHuntOverlay })),
  { ssr: false },
);

/**
 * Always-mounted, lightweight part of Bug Hunt: installs the console/network
 * error capture as early as before, owns the ⌘⇧X shortcut while the overlay
 * is closed, and mounts the lazily-loaded overlay once it is first opened
 * (it then stays mounted so its close animation and state keep working).
 */
export function BugHuntLauncher() {
  const bugHunt = useBugHunt();
  const { captureContext } = useBugContext();
  const [overlayMounted, setOverlayMounted] = useState(false);

  // Mount the overlay on first open (render-phase state adjustment).
  if (bugHunt.isOpen && !overlayMounted) {
    setOverlayMounted(true);
  }

  const latestRef = useRef({ bugHunt, captureContext });
  useEffect(() => {
    latestRef.current = { bugHunt, captureContext };
  }, [bugHunt, captureContext]);

  useEffect(() => {
    async function handleKeyDown(e: KeyboardEvent) {
      if (!((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "x")) return;
      // While open, the overlay handles the shortcut (re-capture screenshot).
      if (latestRef.current.bugHunt.isOpen) return;
      e.preventDefault();

      // Capture BEFORE opening so overlay isn't in the screenshot
      let screenshotData: string | null = null;
      try {
        const target = document.querySelector("main") as HTMLElement | null ?? document.body;
        const toPngFn = await loadToPng();
        screenshotData = await toPngFn(target, { quality: 0.8, pixelRatio: 1 });
      } catch {
        // Silent fail — screenshot is optional
      }

      const { bugHunt: current, captureContext: capture } = latestRef.current;
      current.open({ screenshot: screenshotData ?? undefined, context: capture() });
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return overlayMounted ? <BugHuntOverlay /> : null;
}
