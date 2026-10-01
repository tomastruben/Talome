"use client";

import type { ComponentProps } from "react";
import { createPortal } from "react-dom";
import { useAtomValue } from "jotai";
import { windowToolbarSlotAtom } from "@/atoms/window-sidebar";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";
import { cn } from "@/lib/utils";

/**
 * An app's toolbar (heading, search, view switches, primary action).
 *
 * In a desktop window it renders into the window's toolbar slot above the
 * scroller (see components/desktop/window-content.tsx), so it never scrolls
 * away and needs no sticky positioning, backdrop or negative margins. The
 * shell's `.tm-window-toolbar` sets its height, padding and hairline (it is
 * unlayered, so it wins over the page's padding utilities); the page's
 * className keeps the row layout. In classic mode it renders in place with
 * only the page's own classes.
 */
export function DesktopAppToolbar({ className, ...props }: ComponentProps<"div">) {
  const embedded = useIsEmbeddedFrame();
  const slot = useAtomValue(windowToolbarSlotAtom);

  if (!embedded) return <div className={className} {...props} />;

  const toolbar = (
    <div
      data-desktop-app-toolbar="true"
      className={cn(className, "tm-window-toolbar")}
      {...props}
    />
  );
  return slot ? createPortal(toolbar, slot) : toolbar;
}
