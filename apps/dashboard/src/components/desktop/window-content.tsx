"use client";

import type { ComponentProps } from "react";
import { createPortal } from "react-dom";
import { useAtomValue, useSetAtom } from "jotai";
import { windowStatusBarSlotAtom, windowToolbarSlotAtom } from "@/atoms/window-sidebar";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";
import { cn } from "@/lib/utils";

/**
 * The window shell's content column (dashboard-shell.tsx, embedded branch):
 *
 *   [sidebar panel][.tm-window-content > unified toolbar, scroller, status-bar slot]
 *
 * The unified toolbar (window-toolbar.tsx) is the window's top row: Back, the
 * title, then the toolbar slot, where an app's <DesktopAppToolbar> renders its
 * controls. An app's <WindowStatusBar> renders into the status-bar slot. Both
 * stay fixed at the edges of the content column while the scroller between
 * them moves. The slots are `display: contents`: what renders into them is
 * laid out by the row (the toolbar) or the column (the status bar).
 */

export function WindowToolbarSlot() {
  const setSlot = useSetAtom(windowToolbarSlotAtom);
  return <div ref={setSlot} className="contents" />;
}

export function WindowStatusBarSlot() {
  const setSlot = useSetAtom(windowStatusBarSlotAtom);
  return <div ref={setSlot} className="contents" />;
}

/**
 * An app's bottom bar (counts, selection summary, view options). In a desktop
 * window it sits on the window's bottom edge with a hairline above it, padded
 * to line up with the content; in classic mode it renders in place with only
 * the page's own classes.
 */
export function WindowStatusBar({ className, ...props }: ComponentProps<"div">) {
  const embedded = useIsEmbeddedFrame();
  const slot = useAtomValue(windowStatusBarSlotAtom);

  if (!embedded) return <div className={className} {...props} />;

  const bar = (
    <div
      data-window-statusbar=""
      className={cn("flex items-center gap-2 text-xs text-muted-foreground", className, "tm-window-statusbar")}
      {...props}
    />
  );
  return slot ? createPortal(bar, slot) : bar;
}
