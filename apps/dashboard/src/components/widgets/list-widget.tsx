"use client";

import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function WidgetList({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [showTopFade, setShowTopFade] = useState(false);
  const [showBottomFade, setShowBottomFade] = useState(false);

  // Stable ref for the fade-check function so children changes can call it
  // without tearing down and recreating the ResizeObserver.
  const updateFadesRef = useRef<() => void>(() => {});

  // Create observers once — they persist across children changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const updateFades = () => {
      const maxScroll = el.scrollHeight - el.clientHeight;
      if (maxScroll <= 1) {
        setShowTopFade(false);
        setShowBottomFade(false);
        return;
      }
      setShowTopFade(el.scrollTop > 2);
      setShowBottomFade(el.scrollTop < maxScroll - 2);
    };

    updateFadesRef.current = updateFades;
    updateFades();
    el.addEventListener("scroll", updateFades, { passive: true });

    const resizeObserver = new ResizeObserver(updateFades);
    resizeObserver.observe(el);

    // Detect children mutations that change scrollHeight without changing
    // the container's border-box (which ResizeObserver wouldn't catch).
    const mutationObserver = new MutationObserver(updateFades);
    mutationObserver.observe(el, { childList: true, subtree: true });

    return () => {
      el.removeEventListener("scroll", updateFades);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className={cn("h-full overflow-y-auto", className)}>
        {children}
      </div>
      <div
        className={cn(
          "pointer-events-none absolute top-0 left-0 right-0 h-5 bg-gradient-to-b from-card to-transparent transition-opacity duration-150",
          showTopFade ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        className={cn(
          "pointer-events-none absolute bottom-0 left-0 right-0 h-5 bg-gradient-to-t from-card to-transparent transition-opacity duration-150",
          showBottomFade ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

export function WidgetListState({
  icon,
  message,
  action,
  className,
}: {
  icon: IconSvgElement;
  message: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-h-0 flex-1 flex flex-col items-center justify-center gap-2 px-4 py-6 text-center",
        className,
      )}
    >
      <HugeiconsIcon icon={icon} size={24} className="text-dim-foreground" />
      <p className="text-xs text-muted-foreground">{message}</p>
      {action}
    </div>
  );
}

export function WidgetListSkeleton({
  rows = 5,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("divide-y divide-border/40", className)}>
      {Array.from({ length: rows }).map((_, idx) => (
        <div key={idx} className="px-4 py-3">
          <Skeleton className="h-3 w-1/2 mb-2" />
          <Skeleton className="h-2.5 w-2/3" />
        </div>
      ))}
    </div>
  );
}
