"use client";

import { useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow, relativeTime } from "@/components/settings/settings-primitives";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";

interface ToolApproval {
  id: string;
  code: string;
  toolName: string;
  tier: "read" | "modify" | "destructive";
  actorLabel: string;
  argsPreview: string;
  status: "pending" | "approved" | "denied" | "used" | "expired";
  createdAt: string;
  expiresAt: string;
}

function minutesLeft(iso: string): number {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
}

/**
 * Destructive actions requested by MCP clients, messaging, automations and
 * background loops wait here until an admin approves or denies them.
 */
export function PendingApprovals() {
  const [deciding, setDeciding] = useState<string | null>(null);
  const { data, mutate } = useSWR<ToolApproval[]>(
    `${CORE_URL}/api/approvals?status=pending`,
    (url: string) => fetch(url).then((r) => (r.ok ? r.json() : [])),
    { refreshInterval: 5000 },
  );
  const pending = Array.isArray(data) ? data : [];

  const decide = async (approval: ToolApproval, approve: boolean) => {
    setDeciding(approval.id);
    try {
      const res = await fetch(`${CORE_URL}/api/approvals/${approval.id}/${approve ? "approve" : "deny"}`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        toast(approve ? `Approved ${approval.toolName} — it runs on the agent's next attempt` : `Denied ${approval.toolName}`);
      } else {
        toast.error(body.error ?? "Could not update the request");
      }
    } catch {
      toast.error("Could not update the request");
    } finally {
      setDeciding(null);
      void mutate();
    }
  };

  return (
    <SettingsGroup>
      <SettingsRow className="py-2.5">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Waiting for Approval</p>
      </SettingsRow>
      {pending.length === 0 ? (
        <SettingsRow>
          <p className="text-sm text-muted-foreground">
            Nothing is waiting. Destructive actions from connected agents, chat apps and automations appear here.
          </p>
        </SettingsRow>
      ) : (
        pending.map((approval) => (
          <SettingsRow key={approval.id} className="flex-wrap gap-y-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">
                {approval.toolName}
                <span className="ml-2 text-xs font-mono text-muted-foreground">{approval.code}</span>
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {approval.actorLabel} · {relativeTime(approval.createdAt)} · expires in {minutesLeft(approval.expiresAt)}m
              </p>
              {approval.argsPreview && (
                <p className="text-xs font-mono text-muted-foreground mt-1.5 break-all">{approval.argsPreview}</p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                disabled={deciding === approval.id}
                onClick={() => void decide(approval, false)}
              >
                Deny
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs px-4"
                disabled={deciding === approval.id}
                onClick={() => void decide(approval, true)}
              >
                Approve
              </Button>
            </div>
          </SettingsRow>
        ))
      )}
    </SettingsGroup>
  );
}
