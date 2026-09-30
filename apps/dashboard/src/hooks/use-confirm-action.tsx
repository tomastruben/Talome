"use client";

import { useCallback, useMemo, useState } from "react";
import { ConfirmQueue, createConfirmStore, type ConfirmTier } from "@/components/ui/confirm-dialog";

export interface ConfirmActionOptions {
  title: string;
  /** What will happen. Rendered as the consequence line. */
  description: string;
  /** What is kept and how to undo. Recommended for every new caller. */
  recovery?: string;
  /** Set when nothing is kept, so the recovery line warns instead of reassuring. */
  irreversible?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `destructive` = data loss, irreversible, or widened privilege. Maps to the `destructive` tier. */
  variant?: "default" | "destructive";
  /** Explicit tier; wins over `variant`. */
  tier?: ConfirmTier;
}

export function confirmTierOf(options: Pick<ConfirmActionOptions, "tier" | "variant">): ConfirmTier {
  if (options.tier) return options.tier;
  return options.variant === "destructive" ? "destructive" : "soft";
}

/**
 * Whether Auto mode may skip this confirmation. Only the `soft` tier can be
 * skipped; data loss, irreversible changes and widened privilege are always
 * confirmed by a person (P0-2).
 */
export function canAutoConfirm(autoMode: boolean, options: Pick<ConfirmActionOptions, "tier" | "variant">): boolean {
  return autoMode && confirmTierOf(options) === "soft";
}

/**
 * Confirms an action before it runs.
 *
 * When `autoMode` is true, `soft` confirmations resolve immediately; a
 * `destructive` one still opens the dialog. Returns `confirmAction` and a
 * `ConfirmDialog` element-component to render.
 *
 * New code should prefer `useConfirm()` from `@/components/ui/confirm-dialog`,
 * which takes explicit consequence and recovery lines.
 */
export function useConfirmAction(autoMode: boolean) {
  // Each caller keeps its own queue, rendered by its own <ConfirmDialog />.
  // A decided dialog stays mounted (closed) for its exit animation.
  const [store] = useState(() => createConfirmStore({ requireHost: false }));

  const confirmAction = useCallback(
    (options: ConfirmActionOptions): Promise<boolean> => {
      if (canAutoConfirm(autoMode, options)) return Promise.resolve(true);

      return store
        .request({
          tier: confirmTierOf(options),
          title: options.title,
          consequence: options.description,
          recovery: options.recovery ?? "",
          irreversible: options.irreversible,
          confirmLabel: options.confirmLabel ?? "Confirm",
          cancelLabel: options.cancelLabel,
        })
        .then((result) => result.confirmed);
    },
    [autoMode, store],
  );

  // Stable identity: the element-component never remounts, so the dialog
  // keeps its state and plays its exit instead of vanishing.
  const ConfirmDialog = useMemo(() => {
    function PendingConfirmDialog() {
      return <ConfirmQueue store={store} />;
    }
    return PendingConfirmDialog;
  }, [store]);

  return { confirmAction, ConfirmDialog };
}
