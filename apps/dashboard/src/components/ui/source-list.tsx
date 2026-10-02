"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useAtomValue, useSetAtom } from "jotai";
import { windowSidebarSlotAtom } from "@/atoms/window-sidebar";
import { HugeiconsIcon } from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";
import { SKELETON_DELAY_MS } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * A Finder-style source list for apps running in a desktop window: titled
 * sections of rows with an icon, a label and an optional count. Apps render it
 * through <WindowSidebarLayout>, which shows it only when the app is windowed
 * and the window is wide enough; elsewhere the app keeps its own tabs.
 *
 * The list paints nothing: it sits on the window's sidebar panel (a card lift
 * on the glass, see WindowSidebarSlot), and its rows use foreground tints for
 * hover and selection.
 */

export interface SourceListItemAction {
  icon: IconSvgElement;
  /** Accessible name and tooltip, e.g. "Eject Backup drive" */
  label: string;
  onSelect: () => void;
}

type SourceListItemProps = Omit<ComponentProps<"button">, "children" | "onSelect" | "disabled" | "type"> & {
  /** Omit for plain text rows, such as categories */
  icon?: IconSvgElement;
  label: string;
  /** The current place (aria-current="page"), for navigation rows */
  active?: boolean;
  /** On or off (aria-pressed), for filter rows; replaces aria-current */
  pressed?: boolean;
  /**
   * A count (rendered as a formatted number) or a short status after the
   * label. Both take the row's trailing tone unless they set their own colour.
   */
  trailing?: ReactNode;
  /** Icon tint; defaults to muted, or foreground on the selected row */
  iconClassName?: string;
  /** Called when the row is chosen; optional when `href` navigates instead */
  onSelect?: () => void;
  /** Navigates with next/link instead of calling onSelect */
  href?: string;
  disabled?: boolean;
  /** A secondary icon button at the end of the row (eject, remove…); never selects the row */
  action?: SourceListItemAction;
};

const numberFormat = new Intl.NumberFormat();

/**
 * The trailing count's colour. Muted at rest; on a hovered or selected row it
 * lifts to foreground/70, because the row's foreground tint takes muted text
 * below 4.5:1 on window glass (light, selected: 3.7:1). Checked in
 * design-contrast.test.tsx over the glass and the content tint, both themes.
 */
const TRAILING_TONE = {
  rest: "text-muted-foreground",
  selected: "text-foreground/70",
  hover: "group-hover/source-item:text-foreground/70",
  /** With an action button, the wrapper is the hover target */
  hoverWithAction: "group-hover/source-row:text-foreground/70",
} as const;

function Trailing({ value, className }: { value: ReactNode; className: string }) {
  // Nothing React would render gets no slot either
  if (value === null || value === undefined || typeof value === "boolean" || value === "") return null;
  if (typeof value === "number") {
    // A count of 0 says nothing a row without a count doesn't.
    if (value === 0 || !Number.isFinite(value)) return null;
  }
  return (
    <span
      data-slot="source-list-trailing"
      className={cn("flex shrink-0 items-center text-xs tabular-nums transition-colors duration-150 ease-out", className)}
    >
      {typeof value === "number" ? numberFormat.format(value) : value}
    </span>
  );
}

