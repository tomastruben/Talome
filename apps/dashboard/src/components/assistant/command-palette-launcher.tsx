"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useAssistant } from "./assistant-context";
import type { PaletteOpenRequest } from "./command-palette";
import { scheduleIdle } from "@/lib/idle";

/**
 * The command palette pulls in the whole chat renderer (ChatMessage →
 * Streamdown, tool cards, terminal sheet), so it is code-split out of the
 * dashboard shell. This launcher is tiny: it owns the ⌘K / Ctrl+K and "/"
 * shortcuts and the `openPaletteInChatMode` hook until the real palette has
 * loaded, then hands everything over to it. The palette chunk is also
 * preloaded when the browser is idle so the first ⌘K is instant.
 */
const loadCommandPalette = () => import("./command-palette");

const CommandPalette = dynamic(
  () => loadCommandPalette().then((m) => ({ default: m.CommandPalette })),
  { ssr: false },
);

/** Delay before idle-preloading the palette after the shell mounts. */
const PALETTE_IDLE_PRELOAD_MS = 2_500;

function isTypingTarget(target: EventTarget | null): boolean {
  const tag = (target as HTMLElement | null)?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function CommandPaletteLauncher() {
  const { registerOpenPalette } = useAssistant();
  const [ready, setReady] = useState(false);
  const [request, setRequest] = useState<PaletteOpenRequest | null>(null);

  const load = useCallback(() => {
    void loadCommandPalette().then(
      () => setReady(true),
      () => {
        // Chunk failed to load (offline / redeploy): the next shortcut retries.
      },
    );
  }, []);

  // Idle preload so the palette is already mounted by the time it's needed.
  useEffect(() => {
    if (ready) return;
    return scheduleIdle(load, PALETTE_IDLE_PRELOAD_MS);
  }, [ready, load]);

  // Until the palette is mounted, route external "open in chat" calls here.
  // Once mounted, the palette registers its own opener (overriding this one).
  useEffect(() => {
    if (ready) return;
    registerOpenPalette((prefill?: string) => {
      setRequest({ mode: "chat", prefill });
      load();
    });
  }, [ready, registerOpenPalette, load]);

  // Keyboard shortcuts — mirror the palette's own handlers until it mounts.
  useEffect(() => {
    if (ready) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setRequest((prev) => (prev ? null : { mode: "search" }));
        load();
        return;
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !isTypingTarget(e.target)) {
        e.preventDefault();
        setRequest({ mode: "chat" });
        load();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [ready, load]);

  if (!ready) return null;
  return <CommandPalette initialRequest={request} />;
}
