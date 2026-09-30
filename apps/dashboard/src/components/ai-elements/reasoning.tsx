"use client";

import { useEffect, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { HugeiconsIcon, ArrowDown01Icon } from "@/components/icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Shimmer } from "@/components/ai-elements/shimmer";

export interface ReasoningProps {
  text: string;
  streaming: boolean;
}

function formatThoughtFor(ms: number | null): string {
  if (ms === null) return "Thought";
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `Thought for ${seconds}s` : `Thought for ${Math.round(seconds / 60)}m`;
}

/**
 * The model's reasoning, quiet by default: an orb and "Thinking" while it
 * streams, then a one-line "Thought for 4s" you can open.
 */
export function Reasoning({ text, streaming }: ReasoningProps) {
  const startedAt = useRef<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (streaming) {
      startedAt.current ??= Date.now();
    } else if (startedAt.current !== null) {
      // Only measured when we saw it stream; history just says "Thought"
      const elapsed = Date.now() - startedAt.current;
      startedAt.current = null;
      setDuration(elapsed);
    }
  }, [streaming]);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="not-prose mb-2">
      <CollapsibleTrigger className="group/reasoning flex items-center gap-2 py-1 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground">
        {streaming ? (
          <>
            <ThinkingOrb state="solving" size={20} aria-hidden />
            <Shimmer as="span" className="text-sm" duration={1.8}>
              Thinking
            </Shimmer>
          </>
        ) : (
          <span>{formatThoughtFor(duration)}</span>
        )}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={12}
          className="transition-transform duration-150 group-data-[state=open]/reasoning:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0">
        <p className="mt-1 whitespace-pre-wrap border-l border-border pl-3 text-sm text-muted-foreground">
          {text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
