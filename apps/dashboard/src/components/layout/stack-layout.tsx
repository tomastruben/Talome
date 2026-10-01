"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { DURATION, TRAVEL, enter, exit } from "@/lib/motion";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";

/**
 * Stack navigation direction between two paths under `rootPath`:
 * 1 = push (deeper), -1 = pop (back towards the root), 0 = sibling (crossfade).
 */
export function stackDirection(prevPath: string, nextPath: string, rootPath: string): 1 | -1 | 0 {
  if (prevPath === nextPath) return 0;
  const depth = (path: string) => {
    if (path === rootPath) return 0;
    if (!path.startsWith(rootPath + "/")) return 0;
    return path.slice(rootPath.length + 1).split("/").filter(Boolean).length;
  };
  const from = depth(prevPath);
  const to = depth(nextPath);
  if (to > from) return 1;
  if (to < from) return -1;
  return 0;
}

/**
 * Push: the new page travels 24px in while the old one drifts 12px out.
 * Pop mirrors it. Siblings crossfade. Never a full-width slide.
 */
export const slideVariants = {
  enter: (dir: number) => ({
    x: dir > 0 ? TRAVEL.push : dir < 0 ? TRAVEL.pushExit : 0,
    opacity: 0,
    zIndex: dir < 0 ? 0 : 2,
  }),
  center: { x: 0, opacity: 1, zIndex: 1 },
  exit: (dir: number) => ({
    x: dir > 0 ? TRAVEL.pushExit : dir < 0 ? TRAVEL.push : 0,
    opacity: 0,
    zIndex: dir < 0 ? 2 : 0,
  }),
};

/** Entrance: 180ms, opacity done by 60%. */
export const slideTransition = enter(DURATION.base);
/** Exit: 140ms on the exit curve. */
export const slideExitTransition = exit(DURATION.exit);
/** Reduced motion: a 120ms crossfade (MotionConfig already drops the travel). */
export const reducedSlideTransition = { duration: DURATION.exitFast, ease: "linear" as const };

/** Deep links (`?id=`) scroll to their own target, so the stack must not restore over them. */
export function shouldRestoreScroll(search: string): boolean {
  return !new URLSearchParams(search).has("id");
}

interface StackLayoutProps {
  children: React.ReactNode;
  /** The root path for this navigation stack (e.g. "/dashboard/settings") */
  rootPath: string;
}

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  return (el?.closest("[data-content-scroll], [class*='overflow-y-auto']") as HTMLElement | null) ?? null;
}

export function StackLayout({ children, rootPath }: StackLayoutProps) {
  const pathname = usePathname();
  // Direction is derived state: recomputed during render when the path changes.
  const [nav, setNav] = useState<{ path: string; direction: 1 | -1 | 0 }>({ path: pathname, direction: 0 });
  if (nav.path !== pathname) {
    setNav({ path: pathname, direction: stackDirection(nav.path, pathname, rootPath) });
  }
  const direction = nav.path === pathname ? nav.direction : stackDirection(nav.path, pathname, rootPath);

  const containerRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef(pathname);
  const scrollPositions = useRef<Map<string, number>>(new Map());
  const reduceMotion = useReducedMotion();
  // In a desktop window the panel sits on window glass; an opaque fill would
  // read as a dark slab over the frost.
  const embedded = useIsEmbeddedFrame();

  // While a transition runs, the shell resets the shared scroller to the top;
  // those scroll events must not overwrite the saved positions.
  const transitioning = useRef(false);

  // Remember each page's scroll position as it scrolls, keyed by path.
  useEffect(() => {
    if (pathRef.current !== pathname) transitioning.current = true;
    pathRef.current = pathname;
    const scrollParent = findScrollParent(containerRef.current);
    if (!scrollParent) return;
    const record = () => {
      if (!transitioning.current) scrollPositions.current.set(pathname, scrollParent.scrollTop);
    };
    scrollParent.addEventListener("scroll", record, { passive: true });
    return () => scrollParent.removeEventListener("scroll", record);
  }, [pathname]);

  // Restore the saved position once the outgoing page has finished leaving,
  // so the shared scroll container never jumps both pages mid-transition.
  const restoreScroll = useCallback(() => {
    transitioning.current = false;
    const scrollParent = findScrollParent(containerRef.current);
    if (!scrollParent) return;
    if (!shouldRestoreScroll(window.location.search)) return;
    const saved = scrollPositions.current.get(pathRef.current);
    scrollParent.scrollTo({ top: saved ?? 0 });
  }, []);

  const transition = reduceMotion ? reducedSlideTransition : slideTransition;

  return (
    <div
      ref={containerRef}
      className="grid [&>*]:col-start-1 [&>*]:row-start-1 relative min-w-0"
      style={{ overflowX: "clip" }}
    >
      <AnimatePresence initial={false} custom={direction} onExitComplete={restoreScroll}>
        <motion.div
          key={pathname}
          custom={direction}
          variants={{
            enter: slideVariants.enter,
            center: slideVariants.center,
            exit: (dir: number) => ({
              ...slideVariants.exit(dir),
              transition: reduceMotion ? reducedSlideTransition : slideExitTransition,
            }),
          }}
          initial="enter"
          animate="center"
          exit="exit"
          transition={transition}
          className={embedded ? "will-change-transform" : "bg-background will-change-transform"}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
