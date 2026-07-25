"use client";

import { useState } from "react";

import { MessageResponse } from "@/components/ai-elements/message";
import {
  AiBrain01Icon,
  AiIdeaIcon,
  ArrowDown01Icon,
  HugeiconsIcon,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

interface ReasoningSummaryProps {
  text: string;
  state?: "streaming" | "done";
  isMessageStreaming?: boolean;
}

/**
 * Shows the provider-supplied reasoning summary without exposing private model
 * state. The status row remains visible for older messages whose provider only
 * persisted encrypted reasoning metadata and no displayable summary.
 */
export function ReasoningSummary({
  text,
  state,
  isMessageStreaming = false,
}: ReasoningSummaryProps) {
  const summary = text.trim();
  const hasSummary = summary.length > 0;
  const isThinking = state === "streaming" || (isMessageStreaming && state !== "done");
  const [open, setOpen] = useState(true);

  return (
    <Collapsible
      className="group/reasoning not-prose mb-2 w-full rounded-xl border border-border/40 bg-card/20 backdrop-blur-sm"
      open={hasSummary ? isThinking || open : false}
      onOpenChange={setOpen}
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-3 px-3.5 py-3 text-left",
          !hasSummary && "cursor-default",
        )}
        disabled={!hasSummary}
        aria-label={hasSummary ? "Toggle reasoning summary" : "Reasoning status"}
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
          <HugeiconsIcon icon={isThinking ? AiIdeaIcon : AiBrain01Icon} size={18} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span
        className={cn(
          "text-sm font-medium leading-none",
          isThinking
            ? "shimmer shimmer-duration-1800 text-muted-foreground"
            : "text-foreground",
        )}
      >
            {isThinking ? "Thinking" : "Reasoning"}
          </span>
          <span className="text-xs text-muted-foreground">
            {isThinking
              ? "Working through the request"
              : hasSummary
                ? "Summary"
                : "Completed · no summary was provided"}
          </span>
        </div>

        <Badge
          variant="outline"
          className="h-6 border-border/50 bg-background/30 px-2 text-[11px] font-normal text-muted-foreground"
        >
          {isThinking ? (
            <>
              <Spinner className="size-3" />
              Live
            </>
          ) : (
            "Complete"
          )}
        </Badge>

        {hasSummary && (
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={14}
            className="shrink-0 text-dim-foreground transition-transform group-data-[state=open]/reasoning:rotate-180"
          />
        )}
      </CollapsibleTrigger>

      {hasSummary && (
        <CollapsibleContent>
          <div className="border-t border-border/30 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
            <MessageResponse className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              {summary}
            </MessageResponse>
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
