import { toastWarning } from "@/lib/toast";
import type { DashboardModePreference } from "@/hooks/use-desktop-mode";

/**
 * Copy for a mode switch whose account save failed. The switch itself has
 * already happened in this browser, so say exactly that instead of staying
 * silent while other devices keep the old mode.
 */
export function modeSaveFailureMessage(mode: DashboardModePreference): string {
  return mode === "desktop"
    ? "Desktop mode saved on this browser only. Couldn't save it to your account."
    : "Classic layout saved on this browser only. Couldn't save it to your account.";
}

/** Reports a failed account save with Retry; a successful save stays quiet (the switch is the feedback). */
export function reportModeSave(
  saved: boolean,
  mode: DashboardModePreference,
  retry: () => void,
): void {
  if (saved) return;
  toastWarning(modeSaveFailureMessage(mode), { action: { label: "Retry", onClick: retry } });
}
