"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { HugeiconsIcon, SecurityCheckIcon, Clock01Icon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow, relativeTime } from "@/components/settings/settings-primitives";
import { APPROVALS_URL, decideApproval, trustFetcher, useNow, usePendingApprovals } from "@/components/trust/api";
import { useSecurityProfile } from "@/components/settings/autonomy";
import { AlertCircleIcon } from "@/components/icons";
import {
  actorDisplay,
  approvalStatusLabel,
  effectiveApprovalStatus,
  formatTimeLeft,
  humanToolName,
  livePending,
  msUntil,
  sourceLabel,
  type ApprovalItem,
} from "@/components/trust/format";

function GroupHeader({ children }: { children: React.ReactNode }) {
  return (
    <SettingsRow className="py-2.5">
      <p className="flex-1 text-xs font-medium text-muted-foreground">{children}</p>
    </SettingsRow>
  );
}

function PendingRow({
  item,
  now,
  highlighted,
  primary,
  onDecided,
}: {
  item: ApprovalItem;
  now: number;
  highlighted: boolean;
  /** Only the oldest waiting request gets the primary Approve button. */
  primary: boolean;
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const left = msUntil(item.expiresAt, now);

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlighted]);

  const decide = async (decision: "approve" | "deny") => {
    setBusy(decision);
    try {
      await decideApproval(item.id, decision);
      toast.success(decision === "approve" ? `Approved ${humanToolName(item.tool)}. The agent can run it once.` : `Denied ${humanToolName(item.tool)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't record your decision. Try again.");
    } finally {
      setBusy(null);
      onDecided();
    }
  };

  return (
    <div
      ref={ref}
      className={cn(
        "px-4 py-4 grid gap-3 transition-colors duration-150 ease-out",
        highlighted && "bg-foreground/[0.04] ring-1 ring-inset ring-foreground/20",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{humanToolName(item.tool)}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {actorDisplay(item.actor.kind, item.actor.label)}
            {item.source && ` · ${sourceLabel(item.source)}`}
            {` · ${relativeTime(item.createdAt)}`}
          </p>
        </div>
        <span
          className={cn(
            "flex items-center gap-1 text-xs tabular-nums shrink-0",
            left < 120_000 ? "text-status-warning" : "text-muted-foreground",
          )}
        >
          <HugeiconsIcon icon={Clock01Icon} size={12} />
          {formatTimeLeft(item.expiresAt, now)}
        </span>
      </div>
      {item.summary && <p className="text-sm text-muted-foreground leading-relaxed">{item.summary}</p>}
      {item.argsPreview && (
        <pre className="text-xs font-mono bg-muted/40 rounded-lg border border-border px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all max-h-40">
          {item.argsPreview}
        </pre>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={left <= 0 || busy === "approve"}
          busy={busy === "deny"}
          busyLabel="Denying…"
          onClick={() => void decide("deny")}
        >
          Deny
        </Button>
        <Button
          size="sm"
          variant={primary ? "default" : "outline"}
          disabled={left <= 0 || busy === "deny"}
          busy={busy === "approve"}
          busyLabel="Approving…"
          onClick={() => void decide("approve")}
        >
          Approve
        </Button>
      </div>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  approved: "text-status-healthy",
  consumed: "text-status-healthy",
  denied: "text-status-critical",
  expired: "text-muted-foreground",
  pending: "text-status-warning",
};

function DecisionRow({ item, highlighted }: { item: ApprovalItem; highlighted: boolean }) {
  const when = item.decidedAt ?? item.createdAt;
  const status = effectiveApprovalStatus(item);
  return (
    <SettingsRow className={cn(highlighted && "bg-foreground/[0.04]")}>
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">{humanToolName(item.tool)}</p>
        <p className="text-xs text-muted-foreground mt-0.5 truncate">
          {actorDisplay(item.actor.kind, item.actor.label)}
          {item.decidedBy && ` · by ${item.decidedBy}`}
          {` · ${relativeTime(when)}`}
        </p>
      </div>
      <span className={cn("text-xs shrink-0", STATUS_TONE[status] ?? "text-muted-foreground")}>
        {approvalStatusLabel(status)}
      </span>
    </SettingsRow>
  );
}

function ApprovalsContent() {
  const params = useSearchParams();
  const focusId = params.get("id");

  // The same pending query the sidebar badge uses, so the list and the count agree.
  const {
    pending: livePendingList,
    error: pendingError,
    isLoading: pendingLoading,
    mutate: mutatePending,
  } = usePendingApprovals(true, 5_000);
  const { data, error: recentError, isLoading: recentLoading, mutate: mutateRecent } = useSWR<ApprovalItem[]>(
    `${APPROVALS_URL}?limit=60`,
    trustFetcher,
    { refreshInterval: 15_000, revalidateOnFocus: true },
  );
  const { data: profile } = useSecurityProfile(true);
  const items = Array.isArray(data) ? data : [];
  const now = useNow(livePendingList.length > 0);
  const pending = livePending(livePendingList, now).sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  const pendingIds = new Set(pending.map((a) => a.id));
  const recent = items.filter((a) => !pendingIds.has(a.id) && a.status !== "pending").slice(0, 20);
  const isLoading = pendingLoading || recentLoading;
  const error = pendingError ?? recentError;
  const mutate = async () => {
    await Promise.all([mutatePending(), mutateRecent()]);
  };
  const ttl = profile?.approvalTtlMinutes;

  // A deep link to a request that is no longer in the recent window.
  const focusMissing = !!focusId && !isLoading && !items.some((a) => a.id === focusId);
  const { data: focused } = useSWR<ApprovalItem>(
    focusMissing && focusId ? `${APPROVALS_URL}/${encodeURIComponent(focusId)}` : null,
    trustFetcher,
  );
  const focusedDecided = focusId ? recent.find((a) => a.id === focusId) ?? focused : undefined;

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        In Cautious mode, destructive actions from agents wait here for your decision. An approval lets the agent
        run that exact action once.{" "}
        {ttl
          ? `Requests expire after ${ttl.interactive} minutes, or ${Math.round(ttl.unattended / 60)} hours for automations and the background agent, which can't retry while you watch.`
          : "Each request expires if nobody decides in time."}
      </p>

      {focusedDecided && effectiveApprovalStatus(focusedDecided, now) !== "pending" && (
        <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          {humanToolName(focusedDecided.tool)} is{" "}
          <span className="text-foreground">
            {approvalStatusLabel(effectiveApprovalStatus(focusedDecided, now)).toLowerCase()}
          </span>
          {focusedDecided.decidedBy ? ` by ${focusedDecided.decidedBy}` : ""}.
        </div>
      )}

      <SettingsGroup>
        <GroupHeader>
          Waiting for you
          {pending.length > 0 && (
            <Badge variant="count" className="ml-2" aria-label={`${pending.length} waiting`}>
              {pending.length}
            </Badge>
          )}
        </GroupHeader>
        {isLoading && pending.length === 0 && (
          <SettingsRow>
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-64" />
            </div>
          </SettingsRow>
        )}
        {error && (
          <SettingsRow>
            <HugeiconsIcon icon={AlertCircleIcon} size={14} strokeWidth={1.5} className="shrink-0 text-status-critical" aria-hidden="true" />
            <p role="alert" className="flex-1 text-xs text-muted-foreground">
              {pending.length > 0 || items.length > 0
                ? "Couldn't refresh approvals. Showing what was loaded last."
                : error instanceof Error ? `Couldn't load approvals: ${error.message}` : "Couldn't load approvals."}
            </p>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void mutate()}>
              Retry
            </Button>
          </SettingsRow>
        )}
        {!isLoading && !error && pending.length === 0 && (
          <SettingsRow className="flex-col items-center text-center py-8 gap-2">
            <HugeiconsIcon icon={SecurityCheckIcon} size={24} className="text-dim-foreground" />
            <p className="text-sm text-muted-foreground">Nothing waiting for approval</p>
          </SettingsRow>
        )}
        {pending.map((item, index) => (
          <PendingRow
            key={item.id}
            item={item}
            now={now}
            highlighted={item.id === focusId}
            primary={index === 0}
            onDecided={() => void mutate()}
          />
        ))}
      </SettingsGroup>

      {recent.length > 0 && (
        <SettingsGroup>
          <GroupHeader>Recent decisions</GroupHeader>
          {recent.map((item) => (
            <DecisionRow key={item.id} item={item} highlighted={item.id === focusId} />
          ))}
        </SettingsGroup>
      )}
    </div>
  );
}

export function ApprovalsSection() {
  return (
    <Suspense fallback={null}>
      <ApprovalsContent />
    </Suspense>
  );
}
