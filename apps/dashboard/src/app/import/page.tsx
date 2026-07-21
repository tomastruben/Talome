"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { HugeiconsIcon, AlertCircleIcon, Layers01Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  capsuleFromFragment,
  PENDING_STACK_IMPORT_KEY,
  STACK_IMPORT_DESTINATION,
} from "@/lib/stack-import-bridge";

export default function StackImportBridgePage() {
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const fail = (message: string) => {
      queueMicrotask(() => {
        if (active) setError(message);
      });
    };
    const capsule = capsuleFromFragment(window.location.hash);
    if (!capsule) {
      fail("This link does not contain a valid Talome stack capsule.");
      return () => { active = false; };
    }

    try {
      sessionStorage.setItem(PENDING_STACK_IMPORT_KEY, capsule);
      window.history.replaceState(null, "", "/import");
      window.location.replace(STACK_IMPORT_DESTINATION);
    } catch {
      fail("This browser could not preserve the stack for import. Copy the capsule code instead.");
    }
    return () => { active = false; };
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <section className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-xl bg-muted/50">
          <HugeiconsIcon icon={error ? AlertCircleIcon : Layers01Icon} size={18} className={error ? "text-destructive" : "text-muted-foreground"} />
        </div>
        <h1 className="mt-4 text-lg font-medium">{error ? "Stack import unavailable" : "Preparing your stack"}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {error || "The capsule is staying in this browser while Talome opens. The sender does not need to be reachable."}
        </p>
        {error && (
          <Button asChild variant="outline" className="mt-5 rounded-full">
            <Link href="/login">Open Talome</Link>
          </Button>
        )}
      </section>
    </main>
  );
}
