"use client";

import { Button } from "@/components/ui/button";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="flex flex-col items-center gap-6">
        <p className="text-[8rem] leading-none font-normal tracking-tight text-dim-foreground select-none">
          Error
        </p>
        <p className="text-base text-muted-foreground max-w-xs text-center">
          {error.digest
            ? `Something went wrong (${error.digest})`
            : "Something went wrong."}
        </p>
        <Button variant="secondary" size="sm" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
