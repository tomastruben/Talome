"use client";

import type { PointerEvent as ReactPointerEvent } from "react";
import {
  HugeiconsIcon,
  ArrowShrink02Icon,
  Cancel01Icon,
  FullScreenIcon,
  MinusSignIcon,
  PanelLeftIcon,
  PanelRightIcon,
  SquareIcon,
  Tick01Icon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Talome's window controls: quiet monochrome buttons at the trailing edge of
 * the title bar instead of macOS traffic lights.
 *
 * - Red, amber and green already mean critical, warning and healthy across
 *   Talome, so coloured dots in every title bar would read as status.
 * - 14px dots are hard to hit on an iPad; these are 24px (32px on touch).
 * - The green button's meaning (full screen or zoom?) is a guess; Arrange
 *   says exactly what will happen and shows where the window is now.
 */

export type DesktopWindowLayout = "fill" | "left" | "right" | "free";

const LAYOUT_OPTIONS: { layout: Exclude<DesktopWindowLayout, "free">; label: string; icon: IconSvgElement }[] = [
  { layout: "fill", label: "Fill", icon: FullScreenIcon },
  { layout: "left", label: "Left half", icon: PanelLeftIcon },
  { layout: "right", label: "Right half", icon: PanelRightIcon },
];

const LAYOUT_ICON: Record<DesktopWindowLayout, IconSvgElement> = {
  fill: FullScreenIcon,
  left: PanelLeftIcon,
  right: PanelRightIcon,
  free: SquareIcon,
};

const CONTROL_CLASS =
  "flex size-6 shrink-0 items-center justify-center rounded-md transition-[background-color,color,transform] duration-150 ease-out hover:bg-foreground/[0.08] hover:text-foreground active:scale-95 disabled:pointer-events-none disabled:opacity-40";

/** Keep presses on a control from starting a title bar drag or a double-click fill. */
const stopTitlebarGesture = {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => event.stopPropagation(),
  onDoubleClick: (event: React.MouseEvent<HTMLElement>) => event.stopPropagation(),
};

interface WindowControlsProps {
  title: string;
  active?: boolean;
  /** Where the window sits now; omit to leave out Arrange */
  layout?: DesktopWindowLayout;
  /** The window remembers a size to go back to */
  canRestore?: boolean;
  onLayoutChange?: (layout: Exclude<DesktopWindowLayout, "free">) => void;
  onRestore?: () => void;
  onMinimize?: () => void;
  onClose: () => void;
  className?: string;
}

export function WindowControls({
  title,
  active = true,
  layout,
  canRestore = false,
  onLayoutChange,
  onRestore,
  onMinimize,
  onClose,
  className,
}: WindowControlsProps) {
  const tone = active ? "text-muted-foreground" : "text-muted-foreground/60";

  return (
    <div
      data-window-controls=""
      role="group"
      aria-label="Window controls"
      className={cn("flex shrink-0 items-center gap-0.5", className)}
    >
      {onMinimize && (
        <button
          type="button"
          aria-label={`Minimize ${title}`}
          className={cn(CONTROL_CLASS, tone)}
          {...stopTitlebarGesture}
          onClick={onMinimize}
        >
          <HugeiconsIcon icon={MinusSignIcon} size={14} strokeWidth={1.8} />
        </button>
      )}
      {layout && onLayoutChange && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Arrange ${title}`}
              className={cn(CONTROL_CLASS, tone, "data-[state=open]:bg-foreground/[0.08] data-[state=open]:text-foreground")}
              {...stopTitlebarGesture}
            >
              <HugeiconsIcon icon={LAYOUT_ICON[layout]} size={14} strokeWidth={1.8} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={6}
            className="z-[1400] w-48"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Arrange</DropdownMenuLabel>
            {LAYOUT_OPTIONS.map((option) => (
              <DropdownMenuItem key={option.layout} onSelect={() => onLayoutChange(option.layout)}>
                <HugeiconsIcon icon={option.icon} size={15} />
                {option.label}
                {layout === option.layout && (
                  <HugeiconsIcon icon={Tick01Icon} size={13} className="ml-auto" />
                )}
              </DropdownMenuItem>
            ))}
            {canRestore && onRestore && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onRestore}>
                  <HugeiconsIcon icon={ArrowShrink02Icon} size={15} />
                  Previous size
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <button
        type="button"
        aria-label={`Close ${title}`}
        className={cn(CONTROL_CLASS, tone, "hover:bg-status-critical/15 hover:text-status-critical")}
        {...stopTitlebarGesture}
        onClick={onClose}
      >
        <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.8} />
      </button>
    </div>
  );
}
