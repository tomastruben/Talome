"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import {
  HugeiconsIcon,
  Add01Icon,
  PlayIcon,
  FlashIcon,
  Package01Icon,
  HardDriveIcon,
  DownloadSquare01Icon,
  Clock01Icon,
  AlertCircleIcon,
} from "@/components/icons";
import { PillIndicator } from "@/components/kibo-ui/pill";
import { Banner, BannerIcon, BannerTitle, BannerClose } from "@/components/kibo-ui/banner";
import { AutomationSheet } from "@/components/automations/automation-sheet";
import { useAutomation } from "@/components/automations/automation-context";
import { relativeTime } from "@/lib/format";
import { ErrorState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

/** Throws on failure, so a failed load never shows "No automations yet". */
async function fetcher<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : `Couldn't load automations (${res.status}).`);
  return body as T;
}

interface AutomationRow {
  id: string;
  name: string;
  enabled: boolean;
  trigger: string;
  steps: string | null;
  actions: string;
  workflowVersion: number;
  lastRunAt: string | null;
  runCount: number;
  createdAt: string;
  lastRunSuccess?: boolean;
  lastRunError?: string | null;
  /**
   * The release run journal's status (runs recorded before statuses may have
   * none). "interrupted" = the server restarted mid-run; Talome never re-runs it
   * on its own. "blocked_approval" = a step is waiting for an owner approval.
   */
  lastRunStatus?: "running" | "succeeded" | "failed" | "blocked_approval" | "blocked" | "interrupted" | (string & {}) | null;
  lastRunTriggeredAt?: string;
}

interface TriggerConfig {
  type: string;
}

interface StepConfig {
  type: string;
  toolName?: string;
  promptTemplate?: string;
  title?: string;
  command?: string;
  approved?: boolean;
}

const TRIGGER_TYPES = [
  { value: "container_stopped",  label: "Container stopped",  icon: Package01Icon },
  { value: "disk_usage_exceeds", label: "Disk usage exceeds", icon: HardDriveIcon },
  { value: "app_installed",      label: "App installed",      icon: DownloadSquare01Icon },
  { value: "schedule",           label: "Schedule (cron)",    icon: Clock01Icon },
  { value: "webhook",            label: "Webhook",            icon: FlashIcon },
];

function triggerLabel(triggerJson: string): string {
  try {
    const t = JSON.parse(triggerJson) as TriggerConfig;
    return TRIGGER_TYPES.find((x) => x.value === t.type)?.label ?? t.type;
  } catch {
    return "Unknown";
  }
}

function stepSummary(row: AutomationRow): string {
  try {
    // v2 steps
    if (row.workflowVersion === 2 && row.steps) {
      const steps = JSON.parse(row.steps) as StepConfig[];
      return steps.map((s) => {
        if (s.type === "notify") return `Notify`;
        if (s.type === "tool_action") return s.toolName ?? "Tool";
        if (s.type === "ai_prompt") return "AI Prompt";
        if (s.type === "condition") return "Condition";
        return s.type;
      }).join(" → ");
    }
    // legacy v1 actions
    const steps = JSON.parse(row.actions) as StepConfig[];
    return steps.map((s) => {
      if (s.type === "restart_container") return "Restart container";
      if (s.type === "send_notification") return `Notify`;
      if (s.type === "run_shell") return `Shell${s.approved ? "" : " (needs approval)"}`;
      if (s.type === "ask_ai") return `AI Prompt${s.approved ? "" : " (needs approval)"}`;
      return s.type;
    }).join(" → ");
  } catch {
    return "";
  }
}

