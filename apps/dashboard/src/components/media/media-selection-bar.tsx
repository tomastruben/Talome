"use client";

import { Cancel01Icon, Delete01Icon } from "@/components/icons";
import { SelectionBar, SelectionBarButton } from "@/components/files/selection-bar";

/**
 * Where the bar floats:
 * - "status-bar": in a desktop window it renders inside Media's status bar
 *   (which is `relative`) and floats 12px above it, centred on the content
 *   column, so it never covers the count or reaches over the sidebar.
 * - "viewport": on the classic page it floats over the bottom of the screen,
 *   clear of the home indicator.
 */
export type MediaSelectionBarAnchor = "status-bar" | "viewport";

const ANCHOR_CLASS: Record<MediaSelectionBarAnchor, string> = {
  "status-bar": "absolute inset-x-0 bottom-full mb-3",
  viewport: "fixed inset-x-0 bottom-6 z-50 pb-[env(safe-area-inset-bottom)]",
};

/**
 * The floating bar for a multi-selection of library titles, built from the
 * same parts as the Files selection bar: an inverted pill whose Remove uses
 * the inverse critical token (4.5:1 on the pill in both themes), labels that
 * become the buttons' names where the column is narrow (never display:none),
 * and 44px targets on touch. Shows while `count` is above zero.
 */
export function MediaSelectionBar({
  count,
  anchor,
  onRemove,
  onCancel,
}: {
  count: number;
  anchor: MediaSelectionBarAnchor;
  onRemove: () => void;
  onCancel: () => void;
}) {
  return (
    <SelectionBar count={count} className={ANCHOR_CLASS[anchor]}>
      <SelectionBarButton icon={Delete01Icon} label="Remove" tone="critical" onClick={onRemove} />
      <SelectionBarButton icon={Cancel01Icon} label="Cancel" onClick={onCancel} />
    </SelectionBar>
  );
}
