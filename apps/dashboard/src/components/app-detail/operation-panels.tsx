"use client";

import { useState } from "react";
import { Progress } from "@/components/ui/progress";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HugeiconsIcon, ArrowDown01Icon, ArrowRight01Icon } from "@/components/icons";
import { relativeTime } from "@/components/settings/settings-primitives";
import { cn } from "@/lib/utils";
import {
  OPERATION_KIND_LABELS,
  OPERATION_KIND_PROGRESS_LABELS,
  OPERATION_STATUS_LABELS,
  isActiveOperationStatus,
  operationActorLabel,
  operationStatusTone,
  operationStepLabel,
  type LiveOperation,
  type OperationRecord,
  type UpdateResultSummary,
} from "@/lib/app-operations";
import { TONE_DOT, TONE_TEXT } from "./tone";

/**
 * The app's running operation with its real step and progress from the
 * operations journal — no simulated percentages.
 */
export function OperationProgress({ operation, className }: { operation: LiveOperation; className?: string }) {
  const failed = operation.status === "failed" || operation.status === "interrupted";
  const detail = operation.error && failed ? operation.error : operation.message;
  return (
    <div className={cn("w-full grid gap-2", className)} aria-live="polite">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium truncate">
          {OPERATION_KIND_PROGRESS_LABELS[operation.kind]}
          <span className="text-muted-foreground font-normal"> · {operationStepLabel(operation.step)}</span>
        </span>
        <span className="text-xs text-muted-foreground tabular-nums shrink-0">{operation.progress}%</span>
      </div>
      <Progress
        value={operation.progress}
        className={cn("h-1.5", failed && "[&>div]:bg-destructive")}
        aria-label={`${OPERATION_KIND_LABELS[operation.kind]} progress`}
      />
      <p className={cn("text-xs break-words", failed ? "text-destructive" : "text-muted-foreground")}>
        {detail ? detail : `Started by ${operationActorLabel(operation.actor)} ${relativeTime(operation.startedAt)}`}
      </p>
    </div>
  );
}

function HistoryRow({ op }: { op: OperationRecord }) {
  const active = isActiveOperationStatus(op.status);
  const tone = active ? "muted" : operationStatusTone(op.status);
  return (
    <div className="px-4 py-3 grid gap-0.5">
      <div className="flex items-center gap-2.5">
        <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone], active && "animate-pulse")} aria-hidden />
        <p className="flex-1 min-w-0 text-sm truncate">{OPERATION_KIND_LABELS[op.kind]}</p>
        <span className={cn("shrink-0 text-xs", TONE_TEXT[tone])}>
          {active ? `${operationStepLabel(op.step)} · ${op.progress}%` : OPERATION_STATUS_LABELS[op.status]}
        </span>
      </div>
      <p className="pl-4 text-xs text-muted-foreground">
        {relativeTime(op.startedAt)} · by {operationActorLabel(op.actor)}
      </p>
      {op.error && !active && (
        <p className="pl-4 text-xs text-muted-foreground break-words line-clamp-3" title={op.error}>
          {op.error}
        </p>
      )}
    </div>
  );
}

/**
 * Last update result (success / rolled back with reason / failed) and a
 * collapsible list of recent operations from the journal.
 */
export function OperationActivity({
  lastUpdate,
  history,
}: {
  lastUpdate: UpdateResultSummary | null;
  history: readonly OperationRecord[];
}) {
  const [open, setOpen] = useState(false);
  if (!lastUpdate && history.length === 0) return null;

  return (
    <section className="grid gap-2">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Activity</h2>
      <div className="rounded-xl border border-border divide-y divide-border">
        {lastUpdate && (
          <div className="px-4 py-3 grid gap-0.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">Last update</span>
              <span className={cn("text-sm font-medium text-right", TONE_TEXT[lastUpdate.tone])}>{lastUpdate.title}</span>
            </div>
            <p className="text-xs text-muted-foreground text-right">{relativeTime(lastUpdate.at)}</p>
            {lastUpdate.detail && (
              <p className="text-xs text-muted-foreground break-words">{lastUpdate.detail}</p>
            )}
          </div>
        )}
        {history.length > 0 && (
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="w-full flex items-center gap-2 px-4 py-2.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={12} />
                Recent operations
                <span className="tabular-nums">{history.length}</span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="divide-y divide-border border-t border-border">
                {history.map((op) => (
                  <HistoryRow key={op.id} op={op} />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </section>
  );
}
