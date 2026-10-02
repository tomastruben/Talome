"use client";

import { ErrorState } from "@/components/ui/empty-state";

export default function ContainersError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ErrorState
        fill
        title="Couldn't open Containers"
        description="Something went wrong while showing Containers. Retry, and if it keeps happening check that Docker and the Talome server are running."
        onRetry={reset}
      />
    </div>
  );
}
