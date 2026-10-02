"use client";

import { ErrorState } from "@/components/ui/empty-state";

export default function FilesError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ErrorState
        fill
        title="Couldn't open Files"
        description="Something went wrong while showing Files. Retry, and if it keeps happening check that the Talome server is running."
        onRetry={reset}
      />
    </div>
  );
}
