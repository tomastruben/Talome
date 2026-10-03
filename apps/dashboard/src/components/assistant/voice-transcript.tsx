"use client";

import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { LiveTranscriptEntry } from "@/lib/live-transcript";
import { cn } from "@/lib/utils";

export function VoiceTranscript({ entries }: { entries: LiveTranscriptEntry[] }) {
  const root = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    const viewport = root.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (viewport && following.current) viewport.scrollTop = viewport.scrollHeight;
  }, [entries]);

  return (
    <div ref={root} className="relative min-h-0 w-full max-w-2xl flex-1" data-window-no-drag>
      <ScrollArea className="h-full" fadeEdges={false} onScrollCapture={(event) => {
        const viewport = event.target as HTMLElement;
        following.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48;
      }}>
        <section aria-label="Conversation transcript" className="flex flex-col gap-6 p-6">
          {entries.length === 0 && <p className="text-center text-sm text-muted-foreground">Your conversation will appear here.</p>}
          {entries.map((entry) => (
            <div key={entry.id} className={cn("flex max-w-full flex-col gap-2", entry.role === "user" ? "items-end self-end" : "items-start self-start")}>
              <span className="sr-only">{entry.role === "user" ? "You" : "Talome"}</span>
              <p className={cn("max-w-full whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-base leading-relaxed [overflow-wrap:anywhere]", entry.role === "user" ? "bg-muted/60 text-foreground" : "bg-card/60 text-card-foreground")}>
                {entry.text}
              </p>
            </div>
          ))}
        </section>
      </ScrollArea>
    </div>
  );
}
