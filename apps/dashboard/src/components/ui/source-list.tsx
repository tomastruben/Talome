"use client";

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAtomValue, useSetAtom } from "jotai";
import { windowSidebarSlotAtom } from "@/atoms/window-sidebar";
import { HugeiconsIcon } from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import { useIsEmbeddedFrame } from "@/hooks/use-desktop-mode";
import { cn } from "@/lib/utils";

/**
 * A Finder-style source list for apps running in a desktop window: titled
 * sections of rows with an icon, a label and an optional count. Apps render it
 * through <WindowSidebarLayout>, which shows it only when the app is windowed
 * and the window is wide enough; elsewhere the app keeps its own tabs.
 */

interface SourceListItemProps {
  /** Omit for plain text rows, such as categories */
  icon?: IconSvgElement;
  label: string;
  active?: boolean;
  /** A count or a short status after the label */
  trailing?: ReactNode;
  /** Icon tint; defaults to the Talome accent for folders and places */
  iconClassName?: string;
  onSelect: () => void;
}

export function SourceListItem({ icon, label, active = false, trailing, iconClassName, onSelect }: SourceListItemProps) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors duration-150 ease-out",
        active
          ? "bg-foreground/[0.1] text-foreground"
          : "text-foreground/80 hover:bg-foreground/[0.05] hover:text-foreground",
      )}
      onClick={onSelect}
    >
      {icon && (
        <HugeiconsIcon
          icon={icon}
          size={15}
          className={cn("shrink-0", iconClassName ?? (active ? "text-foreground" : "text-muted-foreground"))}
        />
      )}
      <span className="tm-cap-trim min-w-0 flex-1 truncate">{label}</span>
      {typeof trailing === "number" ? (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{trailing}</span>
      ) : trailing}
    </button>
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
        "flex h-full w-56 shrink-0 flex-col gap-6 overflow-y-auto border-r border-foreground/[0.06] px-3 py-4 scrollbar-none",
        className,
      )}
    >
      {children}
    </nav>
  );
}

/**
 * In a desktop window an app's sidebar renders into this slot, which the
 * window shell places beside the app outside its padded scroll area. It shows
 * only when the window is at least 42rem wide (a container query on the shell,
 * so resizing the window decides, not the screen).
 */
export function WindowSidebarSlot() {
  const setSlot = useSetAtom(windowSidebarSlotAtom);
  return <div ref={setSlot} className="hidden min-h-0 shrink-0 @2xl:flex" />;
}

/**
 * Controls the sidebar replaces, such as a tab strip, take this class: they
 * hide exactly when the sidebar shows.
 */
export const WINDOW_SIDEBAR_REPLACES = "@2xl:hidden";

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
