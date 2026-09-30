"use client";

import { useEffect, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";

import { MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { ArrowDown01Icon, HugeiconsIcon } from "@/components/icons";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface ReasoningSummaryProps {
  text: string;
  state?: "streaming" | "done";
  isMessageStreaming?: boolean;
}

function formatThoughtFor(ms: number | null): string {
  if (ms === null) return "Thought";
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `Thought for ${seconds}s` : `Thought for ${Math.round(seconds / 60)}m`;
}

/**
 * The provider-supplied reasoning summary, quiet by default: an orb and
 * "Thinking" while it streams, then a one-line "Thought for 4s" you can open.
 *
 * It never exposes private model state. Older messages whose provider only
 * persisted encrypted reasoning metadata keep an honest, non-expandable row
 * ("no summary was provided") instead of an empty disclosure.
 *
 * The orb renders a single static frame under reduced motion (thinking-orbs
 * checks prefers-reduced-motion itself) and the shimmer is static text there.
 */
export function ReasoningSummary({
  text,
  state,
  isMessageStreaming = false,
}: ReasoningSummaryProps) {
  const summary = text.trim();
  const hasSummary = summary.length > 0;
  const isThinking = state === "streaming" || (isMessageStreaming && state !== "done");
  const startedAt = useRef<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (isThinking) {
      startedAt.current ??= Date.now();
    } else if (startedAt.current !== null) {
      // Only measured when we saw it stream; history just says "Thought".
      const elapsed = Date.now() - startedAt.current;
      startedAt.current = null;
      setDuration(elapsed);
    }
  }, [isThinking]);

  const doneLabel = hasSummary
    ? formatThoughtFor(duration)
    : `${formatThoughtFor(duration)} · no summary was provided`;

  return (
    <Collapsible
      open={hasSummary ? open : false}
      onOpenChange={setOpen}
      className="not-prose mb-2"
    >
      <CollapsibleTrigger
        className={cn(
          "group/reasoning flex items-center gap-2 rounded-sm py-1 text-sm text-muted-foreground transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          hasSummary ? "hover:text-foreground" : "cursor-default",
        )}
        disabled={!hasSummary}
        aria-label={hasSummary ? "Toggle reasoning summary" : "Reasoning status"}
      >
        {isThinking ? (
          <>
            <ThinkingOrb state="solving" size={20} aria-hidden />
            <Shimmer as="span" className="text-sm" duration={1.8}>
              Thinking
            </Shimmer>
          </>
        ) : (
          <span>{doneLabel}</span>
        )}
        {hasSummary && (
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={12}
            className="transition-transform duration-150 group-data-[state=open]/reasoning:rotate-180"
          />
        )}
      </CollapsibleTrigger>
      {hasSummary && (
        <CollapsibleContent className="data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0">
          <div className="mt-1 border-l border-border pl-3 text-sm leading-relaxed text-muted-foreground">
            <MessageResponse className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              {summary}
            </MessageResponse>
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