export function SourceListItem({
  icon,
  label,
  active = false,
  pressed,
  trailing,
  iconClassName,
  onSelect,
  href,
  disabled = false,
  action,
  className,
  onClick,
  ...rest
}: SourceListItemProps) {
  const selected = pressed ?? active;
  const hover = action ? "group-hover/source-row:bg-foreground/5 group-hover/source-row:text-foreground" : "hover:bg-foreground/5 hover:text-foreground";
  const trailingTone = selected
    ? TRAILING_TONE.selected
    : cn(TRAILING_TONE.rest, !disabled && (action ? TRAILING_TONE.hoverWithAction : TRAILING_TONE.hover));
  const rowClassName = cn(
    "group/source-item flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm pointer-coarse:h-11",
    "transition-colors duration-150 ease-out",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    selected ? "bg-foreground/10 text-foreground" : cn("text-foreground/80", !disabled && hover),
    disabled && "pointer-events-none opacity-50",
    // Room for the action button, so the label and count never sit under it
    action && "pr-9 pointer-coarse:pr-11",
    className,
  );
  const content = (
    <>
      {icon && (
        <HugeiconsIcon
          icon={icon}
          size={15}
          aria-hidden="true"
          className={cn("shrink-0", iconClassName ?? (selected ? "text-foreground" : "text-muted-foreground"))}
        />
      )}
      <span className="tm-cap-trim min-w-0 flex-1 truncate">{label}</span>
      <Trailing value={trailing} className={trailingTone} />
    </>
  );
  const ariaCurrent = pressed === undefined && active ? ("page" as const) : undefined;

  let row: ReactNode;
  if (href && !disabled) {
    // Only presentational and ARIA props carry over to the link.
    const linkProps = Object.fromEntries(
      Object.entries(rest).filter(([key]) => key === "title" || key === "id" || key.startsWith("aria-") || key.startsWith("data-")),
    );
    row = (
      <Link
        {...linkProps}
        href={href}
        aria-current={ariaCurrent}
        className={rowClassName}
        onClick={() => onSelect?.()}
      >
        {content}
      </Link>
    );
  } else {
    row = (
      <button
        {...rest}
        type="button"
        disabled={disabled}
        aria-disabled={disabled || undefined}
        aria-current={ariaCurrent}
        aria-pressed={pressed}
        className={rowClassName}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) onSelect?.();
        }}
      >
        {content}
      </button>
    );
  }

  if (!action) return row;

  return (
    <div className="group/source-row relative flex min-w-0">
      {row}
      <button
        type="button"
        aria-label={action.label}
        title={action.label}
        disabled={disabled}
        className={cn(
          "absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground",
          "opacity-0 transition-[opacity,color,background-color] duration-150 ease-out",
          "hover:bg-foreground/10 hover:text-foreground",
          "group-hover/source-row:opacity-100 group-focus-within/source-row:opacity-100 focus-visible:opacity-100",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          // No hover on touch: always shown, with a 44px target
          "pointer-coarse:right-1.5 pointer-coarse:opacity-100 pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5",
          disabled && "pointer-events-none",
        )}
        onClick={(event) => {
          event.stopPropagation();
          action.onSelect();
        }}
      >
        <HugeiconsIcon icon={action.icon} size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function SourceListSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-px">
      {title && <h2 className="px-2.5 pb-1.5 text-xs font-medium text-muted-foreground">{title}</h2>}
      {children}
    </section>
  );
}

export function SourceList({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <nav
      aria-label={label}
      className={cn(
        "flex h-full w-52 shrink-0 flex-col gap-5 overflow-y-auto px-3 pt-3 pb-4 scrollbar-none",
        className,
      )}
    >
      {children}
    </nav>
  );
}

/** 70%, 55% and 62.5% of the row: label lengths vary, so the shape does too. */
const SKELETON_WIDTHS = ["w-7/10", "w-11/20", "w-5/8"] as const;

/**
 * Rows shaped like a section of the list, for a source that is still loading.
 * Appears only after SKELETON_DELAY_MS, so a fast load never flashes it.
 */
export function SourceListSkeleton({ rows = 3 }: { rows?: number }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), SKELETON_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  if (!shown) return null;
  return (
    <div aria-hidden="true" data-slot="source-list-skeleton" className="flex flex-col gap-1">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className={cn("h-8 rounded-lg pointer-coarse:h-11", SKELETON_WIDTHS[index % SKELETON_WIDTHS.length])} />
      ))}
    </div>
  );
}

