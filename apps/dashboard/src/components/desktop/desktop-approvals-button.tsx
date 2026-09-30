"use client";

import { useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon, SecurityCheckIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { decideApproval, useNow, usePendingApprovals } from "@/components/trust/api";
import { actorDisplay, formatTimeLeft, humanToolName, type ApprovalItem } from "@/components/trust/format";
import { cn } from "@/lib/utils";

/** "1 approval waiting" / "3 approvals waiting". */
export function approvalsWaitingLabel(count: number): string {
  return `${count} ${count === 1 ? "approval" : "approvals"} waiting`;
}

/** Oldest first, so the primary Approve goes to the one closest to expiring. */
export function sortApprovalsOldestFirst(items: readonly ApprovalItem[]): ApprovalItem[] {
  return [...items].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function TimeLeft({ expiresAt }: { expiresAt: string }) {
  const now = useNow(true, 1000);
  const ms = Date.parse(expiresAt) - now;
  return (
    <span className={cn("tabular-nums", ms <= 30_000 ? "text-status-critical" : "text-muted-foreground")}>
      Expires in {formatTimeLeft(expiresAt, now)}
    </span>
  );
}

function ApprovalRow({ item, primary, onDecided }: { item: ApprovalItem; primary: boolean; onDecided: () => void }) {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agent = actorDisplay(item.actor.kind, item.actor.label);

  const decide = async (decision: "approve" | "deny") => {
    setBusy(decision);
    setError(null);
    try {
      await decideApproval(item.id, decision);
      toast.success(decision === "approve"
        ? `Approved by you · ${agent} can run it once`
        : `Denied by you · ${agent} was told`);
      onDecided();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Couldn't record your decision. Check that Talome is running, then retry.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="grid gap-2 px-4 py-3">
      {/* The server writes the whole sentence: "Cursor wants to run "Restart app" on sonarr (modify)." */}
      <p className="text-sm">{item.summary || `${agent} wants to run "${humanToolName(item.tool)}".`}</p>
      <p className="text-xs"><TimeLeft expiresAt={item.expiresAt} /></p>
      {error ? <p role="alert" className="text-xs text-status-critical">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          busy={busy === "deny"}
          busyLabel="Denying…"
          disabled={busy === "approve"}
          onClick={() => void decide("deny")}
        >
          Deny
        </Button>
        <Button
          variant={primary ? "default" : "outline"}
          size="sm"
          busy={busy === "approve"}
          busyLabel="Approving…"
          disabled={busy === "deny"}
          onClick={() => void decide("approve")}
        >
          Approve
        </Button>
      </div>
    </li>
  );
}

/**
 * The menu bar's "needs you" count (D-P0-1). Admins in desktop mode could not
 * see pending approvals at all (the count lived only in the classic sidebar),
 * so an agent's request could expire unseen. Hidden when nothing waits and
 * for members.
 */
export function DesktopApprovalsButton({ isAdmin, onReviewAll }: { isAdmin: boolean; onReviewAll: () => void }) {
  const { pending, count, mutate } = usePendingApprovals(isAdmin);
  const [open, setOpen] = useState(false);
  if (!isAdmin || count === 0) return null;

  const label = approvalsWaitingLabel(count);
  const items = sortApprovalsOldestFirst(pending);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-desktop-approvals
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-foreground transition-colors duration-150 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring outline-none"
          aria-label={label}
        >
          <HugeiconsIcon icon={SecurityCheckIcon} size={14} aria-hidden="true" />
          <Badge variant="count" aria-hidden="true">{count}</Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" sideOffset={8} className="z-[1300] w-80 p-0" aria-label="Approvals">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-medium">{label}</span>
        </div>
        <ul className="max-h-96 divide-y divide-border overflow-y-auto">
          {items.map((item, index) => (
            <ApprovalRow key={item.id} item={item} primary={index === 0} onDecided={() => void mutate()} />
          ))}
        </ul>
        <div className="border-t border-border px-2 py-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-center"
            onClick={() => {
              setOpen(false);
              onReviewAll();
            }}
          >
            Review in Approvals
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
