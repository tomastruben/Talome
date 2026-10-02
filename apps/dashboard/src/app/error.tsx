"use client";

import { ErrorState } from "@/components/ui/empty-state";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen flex-col p-6">
      <ErrorState
        fill
        title="Couldn't open Talome"
        description={
          error.digest
            ? `Something went wrong while showing this page (reference ${error.digest}). Retry, and if it keeps happening check that the Talome server is running.`
            : "Something went wrong while showing this page. Retry, and if it keeps happening check that the Talome server is running."
        }
        onRetry={reset}
      />
    </div>
  );
}
