"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon, SecurityCheckIcon, Clock01Icon, CheckmarkCircle01Icon, Cancel01Icon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { useUser } from "@/hooks/use-user";
import { useAssistant } from "@/components/assistant/assistant-context";
import { APPROVALS_URL, decideApproval, trustFetcher, useNow, useNowAtDeadline } from "@/components/trust/api";
import {
  approvalHref,
  approvalPollInterval,
  effectiveApprovalStatus,
  formatTimeLeft,
  humanToolName,
  parseApprovalRequest,
  type ApprovalItem,
  type ApprovalStatus,
} from "@/components/trust/format";

/**
 * Inline approval prompt for an `approval_required` tool result in chat.
 * Renders nothing for any other output, so it can sit under every tool call.
 */
export function ApprovalCard({ output }: { output: unknown }) {
  const request = parseApprovalRequest(output);
  if (!request) return null;
  return <ApprovalCardInner request={request} />;
}

function ApprovalCardInner({ request }: { request: NonNullable<ReturnType<typeof parseApprovalRequest>> }) {
  const { isAdmin, isLoading: userLoading } = useUser();
  const { handleSubmit, status: chatStatus, isSubmitting } = useAssistant();
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [continued, setContinued] = useState(false);
  const { approvalStatus: requestedStatus, expiresAt: requestedExpiry } = request;

  // Poll while the decision (or the agent's retry) is outstanding, so a
  // decision made elsewhere (Settings → Approvals, another tab or device)
  // shows up here. Stop once the row is decided, consumed or past its TTL
  // (the server only flips stale rows to "expired" lazily). The function
  // must keep a stable identity: SWR restarts its poll timer whenever
  // `refreshInterval` changes, and this card re-renders on every chat update.
  const refreshInterval = useCallback(
    (latest?: ApprovalItem) => approvalPollInterval(latest ?? { status: requestedStatus, expiresAt: requestedExpiry }),
    [requestedStatus, requestedExpiry],
  );
  const { data: live, mutate } = useSWR<ApprovalItem>(
    isAdmin ? `${APPROVALS_URL}/${encodeURIComponent(request.approvalId)}` : null,
    trustFetcher,
    { refreshInterval, refreshWhenHidden: false, revalidateOnFocus: true },
  );

  const current = live ?? { status: requestedStatus, expiresAt: requestedExpiry };
  // Re-evaluated once at the TTL; the per-second countdown lives in <TimeLeft>.
  const now = useNowAtDeadline(current.expiresAt, current.status === "pending" || current.status === "approved");
  const status: ApprovalStatus = effectiveApprovalStatus(current, now);
  const expiresAt = current.expiresAt;
  const tool = humanToolName(request.tool);
  const chatBusy = isSubmitting || chatStatus === "streaming" || chatStatus === "submitted";

  const sendContinue = () => {
    setContinued(true);
    void handleSubmit(`Approved. Go ahead with ${tool}.`);
  };

  const decide = async (decision: "approve" | "deny") => {
    setBusy(decision);
    try {
      const res = await decideApproval(request.approvalId, decision);
      await mutate(res.approval, { revalidate: false });
      if (decision === "approve" && !chatBusy) sendContinue();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record decision");
      void mutate();
    } finally {
      setBusy(null);
    }
  };

  const expired = status === "expired";

  return (
    <div
      className={cn(
        "rounded-xl border bg-card px-4 py-3 grid gap-3 transition-colors duration-150 ease-out",
        status === "pending" && !expired ? "border-status-warning/30" : "border-border",
      )}
      data-approval-id={request.approvalId}
    >
      <div className="flex items-start gap-3">
        <HugeiconsIcon
          icon={
            status === "denied" || expired
              ? Cancel01Icon
              : status === "approved" || status === "consumed"
                ? CheckmarkCircle01Icon
                : SecurityCheckIcon
          }
          size={16}
          className={cn(
            "mt-0.5 shrink-0",
            status === "pending" && !expired && "text-status-warning",
            (status === "approved" || status === "consumed") && "text-status-healthy",
            (status === "denied" || expired) && "text-muted-foreground",
          )}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">
            {expired
              ? `Approval for ${tool} expired`
              : status === "denied"
                ? `${tool} was denied`
                : status === "consumed"
                  ? `${tool} was approved and ran`
                  : status === "approved"
                    ? `${tool} approved`
                    : `Approve ${tool}?`}
          </p>
          {request.summary && status === "pending" && !expired && (
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{request.summary}</p>
          )}
          {expired && (
            <p className="text-xs text-muted-foreground mt-0.5">Ask again to create a new request.</p>
          )}
        </div>
        {status === "pending" && !expired && expiresAt && (
          <TimeLeft expiresAt={expiresAt} />
        )}
      </div>

      {status === "pending" && !expired && (
        <div className="flex items-center justify-end gap-2">
          {isAdmin ? (
            <>
              <Button asChild size="sm" variant="link" className="mr-auto px-0 text-xs text-muted-foreground">
                <Link href={approvalHref(request.approvalId)}>Details</Link>
              </Button>
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void decide("deny")}>
                {busy === "deny" ? "Denying…" : "Deny"}
              </Button>
              <Button size="sm" disabled={busy !== null} onClick={() => void decide("approve")}>
                {busy === "approve" ? "Approving…" : "Approve"}
              </Button>
            </>
          ) : userLoading ? null : (
            <p className="mr-auto text-xs text-muted-foreground">Waiting for an admin to approve it in Settings.</p>
          )}
        </div>
      )}

      {status === "approved" && !continued && (
        <div className="flex items-center justify-end">
          <Button size="sm" disabled={chatBusy} onClick={sendContinue}>
            Continue
          </Button>
        </div>
      )}
    </div>
  );
}

/** Live countdown; ticks every second (paused while the tab is hidden). */
function TimeLeft({ expiresAt }: { expiresAt: string }) {
  const now = useNow(true);
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums shrink-0">
      <HugeiconsIcon icon={Clock01Icon} size={12} />
      {formatTimeLeft(expiresAt, now)}
    </span>
  );
}
