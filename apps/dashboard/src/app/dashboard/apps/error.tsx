"use client";

import { Button } from "@/components/ui/button";

export default function AppsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-[60vh]">
      <div className="flex flex-col items-center gap-6">
        <p className="text-[8rem] leading-none font-normal tracking-tight text-dim-foreground select-none">
          Error
        </p>
        <p className="text-base text-muted-foreground max-w-xs text-center">
          Could not load the app store.
        </p>
        <p className="text-sm text-muted-foreground max-w-sm text-center">
          {error.message}
        </p>
        <Button variant="secondary" size="sm" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
