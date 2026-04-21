"use client";

import { useRef, useEffect } from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";

/** Shared slide animation for stack-based navigation (push/pop). */
export const slideVariants = {
  enter: (dir: number) => ({
    x: dir > 0 ? "100%" : "-20%",
    opacity: dir > 0 ? 1 : 0.7,
    zIndex: dir > 0 ? 2 : 0,
  }),
  center: { x: "0%", opacity: 1, zIndex: 1 },
  exit: (dir: number) => ({
    x: dir > 0 ? "-20%" : "100%",
    opacity: dir > 0 ? 0.7 : 1,
    zIndex: dir > 0 ? 0 : 2,
  }),
};

export const slideTransition = {
  type: "tween" as const,
  duration: 0.35,
  ease: [0.32, 0.72, 0, 1] as [number, number, number, number],
};

interface StackLayoutProps {
  children: React.ReactNode;
  /** The root path for this navigation stack (e.g. "/dashboard/settings") */
  rootPath: string;
}

export function StackLayout({ children, rootPath }: StackLayoutProps) {
  const pathname = usePathname();
  const prevPath = useRef(pathname);
  const direction = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Map<string, number>>(new Map());

  const isSub = pathname !== rootPath && pathname.startsWith(rootPath + "/");
  const wasSub =
    prevPath.current !== rootPath &&
    prevPath.current.startsWith(rootPath + "/");

  if (pathname !== prevPath.current) {
    // Save scroll position of the page we're leaving
    const scrollParent = containerRef.current?.closest(
      "[class*='overflow-y-auto']"
    ) as HTMLElement | null;
    if (scrollParent) {
      scrollPositions.current.set(prevPath.current, scrollParent.scrollTop);
    }

    if (isSub && !wasSub) direction.current = 1;
    else if (!isSub && wasSub) direction.current = -1;
    else direction.current = 1;
    prevPath.current = pathname;
  }

  // Restore saved scroll position after the slide animation completes (300ms)
  // so the shared scroll container doesn't jump both pages mid-transition.
  useEffect(() => {
    const scrollParent = containerRef.current?.closest(
      "[class*='overflow-y-auto']"
    ) as HTMLElement | null;
    if (!scrollParent) return;

    const saved = scrollPositions.current.get(pathname);
    const timer = setTimeout(() => {
      scrollParent.scrollTo({ top: saved ?? 0 });
    }, 370);
    return () => clearTimeout(timer);
  }, [pathname]);

  return (
    <div
      ref={containerRef}
      className="grid [&>*]:col-start-1 [&>*]:row-start-1 relative min-w-0"
      style={{ overflowX: "clip" }}
    >
      <AnimatePresence initial={false} custom={direction.current}>
        <motion.div
          key={pathname}
          custom={direction.current}
          variants={slideVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={slideTransition}
          className="bg-background will-change-transform"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
