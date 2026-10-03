"use client";

import type { ComponentProps } from "react";
import { HugeiconsIcon } from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import { cn } from "@/lib/utils";

/**
 * A capsule of related toolbar verbs (Files: Upload and New folder; Media:
 * Cinema and Select), like a segmented group in a Finder toolbar: one
 * rounded-full container with a foreground fill and a hairline, holding icon
 * buttons that sit flush against each other. Unrelated verbs get their own
 * capsule; the search field stays a separate field at the end of the row.
 *
 * The fill and the hairline are foreground mixes, so the capsule reads on the
 * window's glass in both themes (design-contrast.test.tsx); the hairline is an
 * inset outline, so the capsule is exactly as tall as its buttons and lines
 * up with the 32px fields beside it.
 */
export function ToolbarGroup({
  className,
  ...props
}: ComponentProps<"div"> & {
  /** Names the group for assistive tech, e.g. "Folder actions" */
  "aria-label": string;
}) {
  return (
    <div
      role="group"
      data-slot="toolbar-group"
      className={cn(
        "inline-flex shrink-0 items-center rounded-full bg-foreground/5 outline-1 -outline-offset-1 outline-border",
        className,
      )}
      {...props}
    />
  );
}

type ToolbarGroupButtonProps = Omit<ComponentProps<"button">, "children"> & {
  icon: IconSvgElement;
  /** The button's name (aria-label) and tooltip */
  label: string;
  /** Shows the verb as on (a mode it turned on, an open menu) without changing its role */
  active?: boolean;
};

/**
 * An icon button inside a ToolbarGroup: 32px, 44px on touch, named by
 * `label`. Works as a menu trigger (`DropdownMenuTrigger asChild`): props and
 * the ref pass through, and an open menu shows on the button.
 */
export function ToolbarGroupButton({
  icon,
  label,
  active = false,
  className,
  type = "button",
  ...props
}: ToolbarGroupButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      data-slot="toolbar-group-button"
      data-active={active || undefined}
      className={cn(
        "flex h-8 min-w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none",
        "transition-[background-color,color] duration-150 ease-out",
        "hover:bg-foreground/8 hover:text-foreground",
        "data-[active]:bg-foreground/10 data-[active]:text-foreground data-[state=open]:bg-foreground/10 data-[state=open]:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-40",
        "phone-touch:h-11 phone-touch:min-w-11",
        className,
      )}
      {...props}
    >
      <HugeiconsIcon icon={icon} size={15} aria-hidden="true" />
    </button>
  );
}
