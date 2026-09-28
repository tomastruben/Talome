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
import { APPROVALS_URL, decideApproval, trustFetcher, useNow } from "@/components/trust/api";
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
      <p className="flex-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</p>
    </SettingsRow>
  );
}

function PendingRow({
  item,
  now,
  highlighted,
  onDecided,
}: {
  item: ApprovalItem;
  now: number;
  highlighted: boolean;
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
      toast.success(decision === "approve" ? "Approved — the agent can run it once" : "Denied");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record decision");
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
        <Button size="sm" variant="ghost" disabled={busy !== null || left <= 0} onClick={() => void decide("deny")}>
          {busy === "deny" ? "Denying…" : "Deny"}
        </Button>
        <Button size="sm" disabled={busy !== null || left <= 0} onClick={() => void decide("approve")}>
          {busy === "approve" ? "Approving…" : "Approve"}
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

  const { data, error, isLoading, mutate } = useSWR<ApprovalItem[]>(`${APPROVALS_URL}?limit=60`, trustFetcher, {
    refreshInterval: 5_000,
    revalidateOnFocus: true,
  });
  const items = Array.isArray(data) ? data : [];
  const hasPending = items.some((a) => a.status === "pending");
  const now = useNow(hasPending);
  const pending = livePending(items, now);
  const recent = items.filter((a) => !pending.includes(a)).slice(0, 20);

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
        In Cautious mode, destructive actions from AI agents wait here for your decision. An approval lets the agent
        run that exact action once, and expires after 15 minutes.
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
            <Badge variant="secondary" className="ml-2 tabular-nums">
              {pending.length}
            </Badge>
          )}
        </GroupHeader>
        {isLoading && (
          <SettingsRow>
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-64" />
            </div>
          </SettingsRow>
        )}
        {error && (
          <SettingsRow>
            <p className="text-xs text-muted-foreground">
              {error instanceof Error ? error.message : "Could not load approvals"}
            </p>
          </SettingsRow>
        )}
        {!isLoading && !error && pending.length === 0 && (
          <SettingsRow className="flex-col items-center text-center py-8 gap-2">
            <HugeiconsIcon icon={SecurityCheckIcon} size={24} className="text-dim-foreground" />
            <p className="text-sm text-muted-foreground">Nothing waiting for approval</p>
          </SettingsRow>
        )}
        {pending.map((item) => (
          <PendingRow
            key={item.id}
            item={item}
            now={now}
            highlighted={item.id === focusId}
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