export default function AutomationsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data, error: loadError, mutate } = useSWR<{ automations: AutomationRow[] }>(
    `${CORE_URL}/api/automations`,
    fetcher,
    { refreshInterval: 10_000 },
  );
  const { data: failuresData } = useSWR<{ failures: { id: string; name: string; triggeredAt: string; error: string | null }[] }>(
    `${CORE_URL}/api/automations/failures`,
    fetcher,
    { refreshInterval: 30_000 },
  );

  const { sheetOpen, openCreate, closeSheet } = useAutomation();
  const [editAutomation, setEditAutomation] = useState<AutomationRow | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // Reset edit target when the context triggers a fresh create
  useEffect(() => {
    if (sheetOpen && editAutomation === null) return;
    if (!sheetOpen) setEditAutomation(null);
  }, [sheetOpen]);

  const rows = useMemo(() => data?.automations ?? [], [data?.automations]);
  const recentFailures = failuresData?.failures ?? [];
  const requestedAutomationId = searchParams.get("id");

  useEffect(() => {
    if (!requestedAutomationId || rows.length === 0) return;
    if (editAutomation?.id === requestedAutomationId) return;
    const requested = rows.find((row) => row.id === requestedAutomationId);
    if (requested) setEditAutomation(requested);
  }, [editAutomation?.id, requestedAutomationId, rows]);

  function openEdit(row: AutomationRow) {
    setEditAutomation(row);
  }

  async function toggleEnabled(id: string, enabled: boolean) {
    try {
      const res = await fetch(`${CORE_URL}/api/automations/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Failed to update automation");
      }
      mutate();
    } catch (err) {
      toast.error("Failed to update automation", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }

  async function runManually(id: string) {
    setRunning(id);
    try {
      const res = await fetch(`${CORE_URL}/api/automations/${id}/run`, { method: "POST" });
      const d = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!res.ok || d.ok === false) {
        toast.error("Automation failed", {
          description: d.error ?? "An unexpected error occurred",
        });
      } else {
        toast.success("Automation completed");
      }
    } catch (err) {
      toast.error("Failed to run automation", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setRunning(null);
      mutate();
    }
  }

  return (
    <div className="w-full max-w-2xl mx-auto space-y-6">
      {/* Failure banner */}
      {recentFailures.length > 0 && !bannerDismissed && (
        <Banner className="rounded-xl bg-destructive/8 text-destructive dark:text-status-critical" inset>
          <BannerIcon icon={AlertCircleIcon} className="border-destructive/20 bg-destructive/10 text-destructive" />
          <BannerTitle className="text-sm">
            {recentFailures.length === 1
              ? `"${recentFailures[0].name}" failed ${relativeTime(recentFailures[0].triggeredAt)}`
              : `${recentFailures.length} automations failed recently`}
          </BannerTitle>
          <BannerClose onClick={() => setBannerDismissed(true)} className="text-destructive hover:text-destructive hover:bg-destructive/10" />
        </Banner>
      )}

      {/* List */}
      {!data && loadError ? (
        <ErrorState
          title="Couldn't load automations"
          description={loadError instanceof Error ? loadError.message : "Check that the Talome server is reachable, then retry."}
          onRetry={() => void mutate()}
        />
      ) : !data ? (
        <div className="grid gap-3" aria-hidden="true">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 flex flex-col items-center gap-3 text-center">
          <HugeiconsIcon icon={FlashIcon} size={32} className="text-dim-foreground" />
          <div>
            <p className="font-medium text-sm">No automations yet</p>
            <p className="text-sm text-muted-foreground max-w-xs">
              Automations run on a schedule or when events happen — restart a service if it crashes, clean up downloads weekly, scan your library nightly.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={openCreate}>
            <HugeiconsIcon icon={Add01Icon} size={14} />
            Create automation
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const trigger = (() => {
              try { return JSON.parse(row.trigger) as TriggerConfig; } catch { return null; }
            })();
            const triggerInfo = TRIGGER_TYPES.find((t) => t.value === trigger?.type);
            const isRunning = running === row.id;

            // Derive status from enriched data
            const hasRun = row.lastRunTriggeredAt != null;
            const lastStatus = row.lastRunStatus ?? (row.lastRunSuccess ? "succeeded" : "failed");
            const statusVariant: "success" | "error" | "warning" | "info" =
              lastStatus === "succeeded" ? "success"
                : lastStatus === "failed" ? "error"
                : lastStatus === "running" ? "info"
                : "warning";

            return (
              <div
                key={row.id}
                role="button"
                tabIndex={0}
                className="px-4 py-3.5 rounded-xl border cursor-pointer hover:bg-muted/30 transition-colors"
                onClick={() => openEdit(row)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openEdit(row); }}
              >
                <div className="flex items-center gap-3">
                  {/* Status-aware trigger icon */}
                  <div className="relative shrink-0 w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
                    <HugeiconsIcon
                      icon={triggerInfo?.icon ?? FlashIcon}
                      size={14}
                      className="text-muted-foreground"
                    />
                    {isRunning ? (
                      <Spinner className="absolute -bottom-0.5 -right-0.5 size-2.5" />
                    ) : hasRun && (
                      <span className="absolute -bottom-0.5 -right-0.5">
                        <PillIndicator variant={statusVariant} />
                      </span>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{row.name}</p>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {triggerLabel(row.trigger)} → {stepSummary(row)}
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground"
                          aria-label="Run now"
                          disabled={isRunning}
                          onClick={(e) => { e.stopPropagation(); runManually(row.id); }}
                        >
                          {isRunning
                            ? <Spinner className="size-3.5" />
                            : <HugeiconsIcon icon={PlayIcon} size={13} />}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Run now</TooltipContent>
                    </Tooltip>
                    {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
                    <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
                      <Switch
                        checked={row.enabled}
                        onCheckedChange={(v) => toggleEnabled(row.id, v)}
                        aria-label="Enable automation"
                      />
                    </div>
                  </div>
                </div>

                {/* Last run status — honest, inline */}
                {(hasRun || row.runCount > 0) && (
                  <div className="flex items-center gap-1.5 mt-1 ml-11 text-xs text-muted-foreground">
                    {isRunning || lastStatus === "running" ? (
                      <span>Running…</span>
                    ) : hasRun && lastStatus === "blocked_approval" ? (
                      <span className="text-status-warning">
                        Waiting for approval since {relativeTime(row.lastRunTriggeredAt!)} ·{" "}
                        <Link href="/dashboard/settings/approvals" className="rounded-sm underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          Review
                        </Link>
                      </span>
                    ) : hasRun && lastStatus === "interrupted" ? (
                      <span className="text-status-warning">Interrupted {relativeTime(row.lastRunTriggeredAt!)}</span>
                    ) : hasRun ? (
                      lastStatus === "succeeded" ? (
                        <span>Succeeded {relativeTime(row.lastRunTriggeredAt!)}</span>
                      ) : row.lastRunError ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-status-critical truncate max-w-xs cursor-default">
                              Failed {relativeTime(row.lastRunTriggeredAt!)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-sm text-xs">
                            {row.lastRunError}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-status-critical">
                          Failed {relativeTime(row.lastRunTriggeredAt!)}
                        </span>
                      )
                    ) : (
                      <span>Last {row.lastRunAt ? relativeTime(row.lastRunAt) : "never"}</span>
                    )}
                    {row.runCount > 1 && (
                      <span className="text-muted-foreground/50">· {row.runCount} runs</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <AutomationSheet
        key={editAutomation?.id ?? "new"}
        open={sheetOpen || editAutomation !== null}
        onOpenChange={(v) => {
          if (!v) {
            closeSheet();
            setEditAutomation(null);
            if (requestedAutomationId) {
              router.replace("/dashboard/automations", { scroll: false });
            }
          }
        }}
        automation={editAutomation}
        onSaved={() => mutate()}
      />
    </div>
  );
}
