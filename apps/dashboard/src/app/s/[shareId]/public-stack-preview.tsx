"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon, Copy01Icon, Package01Icon, Tick01Icon } from "@/components/icons";
import type { PublicStackData } from "./page";

function TalomeMark() {
  return (
    <div className="size-10 rounded-full bg-foreground/[0.06] flex items-center justify-center">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-muted-foreground" aria-hidden="true">
        <circle cx="12" cy="4.5" r="1.7"/><circle cx="17.1" cy="7" r="1.27" opacity=".56"/><circle cx="6.5" cy="12" r="1.27" opacity=".56"/><circle cx="12" cy="14.5" r="1.7"/><circle cx="17.5" cy="17" r="1.27" opacity=".56"/><circle cx="6.5" cy="7" r="1.27" opacity=".56"/><circle cx="12" cy="9.5" r="1.7"/><circle cx="17.5" cy="12" r="1.27" opacity=".56"/><circle cx="6.5" cy="17" r="1.27" opacity=".56"/><circle cx="12" cy="19.5" r="1.7"/>
      </svg>
    </div>
  );
}

export function PublicStackPreview({
  shareId,
  stack,
}: {
  shareId: string;
  stack: PublicStackData | null;
}) {
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function copyImportCode() {
    setCopying(true);
    setError("");
    try {
      const response = await fetch(`/api/stacks/public/${encodeURIComponent(shareId)}/code`);
      const data = await response.json() as { shareCode?: string; error?: string };
      if (!response.ok || !data.shareCode) throw new Error(data.error ?? "Could not retrieve this stack");
      await navigator.clipboard.writeText(data.shareCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "Clipboard unavailable");
    } finally {
      setCopying(false);
    }
  }

  if (!stack) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-sm text-center grid justify-items-center gap-4">
          <TalomeMark />
          <div>
            <h1 className="text-lg font-medium">Shared stack unavailable</h1>
            <p className="text-sm text-muted-foreground mt-1">The link may have expired or been removed by its owner.</p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:py-14">
      <div className="mx-auto w-full max-w-2xl">
        <header className="flex items-center gap-3 mb-10">
          <TalomeMark />
          <div>
            <p className="text-sm font-medium">Talome</p>
            <p className="text-xs text-muted-foreground">A shared server setup</p>
          </div>
        </header>

        <section className="rounded-3xl border border-border bg-card/60 p-5 sm:p-8">
          <div className="flex flex-wrap gap-2 mb-4">
            {stack.tags.slice(0, 4).map((tag) => (
              <span key={tag} className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">{tag}</span>
            ))}
          </div>
          <h1 className="text-2xl sm:text-3xl font-medium tracking-tight">{stack.name}</h1>
          <p className="text-sm sm:text-base text-muted-foreground mt-3 leading-relaxed">{stack.description}</p>
          <p className="text-xs text-muted-foreground mt-4">Shared by {stack.author} · {stack.appCount} app{stack.appCount === 1 ? "" : "s"}</p>

          <div className="mt-7 divide-y divide-border/70 rounded-2xl border border-border overflow-hidden">
            {stack.apps.map((app) => (
              <div key={app.appId} className="flex items-center gap-3 bg-background/40 px-4 py-3.5">
                <span className="size-9 rounded-xl bg-muted/60 flex items-center justify-center shrink-0">
                  <HugeiconsIcon icon={Package01Icon} size={17} className="text-muted-foreground" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{app.name}</p>
                  {app.description && <p className="text-xs text-muted-foreground truncate mt-0.5">{app.description}</p>}
                </div>
                {app.requiredInputCount > 0 && (
                  <span className="text-xs text-muted-foreground shrink-0">{app.requiredInputCount} input{app.requiredInputCount === 1 ? "" : "s"}</span>
                )}
              </div>
            ))}
          </div>

          <div className="mt-7 flex flex-col sm:flex-row sm:items-center gap-3">
            <Button onClick={() => void copyImportCode()} disabled={copying} className="rounded-full gap-2 px-5">
              <HugeiconsIcon icon={copied ? Tick01Icon : Copy01Icon} size={15} />
              {copying ? "Preparing..." : copied ? "Import code copied" : "Copy import code"}
            </Button>
            <p className="text-xs text-muted-foreground leading-relaxed">
              In your Talome, open Settings → Export & Import, paste the code, and review before installing.
            </p>
          </div>
          {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        </section>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Secrets and personal configuration are never included in a shared stack.
        </p>
      </div>
    </main>
  );
}
