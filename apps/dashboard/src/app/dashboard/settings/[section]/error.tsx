"use client";

import { ErrorState } from "@/components/ui/empty-state";

export default function SettingsSectionError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ErrorState
        fill
        title="Couldn't open this setting"
        description="Something went wrong while showing this part of Settings. Retry, and if it keeps happening check that the Talome server is running."
        onRetry={reset}
      />
    </div>
  );
}
