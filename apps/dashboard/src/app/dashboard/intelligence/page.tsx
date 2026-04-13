"use client";

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { useAtomValue, useSetAtom } from "jotai";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import {
  HugeiconsIcon,
  Activity01Icon,
  ArrowRight01Icon,
  Settings01Icon,
  Shield01Icon,
  CheckmarkCircle02Icon,
  Wrench01Icon,
  AlertCircleIcon,
  Pulse01Icon,
  Bug01Icon,
  BulbChargingIcon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { CORE_URL } from "@/lib/constants";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BudgetZone } from "@/lib/cost-projection";
import { useIsMobile } from "@/hooks/use-mobile";
import { useUser } from "@/hooks/use-user";
import { useBugHunt } from "@/components/bug-hunt/bug-hunt-context";
import { evolutionScanningAtom } from "@/atoms/evolution";
import { terminalSessionAtom } from "@/atoms/terminal";
import { type Suggestion } from "../evolution/components/suggestion-card";
import { EvolutionTerminal, type CompleteResult } from "../evolution/components/evolution-terminal";
import { ExecutionResult } from "../evolution/components/execution-result";
import { InlineMarkdown } from "@/components/ui/inline-markdown";
import { Skeleton } from "@/components/ui/skeleton";
import { Widget, WidgetHeader } from "@/components/widgets/widget";
import { toast } from "sonner";
import { ProblemsWidget } from "./components/problems-widget";
import { ActiveTasksWidget } from "./components/active-tasks-widget";
import { InsightsWidget, SuggestionsWidget } from "./components/intelligence-widget";
import { ActivityLogWidget } from "./components/activity-log-widget";
import { AiOverviewWidget } from "./components/ai-overview-widget";
import { SetupWidget } from "./components/setup-widget";

import type { AuditLogEntry } from "@talome/types";
import {
  type AgentEvent,
  type AgentRemediation,
  type EvolutionEntry,
  type UnifiedTimelineItem,
  type FilterType,
  humanizeUnifiedItem,
  matchesFilter,
  priorityOrder,
} from "@/lib/humanize-activity";

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentStatus {
  config: { enabled: boolean; autoRemediate: boolean };
  evolutionConfig: { autoScan: boolean; autoExecutePolicy: string };
  usage: { totalCostUsd: number; totalRequests: number };
  recentEvents: AgentEvent[];
  recentRemediations: AgentRemediation[];
}

interface SummaryResponse {
  summary: string | null;
  generatedAt: string | null;
  source: "ai" | "raw" | "error";
}

interface ExecutionState {
  runId: string;
  sessionName: string;
  command?: string;
  taskPrompt: string;
  scope: string;
  suggestionId?: string;
  title?: string;
}

// ── Fetchers ─────────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function fetchLogs(url: string): Promise<AuditLogEntry[]> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch audit log");
  return res.json();
}

async function fetchSummary(url: string): Promise<SummaryResponse> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json();
}

async function fetchSuggestions(url: string) {
  const data = await fetchJson<{ suggestions: Suggestion[] }>(url);
  return data.suggestions;
}

async function fetchHistory(url: string) {
  const data = await fetchJson<{ entries: EvolutionEntry[] }>(url);
  return data.entries;
}

function timeGroup(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  if (d >= weekAgo) return "This week";
  return "Earlier";
}

// ── Detail sheet ─────────────────────────────────────────────────────────────

