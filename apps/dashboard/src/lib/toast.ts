import { toast } from "sonner";
import { UNDO_WINDOW_MS } from "@/lib/motion";

/** Toast durations (ms): success and info 4s, warning 6s, undo 6s. */
export const TOAST_DURATION = {
  success: 4000,
  info: 4000,
  warning: 6000,
  undo: UNDO_WINDOW_MS,
} as const;

type ToastMessage = Parameters<typeof toast.warning>[0];
type ToastData = Parameters<typeof toast.warning>[1];

/**
 * A warning toast that stays 6s (TOAST_DURATION.warning). Sonner has no
 * per-type duration and the Toaster's default is the success/info 4s, so
 * use this instead of `toast.warning()`. A caller's own `duration` wins.
 */
export function toastWarning(message: ToastMessage, data?: ToastData) {
  return toast.warning(message, { duration: TOAST_DURATION.warning, ...data });
}
