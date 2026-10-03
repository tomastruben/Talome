"use client";

import { useEffect, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { useAtomValue, useSetAtom } from "jotai";
import { pageTitleAtom } from "@/atoms/page-title";
import { windowToolbarSlotAtom } from "@/atoms/window-sidebar";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";
import { cn } from "@/lib/utils";

/**
 * An app's toolbar (view switches, verbs, search).
 *
 * In a desktop window it renders into the unified toolbar's slot, after Back
 * and the title (see components/desktop/window-toolbar.tsx), so it shares the
 * window's top row, never scrolls away and needs no sticky positioning,
 * backdrop or negative margins. The shell's `.tm-window-toolbar` makes it the
 * row's flexible part and sets its block padding (it is unlayered, so it wins
 * over the page's padding, margin and border utilities); the row owns the
 * inline padding and the hairline, and the page's className keeps the
 * controls' layout. In classic mode it renders in place with only the page's
 * own classes.
 */
export function DesktopAppToolbar({ windowTitle, className, ...props }: ComponentProps<"div"> & { windowTitle?: string }) {
  const embedded = useIsEmbeddedFrame();
  const slot = useAtomValue(windowToolbarSlotAtom);
  const setPageTitle = useSetAtom(pageTitleAtom);

  useEffect(() => {
    if (!embedded || windowTitle === undefined) return;
    setPageTitle(windowTitle);
    return () => setPageTitle(null);
  }, [embedded, windowTitle, setPageTitle]);

  if (!embedded) return <div data-app-toolbar="" className={className} {...props} />;

  const toolbar = (
    <div
      data-desktop-app-toolbar="true"
      data-app-toolbar=""
      className={cn(className, "tm-window-toolbar")}
      {...props}
    />
  );
  return slot ? createPortal(toolbar, slot) : toolbar;
}
