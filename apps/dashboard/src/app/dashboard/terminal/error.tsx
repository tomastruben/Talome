"use client";

import { ErrorState } from "@/components/ui/empty-state";

export default function TerminalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ErrorState
        fill
        title="Couldn't open the Terminal"
        description="Something went wrong while showing the Terminal. Your sessions keep running on the server. Retry, and if it keeps happening check that the Talome server is running."
        onRetry={reset}
      />
    </div>
  );
}
