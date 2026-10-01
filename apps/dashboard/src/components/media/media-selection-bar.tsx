"use client";

import { AnimatePresence, motion } from "motion/react";
import { Cancel01Icon, Delete01Icon, HugeiconsIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { enter } from "@/lib/motion";

const numberFormat = new Intl.NumberFormat();

/**
 * Remove and Cancel on the inverted pill. The ghost button's own hover fills
 * (accent, and accent/50 in dark) are replaced: they would paint a page grey
 * over the pill. On a phone the labels are visually hidden but still name the
 * buttons, and on touch each button is a 44px target.
 */
const BAR_BUTTON = "h-7 gap-1.5 px-2.5 text-xs hover:bg-background/10 dark:hover:bg-background/10 pointer-coarse:h-11 pointer-coarse:min-w-11";
const BAR_LABEL = "sr-only sm:not-sr-only";

/**
 * The floating bar for a multi-selection of library titles. Shows while
 * `count` is above zero; it keeps the last count while it fades out.
 */
export function MediaSelectionBar({
  count,
  onRemove,
  onCancel,
}: {
  count: number;
  onRemove: () => void;
  onCancel: () => void;
}) {
  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={enter()}
          className="fixed bottom-6 inset-x-0 z-50 flex justify-center pointer-events-none pb-[env(safe-area-inset-bottom)]"
        >
          <div
            data-media-selection-bar
            className="flex items-center gap-1 rounded-full bg-foreground text-background px-4 py-2 shadow-lg pointer-events-auto"
          >
            <span className="text-sm font-medium tabular-nums whitespace-nowrap">{numberFormat.format(count)} selected</span>
            <div aria-hidden="true" className="w-px h-4 bg-background/15 mx-1" />
            <Button
              variant="ghost"
              size="sm"
              // The inverse critical token reads at 4.5:1 on bg-foreground in both themes
              className={`${BAR_BUTTON} text-status-critical-inverse hover:text-status-critical-inverse`}
              onClick={onRemove}
            >
              <HugeiconsIcon icon={Delete01Icon} size={14} />
              <span className={BAR_LABEL}>Remove</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={`${BAR_BUTTON} text-background/70 hover:text-background`}
              onClick={onCancel}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={14} />
              <span className={BAR_LABEL}>Cancel</span>
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
