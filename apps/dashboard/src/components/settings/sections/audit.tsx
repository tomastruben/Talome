"use client";

import { useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HugeiconsIcon, Activity01Icon, ArrowDown01Icon, ArrowRight01Icon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow, relativeTime } from "@/components/settings/settings-primitives";
import { AUDIT_LOG_URL, trustFetcher } from "@/components/trust/api";
import {
  actorDisplay,
  auditOutcome,
  auditQuery,
  auditTitle,
  formatDuration,
  sourceLabel,
  tierLabel,
  type AuditEntry,
  type OutcomeTone,
} from "@/components/trust/format";

const PAGE_SIZE = 100;
const MAX_LIMIT = 500;

const OUTCOME_FILTERS = [
  { value: "all", label: "All outcomes" },
  { value: "success", label: "Succeeded" },
  { value: "error", label: "Failed" },
  { value: "blocked", label: "Blocked" },
  { value: "approval_required", label: "Needs approval" },
] as const;

const SOURCE_FILTERS = [
  { value: "all", label: "All sources" },
  { value: "chat", label: "Chat" },
  { value: "mcp", label: "MCP" },
  { value: "automation", label: "Automations" },
  { value: "agent_loop", label: "Agent loop" },
  { value: "dashboard", label: "Dashboard" },
] as const;

const TONE_DOT: Record<OutcomeTone, string> = {
  healthy: "bg-status-healthy",
  warning: "bg-status-warning",
  critical: "bg-status-critical",
  muted: "bg-muted-foreground/40",
};

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const outcome = auditOutcome(entry);
  const title = auditTitle(entry);
  const duration = formatDuration(entry.durationMs);
  const meta = [
    actorDisplay(entry.actorKind, entry.actorLabel),
    sourceLabel(entry.source),
    tierLabel(entry.tier),
    duration,
    relativeTime(entry.timestamp),
  ].filter(Boolean);

  return (
    <div className="divide-y divide-border/50">
      <button
        type="button"
        aria-expanded={open}
        disabled={!entry.details}
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-3 flex items-start gap-3 text-left transition-colors duration-150 ease-out hover:bg-muted/30 disabled:hover:bg-transparent"
      >
        <span className={cn("mt-1.5 size-1.5 rounded-full shrink-0", TONE_DOT[outcome.tone])} aria-hidden />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <p className="text-sm truncate">{title}</p>
            {entry.tier === "destructive" && <span className="text-xs text-status-warning shrink-0">Destructive</span>}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{meta.join(" · ")}</p>
        </div>
        <span className="text-xs text-muted-foreground shrink-0 flex items-center gap-1">
          {outcome.label}
          {entry.details && <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={12} />}
        </span>
      </button>
      {open && entry.details && (
        <div className="px-4 py-3 bg-muted/20">
          <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
            {entry.details}
          </pre>
        </div>
      )}
    </div>
  );
}

export function AuditSection() {
  const [outcome, setOutcome] = useState<string>("all");
  const [source, setSource] = useState<string>("all");
  const [limit, setLimit] = useState(PAGE_SIZE);

  const { data, error, isLoading, isValidating } = useSWR<AuditEntry[]>(
    `${AUDIT_LOG_URL}?${auditQuery({ outcome, source, limit })}`,
    trustFetcher,
    { refreshInterval: 30_000, revalidateOnFocus: true, keepPreviousData: true },
  );
  const entries = Array.isArray(data) ? data : [];
  const canLoadMore = entries.length >= limit && limit < MAX_LIMIT;

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Every tool call by the assistant, MCP clients, and automations — who ran it, from where, and what happened.
        Secrets in arguments are redacted before they are stored.
      </p>

      <div className="flex flex-wrap gap-2">
        <Select
          value={outcome}
          onValueChange={(v) => {
            setOutcome(v);
            setLimit(PAGE_SIZE);
          }}
        >
          <SelectTrigger size="sm" aria-label="Filter by outcome">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OUTCOME_FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={source}
          onValueChange={(v) => {
            setSource(v);
            setLimit(PAGE_SIZE);
          }}
        >
          <SelectTrigger size="sm" aria-label="Filter by source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCE_FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <SettingsGroup>
        {isLoading && !data && (
          <SettingsRow>
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-72" />
            </div>
          </SettingsRow>
        )}
        {error && (
          <SettingsRow>
            <p className="text-xs text-muted-foreground">
              {error instanceof Error ? error.message : "Could not load the audit log"}
            </p>
          </SettingsRow>
        )}
        {!isLoading && !error && entries.length === 0 && (
          <SettingsRow className="flex-col items-center text-center py-8 gap-2">
            <HugeiconsIcon icon={Activity01Icon} size={24} className="text-dim-foreground" />
            <p className="text-sm text-muted-foreground">No activity matches these filters</p>
          </SettingsRow>
        )}
        {entries.map((entry) => (
          <AuditRow key={entry.id} entry={entry} />
        ))}
      </SettingsGroup>

      {canLoadMore && (
        <div className="flex justify-center">
          <Button
            size="sm"
            variant="ghost"
            disabled={isValidating}
            onClick={() => setLimit((l) => Math.min(l + PAGE_SIZE, MAX_LIMIT))}
          >
            {isValidating ? "Loading…" : "Show more"}
          </Button>
        </div>
      )}
    </div>
  );
}
