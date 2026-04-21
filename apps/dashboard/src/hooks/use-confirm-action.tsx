"use client";

import { useCallback, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmActionOptions {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
}

interface PendingAction {
  options: ConfirmActionOptions;
  resolve: (confirmed: boolean) => void;
}

/**
 * Hook for confirming destructive actions.
 *
 * When `autoMode` is true, actions are confirmed automatically without dialog.
 * Returns a `confirmAction` function and a `ConfirmDialog` component to render.
 */
export function useConfirmAction(autoMode: boolean) {
  const [pending, setPending] = useState<PendingAction | null>(null);

  const confirmAction = useCallback(
    (options: ConfirmActionOptions): Promise<boolean> => {
      if (autoMode) return Promise.resolve(true);

      return new Promise<boolean>((resolve) => {
        setPending({ options, resolve });
      });
    },
    [autoMode],
  );

  const handleConfirm = useCallback(() => {
    pending?.resolve(true);
    setPending(null);
  }, [pending]);

  const handleCancel = useCallback(() => {
    pending?.resolve(false);
    setPending(null);
  }, [pending]);

  function ConfirmDialog() {
    if (!pending) return null;

    const { options } = pending;
    const isDestructive = options.variant === "destructive";

    return (
      <Dialog open onOpenChange={(open) => { if (!open) handleCancel(); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">{options.title}</DialogTitle>
            <DialogDescription>{options.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={handleCancel}>
              {options.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={isDestructive ? "destructive" : "default"}
              size="sm"
              onClick={handleConfirm}
            >
              {options.confirmLabel ?? "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return { confirmAction, ConfirmDialog };
}