function DetailSheet({
  item,
  onClose,
}: {
  item: UnifiedTimelineItem | null;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const [showRaw, setShowRaw] = useState(false);

  if (!item) return null;

  const { text } = humanizeUnifiedItem(item);
  const { icon: detailIcon, iconColor: detailIconColor } = getTimelineVisual(item);
  const ts = item.ts;

  return (
    <Sheet open={!!item} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={cn(
          "w-full p-0 flex flex-col overflow-hidden",
          isMobile ? "h-[92svh] rounded-t-xl" : "sm:max-w-xl"
        )}
      >
        <SheetHeader className="px-5 py-4 border-b border-border/60">
          <div className="flex items-center gap-3">
            <div className="size-8 rounded-lg bg-muted/20 flex items-center justify-center shrink-0">
              <HugeiconsIcon icon={detailIcon} size={16} className={detailIconColor} />
            </div>
            <div className="min-w-0">
              <SheetTitle className="text-base font-medium">Activity detail</SheetTitle>
              <SheetDescription className="text-xs text-muted-foreground">
                {relativeTime(ts)} · {new Date(ts).toLocaleString()}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <p className="text-sm text-muted-foreground leading-relaxed"><InlineMarkdown text={text} /></p>

          {/* Audit-specific details */}
          {item.kind === "audit" && (
            <div className="space-y-3">
              <div className="rounded-lg bg-muted/20 p-3">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Status</span>
                  <span className={item.data.approved ? "text-muted-foreground" : "text-status-critical/70"}>
                    {item.data.approved ? "Completed" : "Blocked"}
                  </span>
                </div>
              </div>

              {item.data.details && (
                <div className="rounded-lg bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground mb-2">Details</p>
                  <DetailBody text={item.data.details} />
                </div>
              )}

              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                className="text-xs text-dim-foreground hover:text-muted-foreground transition-colors"
              >
                {showRaw ? "Hide" : "Show"} raw action
              </button>
              {showRaw && (
                <code className="block text-xs font-mono break-words whitespace-pre-wrap bg-muted/20 rounded-lg p-3 text-muted-foreground">
                  {item.data.action}
                </code>
              )}
            </div>
          )}

          {/* Event-specific details */}
          {item.kind === "event" && (
            <div className="rounded-lg bg-muted/20 p-3 space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Type</span>
                <span>{item.data.type.replace(/_/g, " ")}</span>
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Source</span>
                <span>{item.data.source}</span>
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Severity</span>
                <span>{item.data.severity}</span>
              </div>
              {item.data.triageVerdict && (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Triage</span>
                  <span>{item.data.triageVerdict}</span>
                </div>
              )}
            </div>
          )}

          {/* Evolution-specific details */}
          {item.kind === "evolution" && (
            <div className="space-y-3">
              <div className="rounded-lg bg-muted/20 p-3 space-y-2">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Scope</span>
                  <span>{item.data.scope}</span>
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Status</span>
                  <span>{item.data.rolledBack ? "Rolled back" : "Applied"}</span>
                </div>
              </div>

              {item.data.filesChanged.length > 0 && (
                <div className="rounded-lg bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground mb-2">
                    {item.data.filesChanged.length} file{item.data.filesChanged.length !== 1 ? "s" : ""} changed
                  </p>
                  <div className="max-h-48 overflow-y-auto space-y-0.5">
                    {item.data.filesChanged.map((f) => (
                      <p key={f} className="text-xs text-muted-foreground font-mono truncate" title={f}>
                        {f}
                      </p>
                    ))}
                  </div>
                </div>
              )}

              {item.data.typeErrors && (
                <div className="rounded-lg bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground mb-2">Type errors</p>
                  <code className="block text-xs font-mono whitespace-pre-wrap break-words text-status-critical/70 max-h-48 overflow-y-auto">
                    {item.data.typeErrors.slice(0, 800)}
                  </code>
                </div>
              )}
            </div>
          )}

          {/* Remediation-specific details */}
          {item.kind === "remediation" && (
            <div className="rounded-lg bg-muted/20 p-3 space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Outcome</span>
                <span>{item.data.outcome}</span>
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Confidence</span>
                <span>{Math.round(item.data.confidence * 100)}%</span>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Timeline visual ─────────────────────────────────────────────────────────

function getTimelineVisual(item: UnifiedTimelineItem): { icon: IconSvgElement; iconColor: string } {
  switch (item.kind) {
    case "audit": {
      const entry = item.data;
      if (!entry.approved) return { icon: Shield01Icon, iconColor: "text-status-critical" };
      return {
        icon: Activity01Icon,
        iconColor: entry.tier === "destructive"
          ? "text-status-critical"
          : entry.tier === "modify"
            ? "text-status-warning"
            : "text-dim-foreground",
      };
    }
    case "event": {
      const e = item.data;
      return {
        icon: e.severity === "critical" ? AlertCircleIcon : Pulse01Icon,
        iconColor: e.severity === "critical"
          ? "text-status-critical"
          : e.severity === "warning"
            ? "text-status-warning"
            : "text-dim-foreground",
      };
    }
    case "evolution":
      return {
        icon: CheckmarkCircle02Icon,
        iconColor: item.data.rolledBack ? "text-status-critical" : "text-status-healthy",
      };
    case "remediation": {
      const r = item.data;
      return {
        icon: Wrench01Icon,
        iconColor: r.outcome === "success"
          ? "text-status-healthy"
          : r.outcome === "failure"
            ? "text-status-critical"
            : "text-status-warning",
      };
    }
  }
}

const DETAIL_LABELS: Record<string, string> = {
  title: "Title",
  description: "Description",
  category: "Category",
  priority: "Priority",
  scope: "Scope",
  taskPrompt: "Task prompt",
  screenshots: "Screenshots",
  containerId: "Container",
  appId: "App",
  key: "Key",
  value: "Value",
};

/** Render audit detail text — parse JSON objects into labeled sections, otherwise inline markdown. */
function DetailBody({ text }: { text: string }) {
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const entries = Object.entries(parsed).filter(
          ([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0),
        );
        if (entries.length > 0) {
          return (
            <div className="space-y-3">
              {entries.map(([key, value]) => (
                <div key={key}>
                  <p className="text-xs text-muted-foreground/60 mb-0.5 capitalize">
                    {DETAIL_LABELS[key] ?? key.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim()}
                  </p>
                  <p className="text-sm text-muted-foreground leading-relaxed break-words whitespace-pre-wrap">
                    <InlineMarkdown text={typeof value === "string" ? value : JSON.stringify(value, null, 2)} />
                  </p>
                </div>
              ))}
            </div>
          );
        }
      }
    } catch {
      // Truncated or malformed JSON — clean up and show as text
      const cleaned = text.replace(/^\{?"?/, "").replace(/"?\}?$/, "");
      return (
        <p className="text-sm text-muted-foreground break-words whitespace-pre-wrap leading-relaxed">
          <InlineMarkdown text={cleaned} />
        </p>
      );
    }
  }
  return (
    <p className="text-sm text-muted-foreground break-words whitespace-pre-wrap leading-relaxed">
      <InlineMarkdown text={text} />
    </p>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function ActivityPage() {
  const { isAdmin } = useUser();
  const isMobile = useIsMobile();
  const router = useRouter();
  const scanning = useAtomValue(evolutionScanningAtom);
  const setTerminalSession = useSetAtom(terminalSessionAtom);
  const bugHunt = useBugHunt();

  // ── Execution state (admin only) ────────────────────────────────
  const [execution, setExecution] = useState<ExecutionState | null>(null);
  const [result, setResult] = useState<CompleteResult | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [terminalMinimized, setTerminalMinimized] = useState(false);

  // ── Timeline state ──────────────────────────────────────────────
  const [filter, setFilter] = useState<FilterType>("all");
  const [selectedItem, setSelectedItem] = useState<UnifiedTimelineItem | null>(null);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const TIMELINE_LIMIT = 12;

  // ── Data fetching (all users) ───────────────────────────────────
  const {
    data: logs,
    error: logsError,
    isLoading: logsLoading,
    mutate: mutateLogs,
  } = useSWR<AuditLogEntry[]>(
    `${CORE_URL}/api/audit-log`,
    fetchLogs,
    { refreshInterval: 15_000, dedupingInterval: 5_000 },
  );

  const { data: summaryData } = useSWR<SummaryResponse>(
    `${CORE_URL}/api/audit-log/summary`,
    fetchSummary,
    { refreshInterval: 60_000 },
  );

  // ── Data fetching (admin only — conditional SWR) ────────────────
  const {
    data: suggestions,
    isLoading: suggestionsLoading,
    error: suggestionsError,
    mutate: mutateSuggestions,
  } = useSWR<Suggestion[]>(
    isAdmin ? `${CORE_URL}/api/evolution/suggestions?status=pending` : null,
    fetchSuggestions,
    { refreshInterval: 30_000 },
  );

  const {
    data: activeHunts,
    mutate: mutateActiveHunts,
  } = useSWR<Suggestion[]>(
    isAdmin ? `${CORE_URL}/api/evolution/suggestions?status=in_progress` : null,
    fetchSuggestions,
    { refreshInterval: 15_000 },
  );

  const {
    data: entries,
    mutate: mutateHistory,
  } = useSWR<EvolutionEntry[]>(
    isAdmin ? `${CORE_URL}/api/evolution/history` : null,
    fetchHistory,
    { refreshInterval: 10_000 },
  );


  const { data: agentStatus } = useSWR<AgentStatus>(
    isAdmin ? `${CORE_URL}/api/agent-loop/status` : null,
    (url: string) => fetchJson<AgentStatus>(url),
    { refreshInterval: 30_000 },
  );

  const { data: costData } = useSWR<{ today: { cost: number; cap: number; zone?: BudgetZone }; projectedMonthly: number }>(
    isAdmin ? `${CORE_URL}/api/settings/ai-cost` : null,
    (url: string) => fetchJson(url),
    { refreshInterval: 60_000 },
  );

  // ── Handlers (admin) ───────────────────────────────────────────

  const handleExecute = useCallback(async (suggestion: Suggestion, auto?: boolean) => {
    try {
      const res = await fetch(`${CORE_URL}/api/evolution/execute`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestionId: suggestion.id, scope: suggestion.scope, auto: auto ?? false }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as ExecutionState;
      setExecution({ ...data, title: suggestion.title });
      setTerminalMinimized(false);
      setResult(null);
    } catch {
      toast.error("Failed to start evolution run");
    }
  }, []);

  const handleDismiss = useCallback(async (id: string, reason?: string) => {
    try {
      await fetch(`${CORE_URL}/api/evolution/suggestions/${id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "dismissed", dismissReason: reason }),
      });
      await mutateSuggestions();
    } catch {
      toast.error("Failed to dismiss suggestion");
    }
  }, [mutateSuggestions]);

  const handleMarkDone = useCallback(async (id: string) => {
    try {
      await fetch(`${CORE_URL}/api/evolution/suggestions/${id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
      await mutateSuggestions();
      await mutateActiveHunts();
    } catch {
      toast.error("Failed to mark suggestion as done");
    }
  }, [mutateSuggestions, mutateActiveHunts]);

  const handleViewTerminal = useCallback((sessionName: string) => {
    setTerminalSession(sessionName);
    router.push("/dashboard/terminal");
  }, [setTerminalSession, router]);

  // View: reattach to an existing session inline (no new command)
  const handleView = useCallback((suggestion: Suggestion) => {
    if (!suggestion.runId) return;
    setExecution({
      runId: suggestion.runId,
      sessionName: `sess_evolution-${suggestion.runId}`,
      taskPrompt: suggestion.taskPrompt,
      scope: suggestion.scope,
      title: suggestion.title,
    });
    setTerminalMinimized(false);
    setResult(null);
  }, []);

  const handleReinject = useCallback(async (runId: string, autoMode?: boolean) => {
    try {
      const res = await fetch(`${CORE_URL}/api/evolution/runs/${runId}/reinject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto: autoMode ?? false }),
      });
      if (!res.ok) {
        setTerminalSession(`sess_evolution-${runId}`);
        router.push("/dashboard/terminal");
        return;
      }
      const data = (await res.json()) as {
        command?: string;
        taskPrompt?: string;
        sessionName?: string;
        scope?: string;
        runId?: string;
        suggestionId?: string;
      };

      if (data.command && data.taskPrompt && data.runId) {
        // Clear stale state from any previous execution
        setResult(null);
        setLastRunId(null);
        setExecution({
          runId: data.runId,
          sessionName: data.sessionName ?? `sess_evolution-${data.runId}`,
          command: data.command,
          taskPrompt: data.taskPrompt,
          scope: data.scope ?? "full",
          suggestionId: data.suggestionId,
        });
        // Refresh lists — suggestion now points to the new run
        void mutateSuggestions();
        void mutateActiveHunts();
      } else {
        setTerminalSession(`sess_evolution-${runId}`);
        router.push("/dashboard/terminal");
      }
    } catch {
      setTerminalSession(`sess_evolution-${runId}`);
      router.push("/dashboard/terminal");
    }
  }, [setTerminalSession, router, mutateSuggestions, mutateActiveHunts]);

  const handleComplete = useCallback((r: CompleteResult) => {
    setLastRunId(execution?.runId ?? null);
    setResult(r);
    setExecution(null);
    void mutateSuggestions();
    void mutateActiveHunts();
    void mutateHistory();
  }, [execution, mutateSuggestions, mutateActiveHunts, mutateHistory]);

  const handleMinimize = useCallback(() => {
    setTerminalMinimized(true);
  }, []);

  const handleCancelExecution = useCallback(() => {
    setExecution(null);
    setResult(null);
    setLastRunId(null);
  }, []);

  const handleBackFromResult = useCallback(() => {
    setResult(null);
  }, []);

  // ── Computed ───────────────────────────────────────────────────

  const config = agentStatus?.config;
  const events = agentStatus?.recentEvents ?? [];
  const remediations = agentStatus?.recentRemediations ?? [];
  const pendingCount = suggestions?.length ?? 0;
  const intelligenceEnabled = !config || config.enabled;

  // Sort suggestions: high priority first
  const sortedSuggestions = useMemo(() => {
    if (!suggestions) return [];
    return [...suggestions].sort(
      (a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2),
    );
  }, [suggestions]);

  // Deduplicated critical events — surfaced as "problems"
  const activeProblems = useMemo(() => {
    const critical = events.filter((e) => e.severity === "critical");
    const groups = new Map<string, { event: AgentEvent; count: number }>();
    for (const e of critical) {
      const key = `${e.source}:${e.type}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
      } else {
        groups.set(key, { event: e, count: 1 });
      }
    }
    return Array.from(groups.values());
  }, [events]);

  // AI summary — collapsed into one flowing sentence
  const summaryLines = useMemo(() => {
    if (!summaryData?.summary || summaryData.source === "error") return [];
    return summaryData.summary
      .split("\n")
      .map((l) => l.replace(/^[•\-*]\s*/, "").trim())
      .filter(Boolean);
  }, [summaryData]);

  // Unified timeline — merge all sources
  const timeline = useMemo<UnifiedTimelineItem[]>(() => {
    const items: UnifiedTimelineItem[] = [];

    // Audit log entries
    for (const entry of logs ?? []) {
      items.push({ kind: "audit", ts: entry.timestamp, data: entry });
    }

    // Agent events (exclude critical ones shown in problems section)
    for (const e of events) {
      if (activeProblems.length > 0 && e.severity === "critical") continue;
      items.push({ kind: "event", ts: e.createdAt, data: e });
    }

    // Evolution entries
    for (const e of entries ?? []) {
      items.push({ kind: "evolution", ts: e.timestamp, data: e });
    }

    // Remediations
    for (const r of remediations) {
      items.push({ kind: "remediation", ts: r.createdAt, data: r });
    }

    items.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
    return items;
  }, [logs, events, entries, remediations, activeProblems]);

  // Filtered timeline
  const filtered = useMemo(() => {
    return timeline.filter((item) => matchesFilter(item, filter));
  }, [timeline, filter]);

  // Build remediation lookup: eventId → remediation
  const remediationByEvent = useMemo(() => {
    const map = new Map<string, AgentRemediation>();
    for (const r of remediations) {
      map.set(r.eventId, r);
    }
    return map;
  }, [remediations]);

  // Collect IDs of items shown in the attention zone so we can exclude them from the timeline
  const attentionEventIds = useMemo(() => {
    const ids = new Set<string>();
    for (const { event } of activeProblems) {
      ids.add(event.id);
    }
    // Also exclude remediations linked to attention-zone problems
    for (const { event } of activeProblems) {
      const r = remediationByEvent.get(event.id);
      if (r) ids.add(r.id);
    }
    return ids;
  }, [activeProblems, remediationByEvent]);

  // Filter timeline to exclude items already in the attention zone
  const deduped = useMemo(() => {
    return filtered.filter((item) => {
      if (item.kind === "event" && attentionEventIds.has(item.data.id)) return false;
      if (item.kind === "remediation" && attentionEventIds.has(item.data.id)) return false;
      return true;
    });
  }, [filtered, attentionEventIds]);

  // Group deduped timeline by time period
  const groupedTimeline = useMemo(() => {
    const visible = timelineExpanded ? deduped : deduped.slice(0, TIMELINE_LIMIT);
    const groups: { label: string; items: UnifiedTimelineItem[] }[] = [];
    let currentLabel = "";
    for (const item of visible) {
      const label = timeGroup(item.ts);
      if (label !== currentLabel) {
        groups.push({ label, items: [item] });
        currentLabel = label;
      } else {
        groups[groups.length - 1].items.push(item);
      }
    }
    return groups;
  }, [deduped, timelineExpanded]);

  // ── Execution terminal fullscreen ──────────────────────────────
  // Must be AFTER all hooks — React requires consistent hook call order.

  if (execution && !terminalMinimized) {
    return (
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-2 sm:p-4">
        <div className="flex-1 min-h-0 overflow-hidden rounded-xl border border-border/50 shadow-lg flex flex-col bg-[#0d1117]">
          <EvolutionTerminal
            key={execution.runId}
            sessionName={execution.sessionName}
            command={execution.command}
            taskPrompt={execution.taskPrompt}
            runId={execution.runId}
            scope={execution.scope}
            title={execution.title}
            onComplete={handleComplete}
            onCancel={handleMinimize}
          />
        </div>
      </div>
    );
  }

  // ── Initial loading skeleton ───────────────────────────────────
  // Show once on first paint while core data resolves — then never again.

  const initialLoading = logsLoading && !logs && !suggestions && !agentStatus;

  if (initialLoading) {
    return (
      <div className="mx-auto w-full max-w-3xl min-w-0 space-y-4 pb-12">
        {/* Status strip skeleton */}
        <div className="flex items-center gap-3 px-1">
          <Skeleton className="size-2 rounded-full" />
          <Skeleton className="h-3.5 w-40" />
        </div>

        {/* AI Overview skeleton */}
        <Widget className="h-auto">
          <WidgetHeader title="AI Overview" />
          <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-border/40">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-1.5 px-4 py-3">
                <Skeleton className="h-3 w-10" />
                <Skeleton className="h-4 w-14" />
              </div>
            ))}
          </div>
          <div className="px-4 pb-3">
            <Skeleton className="h-1 w-full rounded-full" />
          </div>
        </Widget>

        {/* Suggestions skeleton */}
        <Widget className="h-auto">
          <WidgetHeader title="Suggestions" />
          <div className="divide-y divide-border/40">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="px-4 py-3.5 space-y-2">
                <div className="flex items-center gap-2">
                  <Skeleton className="size-3 rounded" />
                  <Skeleton className="h-3.5 w-48" />
                </div>
                <Skeleton className="h-3 w-72" />
              </div>
            ))}
          </div>
        </Widget>

        {/* Activity log skeleton */}
        <Widget className="h-auto">
          <WidgetHeader title="Activity Log" />
          <div className="px-4 py-3 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 py-2">
                <Skeleton className="size-1.5 rounded-full" />
                <Skeleton className="h-3.5 flex-1 max-w-72" />
                <Skeleton className="h-3 w-12" />
              </div>
            ))}
          </div>
        </Widget>
      </div>
    );
  }

  // ── Status ─────────────────────────────────────────────────────

  const hasProblems = isAdmin && activeProblems.length > 0;
  const activeCount = activeHunts?.length ?? 0;
  const statusDot = hasProblems
    ? "bg-status-critical"
    : activeCount > 0
      ? "bg-status-warning animate-pulse"
      : pendingCount > 0
        ? "bg-status-warning"
        : "bg-status-healthy";

  const statusParts: string[] = [];
  if (hasProblems) {
    const total = activeProblems.reduce((sum, p) => sum + p.count, 0);
    statusParts.push(`${total} problem${total !== 1 ? "s" : ""}`);
  }
  if (activeCount > 0) {
    statusParts.push(`${activeCount} active`);
  }
  if (isAdmin && pendingCount > 0) {
    statusParts.push(`${pendingCount} suggestion${pendingCount !== 1 ? "s" : ""}`);
  }
  const statusText = statusParts.length > 0 ? statusParts.join(" · ") : "All clear";

  return (
    <div className="mx-auto w-full max-w-3xl min-w-0 space-y-4 pb-12">
      {/* Result overlay */}
      {result && (
        <ExecutionResult result={result} runId={lastRunId ?? undefined} onBack={handleBackFromResult} />
      )}

      {/* ── Zone 1: Status strip ───────────────────────────────── */}
      <div className="flex items-center gap-3 px-1">
        <span className={`size-2 rounded-full shrink-0 ${statusDot}`} />
        <p className="text-sm text-foreground flex-1">{statusText}</p>
        {scanning && (
          <Shimmer as="span" className="text-xs text-muted-foreground" duration={2}>
            Scanning...
          </Shimmer>
        )}
        {isAdmin && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => bugHunt.open({ mode: "bug" })}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-muted/20"
            >
              <HugeiconsIcon icon={Bug01Icon} size={14} />
              <span className="hidden sm:inline">Report</span>
            </button>
            <button
              type="button"
              onClick={() => bugHunt.open({ mode: "feature" })}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-muted/20"
            >
              <HugeiconsIcon icon={BulbChargingIcon} size={14} />
              <span className="hidden sm:inline">Suggest</span>
            </button>
            <Link
              href="/dashboard/settings/intelligence"
              className="text-muted-foreground hover:text-foreground transition-colors px-2 py-1"
            >
              <HugeiconsIcon icon={Settings01Icon} size={14} />
            </Link>
          </div>
        )}
      </div>

      {/* ── Zone 2: AI vitals ─────────────────────────────────── */}
      {isAdmin && (
        <AiOverviewWidget
          costData={costData}
          eventsCount={events.length}
          criticalCount={activeProblems.reduce((s, p) => s + p.count, 0)}
          remediationsCount={remediations.length}
          successfulRemediations={remediations.filter((r) => r.outcome === "success").length}
          usage={agentStatus?.usage}
        />
      )}

      {/* ── Zone 2b: Server setup health ────────────────────────── */}
      {isAdmin && <SetupWidget />}

      {/* ── Zone 3: Attention (problems + active tasks) ────────── */}
      {isAdmin && hasProblems && (
        <ProblemsWidget problems={activeProblems} remediationByEvent={remediationByEvent} />
      )}

      {isAdmin && activeHunts && activeHunts.length > 0 && (
        <ActiveTasksWidget
          tasks={activeHunts}
          onExecute={handleExecute}
          onDismiss={handleDismiss}
          onView={handleView}
          onReinject={handleReinject}
          onMarkDone={handleMarkDone}
        />
      )}

      {/* ── Zone 3: Insights ──────────────────────────────────── */}
      <InsightsWidget
        summaryLines={summaryLines}
        intelligenceDisabledExplicitly={!!(isAdmin && config && !config.enabled)}
      />

      {/* ── Zone 4: Suggestions ────────────────────────────────── */}
      {isAdmin && intelligenceEnabled && (
        <SuggestionsWidget
          suggestions={sortedSuggestions}
          suggestionsLoading={suggestionsLoading}
          suggestionsError={suggestionsError}
          onExecute={handleExecute}
          onDismiss={handleDismiss}
          onView={handleView}
          onReinject={handleReinject}
          onMarkDone={handleMarkDone}
          onRetrySuggestions={() => mutateSuggestions()}
        />
      )}

      {/* ── Zone 4: Activity log ───────────────────────────────── */}
      <ActivityLogWidget
        groupedTimeline={groupedTimeline}
        deduped={deduped}
        timeline={timeline}
        filter={filter}
        timelineExpanded={timelineExpanded}
        timelineLimit={TIMELINE_LIMIT}
        logsLoading={logsLoading}
        logsError={logsError}
        getTimelineVisual={getTimelineVisual}
        onFilterChange={(f: FilterType) => { setFilter(f); setTimelineExpanded(false); }}
        onExpandTimeline={() => setTimelineExpanded(true)}
        onSelectItem={setSelectedItem}
        onRetryLogs={() => mutateLogs()}
      />

      <DetailSheet item={selectedItem} onClose={() => setSelectedItem(null)} />
    </div>
  );
}
