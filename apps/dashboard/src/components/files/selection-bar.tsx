"use client";

import { useId, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { HugeiconsIcon, type IconSvgElement } from "@/components/icons";
import { DURATION, TRAVEL, enter, exit } from "@/lib/motion";
import { cn } from "@/lib/utils";

const countFormat = new Intl.NumberFormat();

interface SelectionBarProps {
  /** How many items are selected; the bar shows while this is above zero (unless `open` says otherwise) */
  count: number;
  /** Override when the bar shows, e.g. only in a selection mode */
  open?: boolean;
  /**
   * Where the bar floats. Files anchors it above its status bar
   * (`absolute inset-x-0 bottom-full mb-3`); a page can float it over the
   * viewport (`fixed inset-x-0 bottom-6 pb-[env(safe-area-inset-bottom)]`).
   */
  className?: string;
  /** The verbs for the selection: <SelectionBarButton>s */
  children: ReactNode;
}

/**
 * The floating selection bar (Files, and any list with a multi-select): an
 * inverted pill with the count and the verbs for what is selected. Inverted
 * means `bg-foreground text-background` in both themes, so the pill reads the
 * same over a list, artwork or window glass; status text on it uses the
 * `-inverse` tokens (design-contrast.test.tsx checks both themes).
 *
 * Labels sit beside their icons where the column is at least `@md` wide and
 * become screen-reader names below that, so a phone gets icon buttons that
 * are still named. On touch every button is 44px tall.
 */
export function SelectionBar({ count, open = count > 0, className, children }: SelectionBarProps) {
  const countId = useId();
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: TRAVEL.lift }}
          animate={{ opacity: 1, y: 0, transition: enter(DURATION.pill) }}
          exit={{ opacity: 0, y: TRAVEL.rise, transition: exit(DURATION.exitFast) }}
          className={cn("pointer-events-none z-20 flex justify-center", className)}
        >
          <div
            role="group"
            aria-labelledby={countId}
            data-selection-bar=""
            className="pointer-events-auto flex items-center gap-1 rounded-full bg-foreground py-2 pr-2 pl-4 text-background shadow-lg phone-touch:py-1 phone-touch:pr-1"
          >
            <span id={countId} className="text-sm font-medium whitespace-nowrap tabular-nums">
              {countFormat.format(count)} selected
            </span>
            <span aria-hidden="true" className="mx-1 h-4 w-px bg-background/15" />
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface SelectionBarButtonProps {
  icon: IconSvgElement;
  /** The verb: visible from `@md`, the button's accessible name below it */
  label: string;
  /** "critical" for a destructive verb (Delete, Remove) */
  tone?: "default" | "critical";
  onClick: () => void;
}

export function SelectionBarButton({ icon, label, tone = "default", onClick }: SelectionBarButtonProps) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center justify-center gap-1.5 rounded-full px-2.5 text-xs transition-colors duration-150 hover:bg-background/10",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-background",
        "phone-touch:h-11 phone-touch:min-w-11 phone-touch:px-3",
        tone === "critical" ? "text-status-critical-inverse" : "text-background/70 hover:text-background",
      )}
    >
      <HugeiconsIcon icon={icon} size={14} aria-hidden="true" />
      <span className="sr-only @md:not-sr-only">{label}</span>
    </button>
  );
}
