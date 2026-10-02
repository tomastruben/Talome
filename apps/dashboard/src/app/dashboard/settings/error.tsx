"use client";

import { ErrorState } from "@/components/ui/empty-state";

/**
 * Renders inside the Settings layout, so in a two-pane window or page the
 * sections sidebar stays usable beside it.
 */
export default function SettingsError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ErrorState
        fill
        title="Couldn't open Settings"
        description="Something went wrong while showing Settings. Retry, and if it keeps happening check that the Talome server is running."
        onRetry={reset}
      />
    </div>
  );
}
