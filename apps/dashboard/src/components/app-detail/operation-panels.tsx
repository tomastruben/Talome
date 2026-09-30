"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HugeiconsIcon, ArrowDown01Icon, ArrowRight01Icon, AiChat02Icon, Cancel01Icon, AlertCircleIcon, Alert02Icon } from "@/components/icons";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  RETRYABLE_KINDS,
  operationFailureCopy,
  operationFixPrompt,
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
        className={cn("h-1.5", failed && "[&>div]:bg-status-critical")}
        aria-label={`${OPERATION_KIND_LABELS[operation.kind]} progress`}
      />
      <p className={cn("text-xs break-words", failed ? "text-status-critical" : "text-muted-foreground")}>
        {detail ? detail : `Started by ${operationActorLabel(operation.actor)} ${relativeTime(operation.startedAt)}`}
      </p>
    </div>
  );
}

/**
 * A failed, interrupted or rolled-back lifecycle operation, kept in the app's
 * primary slot until the person retries, dismisses it, or the app moves on
 * (design P0-11). Rolled back is a warning: the app runs its previous version.
 * For an installed app it sits above Open / Start, never in place of them.
 * The actions are Retry (primary, when the kind can simply run again), Ask
 * Talome (the Assistant, with the step and error), View log (the journal
 * entry) and Dismiss. Only a failure that arrived while the page was open is
 * an alert (`announce`); one found on arrival is a quiet status.
 */
export function OperationFailure({
  operation,
  appName,
  onRetry,
  retryBusy = false,
  canAskTalome = true,
  announce = false,
  subordinate = false,
  onDismiss,
  className,
}: {
  operation: LiveOperation;
  appName: string;
  /** Run the same action again. Omitted (or a non-lifecycle kind) hides Retry. */
  onRetry?: () => void;
  retryBusy?: boolean;
  canAskTalome?: boolean;
  /** The failure arrived during this visit: announce it as an alert. */
  announce?: boolean;
  /** Sits above the app's own primary action (Open / Start): Retry is not the primary button. */
  subordinate?: boolean;
  onDismiss: () => void;
  className?: string;
}) {
  const [logOpen, setLogOpen] = useState(false);
  const logId = useId();
  const copy = operationFailureCopy(operation, appName);
  const warning = copy.tone === "warning";
  const canRetry = !!onRetry && RETRYABLE_KINDS.has(operation.kind);
  const askHref = `/dashboard/assistant?prompt=${encodeURIComponent(operationFixPrompt(operation, appName))}`;
  const finishedAt = operation.updatedAt || operation.startedAt;

  return (
    <div data-slot="operation-failure" data-tone={copy.tone} className={cn("w-full grid gap-2 text-left", className)}>
      <div role={announce ? "alert" : "status"} className="grid gap-2">
        <div className="flex items-start justify-between gap-3">
          <p className="flex items-start gap-2 text-sm font-medium">
            <HugeiconsIcon
              icon={warning ? Alert02Icon : AlertCircleIcon}
              size={16}
              strokeWidth={1.5}
              aria-hidden="true"
              className={cn("mt-0.5 shrink-0", warning ? "text-status-warning" : "text-status-critical")}
            />
            <span>{copy.title}</span>
          </p>
          <Button
            variant="ghost"
            size="icon-xs"
            className="-mr-1 shrink-0 text-muted-foreground"
            onClick={onDismiss}
            aria-label="Dismiss"
            title="Dismiss"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} />
          </Button>
        </div>
        {!warning && (
          <Progress
            value={operation.progress}
            className="h-1.5 [&>div]:bg-status-critical"
            aria-label={`${OPERATION_KIND_LABELS[operation.kind]} stopped at ${operation.progress}%`}
          />
        )}
        <p className="text-xs text-muted-foreground break-words">{copy.detail}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {canRetry && (
          <Button size="sm" variant={subordinate ? "outline" : "default"} onClick={onRetry} busy={retryBusy} busyLabel={`Retrying ${appName}…`}>
            Retry
          </Button>
        )}
        {canAskTalome && (
          <Button size="sm" variant="outline" asChild>
            <Link href={askHref}>
              <HugeiconsIcon icon={AiChat02Icon} size={14} />
              Ask Talome
            </Link>
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={logOpen}
          aria-controls={logId}
          onClick={() => setLogOpen((open) => !open)}
        >
          {logOpen ? "Hide log" : "View log"}
        </Button>
      </div>
      {logOpen && (
        <dl id={logId} className="grid gap-1 rounded-lg border border-border bg-muted/30 p-3 text-xs">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Stopped at</dt>
            <dd className="text-right">{operationStepLabel(operation.step)} · <span className="tabular-nums">{operation.progress}%</span></dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Started</dt>
            <dd className="text-right">{relativeTime(operation.startedAt)} by {operationActorLabel(operation.actor)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Ended</dt>
            <dd className="text-right">
              <time dateTime={finishedAt} title={new Date(finishedAt).toLocaleString()}>{relativeTime(finishedAt)}</time>
            </dd>
          </div>
          {operation.error && (
            <div className="grid gap-1 pt-1">
              <dt className="text-muted-foreground">Error</dt>
              <dd>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">{operation.error}</pre>
              </dd>
            </div>
          )}
          <div className="flex justify-between gap-3 pt-1">
            <dt className="text-muted-foreground">Operation</dt>
            <dd className="font-mono text-right text-muted-foreground break-all">{operation.operationId}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function HistoryRow({ op }: { op: OperationRecord }) {
  const active = isActiveOperationStatus(op.status);
  const tone = active ? "muted" : operationStatusTone(op.status);
  return (
    <div className="px-4 py-3 grid gap-0.5">
      <div className="flex items-center gap-2.5">
        <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone], active && "motion-safe:animate-pulse")} aria-hidden />
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
      <h2 className="text-sm font-medium text-muted-foreground">Activity</h2>
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
