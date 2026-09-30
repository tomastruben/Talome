"use client";

import { useCallback, useMemo, useState } from "react";
import { ConfirmDialog as ConfirmDialogView, type ConfirmTier } from "@/components/ui/confirm-dialog";

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

interface PendingAction {
  options: ConfirmActionOptions;
  resolve: (confirmed: boolean) => void;
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
  const [pending, setPending] = useState<PendingAction | null>(null);

  const confirmAction = useCallback(
    (options: ConfirmActionOptions): Promise<boolean> => {
      if (canAutoConfirm(autoMode, options)) return Promise.resolve(true);

      return new Promise<boolean>((resolve) => {
        setPending({ options, resolve });
      });
    },
    [autoMode],
  );

  const settle = useCallback(
    (confirmed: boolean) => {
      pending?.resolve(confirmed);
      setPending(null);
    },
    [pending],
  );

  // Memoised on `pending` so the dialog keeps its identity (and does not
  // remount or replay its entrance) while the parent re-renders.
  const ConfirmDialog = useMemo(() => {
    function PendingConfirmDialog() {
      if (!pending) return null;

      const { options } = pending;

      return (
        <ConfirmDialogView
          open
          tier={confirmTierOf(options)}
          title={options.title}
          consequence={options.description}
          recovery={options.recovery ?? ""}
          irreversible={options.irreversible}
          confirmLabel={options.confirmLabel ?? "Confirm"}
          cancelLabel={options.cancelLabel}
          onResult={(result) => settle(result.confirmed)}
        />
      );
    }
    return PendingConfirmDialog;
  }, [pending, settle]);

  return { confirmAction, ConfirmDialog };
}
