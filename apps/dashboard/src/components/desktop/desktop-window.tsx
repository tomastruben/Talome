"use client";

import {
  memo,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  HugeiconsIcon,
  Cancel01Icon,
  MaximizeScreenIcon,
  MinimizeScreenIcon,
} from "@/components/icons";
import { cn } from "@/lib/utils";
import {
  clampDesktopBounds,
  maximizedDesktopBounds,
  type DesktopArea,
  type DesktopBounds,
} from "@/lib/desktop-window-state";

interface DesktopWindowProps {
  id: string;
  title: string;
  bounds: DesktopBounds;
  restoreBounds?: DesktopBounds;
  area: DesktopArea;
  minimum: Pick<DesktopBounds, "width" | "height">;
  active: boolean;
  maximized: boolean;
  zIndex: number;
  children: ReactNode;
  onFocus: () => void;
  onClose: () => void;
  onMinimize: () => void;
  onBoundsChange: (bounds: DesktopBounds) => void;
  onMaximizeChange: (maximized: boolean, restoreBounds?: DesktopBounds) => void;
}

interface PointerOrigin {
  pointerX: number;
  pointerY: number;
  bounds: DesktopBounds;
}

export const DesktopWindow = memo(function DesktopWindow({
  id,
  title,
  bounds,
  restoreBounds,
  area,
  minimum,
  active,
  maximized,
  zIndex,
  children,
  onFocus,
  onClose,
  onMinimize,
  onBoundsChange,
  onMaximizeChange,
}: DesktopWindowProps) {
  const dragOrigin = useRef<PointerOrigin | null>(null);
  const resizeOrigin = useRef<PointerOrigin | null>(null);
  const [isManipulating, setIsManipulating] = useState(false);

  useEffect(() => {
    if (!isManipulating) return;

    const handlePointerMove = (event: globalThis.PointerEvent) => {
      if (dragOrigin.current) {
        onBoundsChange(clampDesktopBounds(
          {
            ...dragOrigin.current.bounds,
            x: dragOrigin.current.bounds.x + event.clientX - dragOrigin.current.pointerX,
            y: dragOrigin.current.bounds.y + event.clientY - dragOrigin.current.pointerY,
          },
          area,
          minimum,
        ));
      }

      if (resizeOrigin.current) {
        onBoundsChange(clampDesktopBounds(
          {
            ...resizeOrigin.current.bounds,
            width: resizeOrigin.current.bounds.width + event.clientX - resizeOrigin.current.pointerX,
            height: resizeOrigin.current.bounds.height + event.clientY - resizeOrigin.current.pointerY,
          },
          area,
          minimum,
        ));
      }
    };

    const handlePointerUp = () => {
      dragOrigin.current = null;
      resizeOrigin.current = null;
      setIsManipulating(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [area, isManipulating, minimum, onBoundsChange]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (maximized || event.button !== 0) return;
    onFocus();
    dragOrigin.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      bounds,
    };
    setIsManipulating(true);
  };

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (maximized || event.button !== 0) return;
    event.stopPropagation();
    onFocus();
    resizeOrigin.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      bounds,
    };
    setIsManipulating(true);
  };

  const toggleMaximize = () => {
    if (maximized) {
      onMaximizeChange(false, restoreBounds);
      return;
    }
    onMaximizeChange(true, bounds);
    onBoundsChange(maximizedDesktopBounds(area));
  };

  return (
    <section
      data-desktop-window={id}
      aria-label={`${title} window`}
      className={cn(
        "absolute flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card",
        "transition-[border-color,opacity] duration-150 ease-out",
        active ? "border-foreground/30" : "border-border opacity-95",
      )}
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
        zIndex,
      }}
      onPointerDown={onFocus}
    >
      <div
        className={cn(
          "group/titlebar relative flex h-11 shrink-0 touch-none select-none items-center border-b border-border/70 px-3",
          active ? "bg-card" : "bg-card/80",
        )}
        onPointerDown={startDrag}
        onDoubleClick={toggleMaximize}
      >
        <div className="flex items-center gap-2" aria-label="Window controls">
          <button
            type="button"
            aria-label={`Close ${title}`}
            className={cn(
              "group/control flex size-3.5 items-center justify-center rounded-full transition-colors duration-150",
              active
                ? "bg-status-critical/70 hover:bg-status-critical"
                : "bg-muted-foreground/25 hover:bg-status-critical/70",
            )}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onClose}
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              size={8}
              strokeWidth={2}
              className="text-background opacity-0 transition-opacity duration-150 group-hover/control:opacity-100"
            />
          </button>
          <button
            type="button"
            aria-label={`Minimize ${title}`}
            className={cn(
              "group/control flex size-3.5 items-center justify-center rounded-full transition-colors duration-150",
              active
                ? "bg-status-warning/70 hover:bg-status-warning"
                : "bg-muted-foreground/25 hover:bg-status-warning/70",
            )}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onMinimize}
          >
            <HugeiconsIcon
              icon={MinimizeScreenIcon}
              size={8}
              strokeWidth={2}
              className="text-background opacity-0 transition-opacity duration-150 group-hover/control:opacity-100"
            />
          </button>
          <button
            type="button"
            aria-label={maximized ? `Restore ${title}` : `Maximize ${title}`}
            className={cn(
              "group/control flex size-3.5 items-center justify-center rounded-full transition-colors duration-150",
              active
                ? "bg-status-healthy/70 hover:bg-status-healthy"
                : "bg-muted-foreground/25 hover:bg-status-healthy/70",
            )}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={toggleMaximize}
          >
            <HugeiconsIcon
              icon={MaximizeScreenIcon}
              size={8}
              strokeWidth={2}
              className="text-background opacity-0 transition-opacity duration-150 group-hover/control:opacity-100"
            />
          </button>
        </div>

        <span className="pointer-events-none absolute inset-x-24 truncate text-center text-sm font-medium">
          {title}
        </span>
      </div>

      <div className="relative flex-1 min-h-0 overflow-hidden bg-background">
        <div className={cn("size-full", isManipulating && "pointer-events-none")}>
          {children}
        </div>
        {!maximized && (
          <button
            type="button"
            aria-label={`Resize ${title}`}
            className="absolute right-0 bottom-0 size-4 cursor-nwse-resize touch-none"
            onPointerDown={startResize}
          >
            <span className="absolute right-1 bottom-1 size-2 border-r border-b border-muted-foreground/50" />
          </button>
        )}
      </div>
    </section>
  );
});