/**
 * In a desktop window an app's sidebar renders into this slot, which the
 * window shell places beside the app outside its padded scroll area. It shows
 * only when the window is at least 48rem wide (a container query on the
 * window's `main`, so resizing the window decides, not the screen) and an app
 * put a sidebar in it (an empty slot is hidden in globals.css). 48rem is where
 * the sidebar (w-52 and its inset, 218px) leaves the content about as wide as
 * a 560px window without one, so the content never narrows as the window
 * grows; lower, the sidebar took a third of the window.
 *
 * The slot is the sidebar panel: inset 8px from the window's top, left and
 * bottom edges, full height, rounded, with a card lift and a hairline on the
 * glass (no blur of its own: inside the frame it can't see the wallpaper).
 * Its top 44px, down to the toolbar's bottom edge, stay empty for the window
 * controls the window lays over them; that band drags the window
 * (window-drag.ts: a "surface" region drags only where nothing sits on it).
 */
export function WindowSidebarSlot() {
  const setSlot = useSetAtom(windowSidebarSlotAtom);
  // data-window-sidebar: the panel sits on the window's glass, so the glass
  // token remap in globals.css (Primitives on window glass) applies here too
  // and bg-card is the remapped lift, not the opaque card. Its corners are
  // concentric with the window's: 8px in from a rounded-2xl (18px) window,
  // so rounded-lg (10px). The window's own radius would bulge at the corners.
  return (
    <div
      ref={setSlot}
      data-window-sidebar=""
      data-window-drag-region="surface"
      className="tm-window-sidebar m-2 mr-0 hidden min-h-0 shrink-0 rounded-lg border border-window-separator bg-card pt-11 @3xl/window:flex"
    />
  );
}

/**
 * Controls the sidebar replaces, such as a tab strip, take this class: they
 * hide exactly when the sidebar shows. Outside a window there is no `window`
 * container, so they always show in classic mode.
 */
export const WINDOW_SIDEBAR_REPLACES = "@3xl/window:hidden";

/**
 * Window-only elements, such as a heading naming the view the sidebar chose:
 * shown exactly when the sidebar shows, never in classic mode.
 */
export const WINDOW_SIDEBAR_SHOWS = "hidden @3xl/window:flex";

/** Renders the app, and its sidebar into the window's sidebar slot when windowed. */
export function WindowSidebarLayout({ sidebar, children }: { sidebar: ReactNode | null; children: ReactNode }) {
  const embedded = useIsEmbeddedFrame();
  const slot = useAtomValue(windowSidebarSlotAtom);
  return (
    <>
      {embedded && slot && sidebar ? createPortal(sidebar, slot) : null}
      {children}
    </>
  );
}

const subscribeNothing = () => () => {};
const notShown = () => false;

/**
 * Whether the window's sidebar is on screen right now (embedded, the window
 * is wide enough and an app put a sidebar in the slot), for logic that must
 * agree with WINDOW_SIDEBAR_REPLACES, such as moving focus. False on the
 * server, during hydration and outside a window.
 */
export function useWindowSidebarShown(): boolean {
  const embedded = useIsEmbeddedFrame();
  const slot = useAtomValue(windowSidebarSlotAtom);
  const subscribe = useCallback(
    (onChange: () => void) => {
      const target = slot?.parentElement;
      if (!slot || !target || typeof ResizeObserver === "undefined") return () => {};
      const observer = new ResizeObserver(onChange);
      // The window resizing (the container query) and the slot itself (it
      // shows once a sidebar renders into it, and hides when that goes)
      observer.observe(target);
      observer.observe(slot);
      return () => observer.disconnect();
    },
    [slot],
  );
  const getSnapshot = useCallback(
    () => (slot ? window.getComputedStyle(slot).display !== "none" : false),
    [slot],
  );
  const shown = useSyncExternalStore(embedded && slot ? subscribe : subscribeNothing, getSnapshot, notShown);
  return embedded && Boolean(slot) && shown;
}
