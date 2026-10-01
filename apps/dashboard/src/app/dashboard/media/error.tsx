"use client";

import { ErrorState } from "@/components/ui/empty-state";

export default function MediaError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ErrorState
        fill
        title="Couldn't show your media library"
        description="Something went wrong while showing Media. Retry, and if it keeps happening check that the Talome server is running."
        onRetry={reset}
      />
    </div>
  );
}
