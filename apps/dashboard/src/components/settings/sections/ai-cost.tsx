"use client";

import useSWR from "swr";
import { useState } from "react";
import Link from "next/link";
import { SettingsGroup, SettingsRow, SectionLabel } from "@/components/settings/settings-primitives";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { HugeiconsIcon, Settings01Icon } from "@/components/icons";
import { CORE_URL } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { computePresetCost, ZONE_LABELS, type BudgetZone } from "@/lib/cost-projection";

// ── Types ────────────────────────────────────────────────────────────────────

interface ContextCost {
  costUsd: number;
  count: number;
}

interface CostData {
  today: { cost: number; cap: number; zone?: BudgetZone };
  last7d: {
    cost: number;
    tokensIn: number;
    tokensOut: number;
    byContext: Record<string, ContextCost>;
  };
  last30d: {
    cost: number;
    tokensIn: number;
    tokensOut: number;
    byContext: Record<string, ContextCost>;
  };
  dailyBreakdown: Array<{ date: string; cost: number; calls: number }>;
  projectedMonthly?: number;
  claudeCode?: {
    available: boolean;
    version: string | null;
  };
}

// ── Feature metadata ─────────────────────────────────────────────────────────

interface FeatureMeta {
  label: string;
  hint: string;
  category: "background" | "interactive";
}

const FEATURES: Record<string, FeatureMeta> = {
  agent_loop_triage:       { label: "Health checks",     hint: "Haiku classifies container events",       category: "background" },
  agent_loop_remediation:  { label: "Auto-remediation",  hint: "Diagnoses and fixes issues",              category: "background" },
  activity_summary:        { label: "Activity summary",  hint: "Summarises hourly system events",         category: "background" },
  evolution_scan:          { label: "Self-improvement",   hint: "Finds optimisation opportunities",        category: "background" },
  weekly_digest:           { label: "Weekly digest",      hint: "Generates your weekly server report",     category: "background" },
  chat:                    { label: "Chat",               hint: "Sonnet powers the dashboard assistant",   category: "interactive" },
  automation:              { label: "Automations",        hint: "Sonnet runs your custom automations",     category: "interactive" },
  memory_extraction:       { label: "Memory",             hint: "Haiku extracts facts from conversations", category: "interactive" },
  conversation_title:      { label: "Titles",             hint: "Haiku auto-titles conversations",         category: "interactive" },
  bug_hunt_augment:        { label: "Bug hunt",           hint: "Sonnet augments bug hunt analysis",       category: "interactive" },
  session_name_gen:        { label: "Session names",      hint: "Haiku generates terminal session names",  category: "interactive" },
};

// ── Formatters ───────────────────────────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function shortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function statusColor(pct: number): string {
  if (pct < 50) return "var(--status-healthy)";
  if (pct < 80) return "var(--status-warning)";
  return "var(--status-critical)";
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface BudgetPreset {
  label: string;
  cap: number;
  daily: string;
  monthly: string;
  desc: string;
  details: string[];
  // Agent loop
  interval: number;
  triage: number;
  remediation: number;
  autoRemediate: boolean;
  // Evolution
  autoScan: boolean;
  autoExecutePolicy: "none" | "low" | "medium";
}

const BUDGET_PRESETS: BudgetPreset[] = [
  {
    label: "Minimal",
    cap: 0.25,
    daily: "$0.25",
    monthly: "~$8/mo",
    desc: "Passive monitoring, chat only when you ask",
    details: ["Checks every 30 min", "No auto-fixes", "No auto-scan"],
    interval: 1_800_000,
    triage: 0.25,
    remediation: 0.125,
    autoRemediate: false,
    autoScan: false,
    autoExecutePolicy: "none",
  },
  {
    label: "Standard",
    cap: 1,
    daily: "$1.00",
    monthly: "~$30/mo",
    desc: "Active monitoring with manual fixes",
    details: ["Checks every 5 min", "Auto-scan on", "Suggests fixes"],
    interval: 300_000,
    triage: 5,
    remediation: 2,
    autoRemediate: false,
    autoScan: true,
    autoExecutePolicy: "none",
  },
  {
    label: "Power",
    cap: 5,
    daily: "$5.00",
    monthly: "~$150/mo",
    desc: "Full autonomy for low-risk issues",
    details: ["Checks every minute", "Auto-fixes low risk", "Self-improves"],
    interval: 60_000,
    triage: 30,
    remediation: 10,
    autoRemediate: true,
    autoScan: true,
    autoExecutePolicy: "low",
  },
  {
    label: "No limit",
    cap: 0,
    daily: "Uncapped",
    monthly: "",
    desc: "Maximum capability, fastest response",
    details: ["Checks every 30s", "Auto-fixes all", "Full self-improvement"],
    interval: 30_000,
    triage: 50,
    remediation: 15,
    autoRemediate: true,
    autoScan: true,
    autoExecutePolicy: "medium",
  },
];

// ── Component ────────────────────────────────────────────────────────────────

export function AiCostSection() {
  const { data, mutate } = useSWR<CostData>(
    `${CORE_URL}/api/settings/ai-cost`,
    fetcher,
    { refreshInterval: 30_000 },
  );

  const [editingCap, setEditingCap] = useState(false);
  const [capValue, setCapValue] = useState("");
  const [mobilePresetIdx, setMobilePresetIdx] = useState(-1);

  async function saveCap() {
    const cap = parseFloat(capValue);
    if (isNaN(cap) || cap < 0) return;
    await fetch(`${CORE_URL}/api/settings/ai-cost/cap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cap }),
    });
    setEditingCap(false);
    void mutate();
  }

  if (!data) return null;

  const hasCap = data.today.cap > 0;
  const todayPct = hasCap
    ? Math.min(100, (data.today.cost / data.today.cap) * 100)
    : 0;

  // Split 30-day contexts into background vs interactive
  const allContexts = Object.entries(data.last30d.byContext);
  const background = allContexts
    .filter(([ctx]) => (FEATURES[ctx]?.category ?? "background") === "background")
    .sort(([, a], [, b]) => b.costUsd - a.costUsd);
  const interactive = allContexts
    .filter(([ctx]) => FEATURES[ctx]?.category === "interactive")
    .sort(([, a], [, b]) => b.costUsd - a.costUsd);

  const backgroundTotal = background.reduce((s, [, v]) => s + v.costUsd, 0);
  const interactiveTotal = interactive.reduce((s, [, v]) => s + v.costUsd, 0);

  // Largest daily cost for relative bar widths
  const maxDayCost = Math.max(...data.dailyBreakdown.map((d) => d.cost), 0.01);

  // ── Projected cost per preset (from actual per-call costs) ──────
  const triageCpc = (() => {
    const ctx = data.last30d.byContext.agent_loop_triage;
    return ctx && ctx.count > 0 ? ctx.costUsd / ctx.count : 0.001;
  })();
  const remediationCpc = (() => {
    const ctx = data.last30d.byContext.agent_loop_remediation;
    return ctx && ctx.count > 0 ? ctx.costUsd / ctx.count : 0.01;
  })();
  const scanMonthly = data.last30d.byContext.evolution_scan?.costUsd ?? 0;
  const hasUsageData = data.last30d.cost > 0;

  const claudeCodeAvailable = data.claudeCode?.available ?? false;

  function estimateMonthly(preset: BudgetPreset): number {
    const hours = 24 * 30;
    const remCost = claudeCodeAvailable ? 0 : preset.remediation * hours * remediationCpc;
    const bg =
      preset.triage * hours * triageCpc +
      remCost +
      (preset.autoScan ? scanMonthly : 0);
    return bg + interactiveTotal;
  }

  // Pre-compute all preset breakdowns for the comparison table
  const presetData = BUDGET_PRESETS.map((preset) => {
    const isActive = preset.cap > 0
      ? Math.abs(data.today.cap - preset.cap) < 0.01
      : !hasCap;
    const projected = estimateMonthly(preset);
    const monthlyLabel = hasUsageData
      ? `~${formatCost(projected)}/mo`
      : preset.monthly;
    const breakdown = computePresetCost(preset, data.last30d.byContext, {
      claudeCodeAvailable: data.claudeCode?.available,
    });
    return { preset, isActive, monthlyLabel, breakdown };
  });
  const showInteractiveRow = presetData.some((d) => d.breakdown.interactiveBaseline > 0);

  // Resolve mobile tab: -1 means "use active preset"
  const resolvedMobileIdx = mobilePresetIdx >= 0
    ? mobilePresetIdx
    : Math.max(0, presetData.findIndex((d) => d.isActive));

  async function applyPreset(preset: BudgetPreset) {
    await Promise.all([
      fetch(`${CORE_URL}/api/settings/ai-cost/cap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cap: preset.cap }),
      }),
      fetch(`${CORE_URL}/api/agent-loop/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkIntervalMs: preset.interval,
          maxTriagePerHour: preset.triage,
          maxRemediationPerHour: preset.remediation,
          autoRemediate: preset.autoRemediate,
        }),
      }),
      fetch(`${CORE_URL}/api/agent-loop/evolution-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoScan: preset.autoScan,
          autoExecutePolicy: preset.autoExecutePolicy,
        }),
      }),
    ]);
    void mutate();
  }

  return (
    <div className="grid gap-8">
      {/* ── Today — hero card ─────────────────────────────────── */}
      <section>
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-6 pt-6 pb-5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-4">
              Today
            </p>

            {/* Cost + cap on one line */}
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-medium tabular-nums tracking-tight">
                {formatCost(data.today.cost)}
              </span>
              {hasCap && (
                <span className="text-sm text-muted-foreground tabular-nums">
                  / {formatCost(data.today.cap)}
                </span>
              )}
            </div>

            {/* Progress bar */}
            {hasCap && (
              <div className="mt-4 h-1 w-full rounded-full bg-muted/50 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500 ease-out"
                  style={{
                    width: `${Math.max(todayPct, 1)}%`,
                    backgroundColor: statusColor(todayPct),
                  }}
                />
              </div>
            )}

            {/* Budget zone explanation */}
            {data.today.zone && data.today.zone !== "green" && (
              <p className={cn(
                "text-xs mt-2",
                (data.today.zone === "yellow" || data.today.zone === "orange")
                  ? "text-[oklch(0.795_0.184_86.047/0.7)]"
                  : "text-[oklch(0.704_0.191_22.216/0.7)]",
              )}>
                {ZONE_LABELS[data.today.zone].detail}
              </p>
            )}
          </div>

          {/* Cap editor — separated by a quiet divider */}
          <div className="border-t border-border px-6 py-3.5 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-muted-foreground">
                Daily cap
              </p>
            </div>
            {editingCap ? (
              <div className="flex items-center gap-2">
                <InputGroup className="w-24 h-8">
                  <InputGroupAddon align="inline-start">
                    <InputGroupText className="text-xs text-muted-foreground">$</InputGroupText>
                  </InputGroupAddon>
                  <InputGroupInput
                    type="number"
                    className="h-8 text-sm"
                    value={capValue}
                    min={0}
                    step={0.1}
                    onChange={(e) => setCapValue(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveCap()}
                    autoFocus
                  />
                </InputGroup>
                <button
                  onClick={saveCap}
                  className="text-xs text-primary hover:underline"
                >
                  Save
                </button>
              </div>
            ) : (
              <button
                onClick={() => { setCapValue(String(data.today.cap)); setEditingCap(true); }}
                className="text-sm tabular-nums text-muted-foreground hover:text-foreground transition-colors"
              >
                {hasCap ? formatCost(data.today.cap) : "None"}
              </button>
            )}
          </div>
        </div>
      </section>

      {/* ── Budget presets ────────────────────────────────────── */}
      <section>
        <SectionLabel>Budget</SectionLabel>

        {/* ── Mobile: segmented control + single preset ──────── */}
        <div className="sm:hidden">
          {/* Segment tabs */}
          <div className="flex rounded-lg bg-muted/30 p-0.5 mb-4">
            {presetData.map(({ preset, isActive }, idx) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => setMobilePresetIdx(idx)}
                className={cn(
                  "flex-1 py-1.5 text-xs font-medium rounded-md transition-colors",
                  idx === resolvedMobileIdx
                    ? "bg-card shadow-sm"
                    : "text-muted-foreground",
                  idx === resolvedMobileIdx && isActive
                    ? "text-primary"
                    : idx === resolvedMobileIdx
                      ? "text-foreground"
                      : "",
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {/* Selected preset detail */}
          {(() => {
            const { preset, isActive, monthlyLabel, breakdown } = presetData[resolvedMobileIdx];
            const enabledItems = breakdown.items.filter((i) => i.enabled);
            return (
              <div className="rounded-xl border border-border bg-card overflow-hidden">
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      {monthlyLabel ? (
                        <p className="text-2xl font-medium tabular-nums">{monthlyLabel}</p>
                      ) : (
                        <p className="text-2xl font-medium">Uncapped</p>
                      )}
                      <p className="text-sm text-muted-foreground mt-1">{preset.desc}</p>
                      {preset.cap > 0 && (
                        <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
                          Cap: {preset.daily}/day
                        </p>
                      )}
                    </div>
                    {!isActive && (
                      <button
                        type="button"
                        onClick={() => applyPreset(preset)}
                        className="shrink-0 text-xs font-medium text-primary px-3 py-1.5 rounded-md border border-primary/20 hover:bg-primary/5 transition-colors"
                      >
                        Apply
                      </button>
                    )}
                    {isActive && (
                      <span className="shrink-0 text-xs text-muted-foreground px-3 py-1.5">
                        Active
                      </span>
                    )}
                  </div>
                </div>

                {/* Breakdown */}
                <div className="border-t border-border/30 px-4 py-3 space-y-2">
                  {enabledItems.map((item) => (
                    <div key={item.service} className="flex items-baseline justify-between">
                      <span className="text-sm text-muted-foreground">{item.service}</span>
                      <span className="text-sm tabular-nums text-muted-foreground">{formatCost(item.monthlyCost)}</span>
                    </div>
                  ))}
                  {breakdown.interactiveBaseline > 0 && (
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm text-muted-foreground">Interactive</span>
                      <span className="text-sm tabular-nums text-muted-foreground">{formatCost(breakdown.interactiveBaseline)}</span>
                    </div>
                  )}
                  <div className="border-t border-border/30 pt-2 flex items-baseline justify-between">
                    <span className="text-sm text-muted-foreground font-medium">Total</span>
                    <span className="text-sm tabular-nums text-muted-foreground font-medium">
                      ~{formatCost(breakdown.grandTotal)}/mo
                    </span>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>

        {/* ── Desktop: unified comparison table ──────────────── */}
        <div className="hidden sm:block">
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <table className="w-full border-collapse" aria-label="Budget preset comparison">
              <thead>
                <tr className="align-top">
                  <th className="w-[110px] min-w-[110px]" />
                  {presetData.map(({ preset, isActive, monthlyLabel }) => (
                    <th
                      key={preset.label}
                      className={cn(
                        "p-4 text-left font-normal border-l border-border/30 transition-colors",
                        isActive && "bg-primary/5",
                      )}
                    >
                      <button
                        type="button"
                        className="text-left w-full"
                        onClick={() => applyPreset(preset)}
                      >
                        <p className="text-sm font-medium">{preset.label}</p>
                        {monthlyLabel ? (
                          <p className="text-lg font-medium tabular-nums mt-1">{monthlyLabel}</p>
                        ) : (
                          <p className="text-lg font-medium mt-1">Uncapped</p>
                        )}
                        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{preset.desc}</p>
                        {preset.cap > 0 && (
                          <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
                            Cap: {preset.daily}/day
                          </p>
                        )}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="border-t border-border/50">
                {(["Health checks", "Auto-remediation", "Self-improvement", "Activity summary"] as const).map((service) => (
                  <tr key={service}>
                    <td className="pl-4 pr-2 py-1.5 text-xs text-muted-foreground whitespace-nowrap">
                      {service}
                    </td>
                    {presetData.map(({ preset, isActive, breakdown }) => {
                      const item = breakdown.items.find((i) => i.service === service);
                      return (
                        <td
                          key={preset.label}
                          className={cn(
                            "px-4 py-1.5 text-xs tabular-nums text-right whitespace-nowrap border-l border-border/30",
                            isActive ? "bg-primary/5 text-muted-foreground" : "text-muted-foreground",
                          )}
                        >
                          {item?.enabled ? formatCost(item.monthlyCost) : "\u2014"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {showInteractiveRow && (
                  <tr>
                    <td className="pl-4 pr-2 py-1.5 text-xs text-muted-foreground whitespace-nowrap">
                      Interactive
                    </td>
                    {presetData.map(({ preset, isActive, breakdown }) => (
                      <td
                        key={preset.label}
                        className={cn(
                          "px-4 py-1.5 text-xs tabular-nums text-right whitespace-nowrap border-l border-border/30",
                          isActive ? "bg-primary/5 text-muted-foreground" : "text-muted-foreground",
                        )}
                      >
                        {breakdown.interactiveBaseline > 0 ? formatCost(breakdown.interactiveBaseline) : "\u2014"}
                      </td>
                    ))}
                  </tr>
                )}
                <tr className="border-t border-border/50">
                  <td className="pl-4 pr-2 py-2 text-xs text-muted-foreground font-medium whitespace-nowrap">
                    Total
                  </td>
                  {presetData.map(({ preset, isActive, breakdown }) => (
                    <td
                      key={preset.label}
                      className={cn(
                        "px-4 py-2 text-xs tabular-nums font-medium text-right whitespace-nowrap border-l border-border/30",
                        isActive ? "bg-primary/5 text-muted-foreground" : "text-muted-foreground",
                      )}
                    >
                      ~{formatCost(breakdown.grandTotal)}/mo
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-xs text-muted-foreground mt-2 px-1">
          {hasUsageData ? "Projected from your last 30 days of usage" : "Estimated from model pricing"}
        </p>
      </section>

      {/* ── This Week ──────────────────────────────────────────── */}
      {data.dailyBreakdown.length > 0 && (
        <section>
          <SectionLabel>This Week</SectionLabel>
          <SettingsGroup>
            {data.dailyBreakdown.map((day) => {
              const barPct = (day.cost / maxDayCost) * 100;
              return (
                <SettingsRow key={day.date}>
                  <span className="w-28 shrink-0 text-sm text-muted-foreground">{shortDate(day.date)}</span>
                  <div className="flex-1 flex items-center gap-3">
                    <div className="flex-1 h-1 rounded-full bg-muted/50 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-foreground/20 transition-all duration-300 ease-out"
                        style={{ width: `${Math.max(barPct, 1)}%` }}
                      />
                    </div>
                    <span className="w-14 text-right text-sm tabular-nums">{formatCost(day.cost)}</span>
                  </div>
                </SettingsRow>
              );
            })}
            <SettingsRow className="bg-muted/20">
              <span className="flex-1 text-sm font-medium">7-day total</span>
              <span className="text-sm font-medium tabular-nums">{formatCost(data.last7d.cost)}</span>
            </SettingsRow>
          </SettingsGroup>
        </section>
      )}

      {/* ── Background AI (30 days) ───────────────────────────── */}
      {background.length > 0 && (
        <section>
          <SectionLabel>Background AI</SectionLabel>
          <p className="text-xs text-muted-foreground px-1 -mt-1 mb-2">
            Runs automatically — controlled by Intelligence settings
          </p>
          <SettingsGroup>
            {background.map(([ctx, info]) => {
              const meta = FEATURES[ctx];
              const claudeCodeRouted = ctx === "agent_loop_remediation" || ctx === "activity_summary" || ctx === "weekly_digest";
              const routedViaClaude = claudeCodeRouted && data.claudeCode?.available;
              return (
                <SettingsRow key={ctx}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm">{meta?.label ?? ctx.replace(/_/g, " ")}</p>
                      {routedViaClaude && (
                        <span className="text-xs text-[oklch(0.723_0.191_149.58/0.7)] px-1.5 py-0.5 rounded bg-[oklch(0.723_0.191_149.58/0.08)]">
                          via Claude Code
                        </span>
                      )}
                      <Link
                        href="/dashboard/settings/intelligence"
                        className="text-dim-foreground hover:text-muted-foreground transition-colors"
                        title="Intelligence settings"
                      >
                        <HugeiconsIcon icon={Settings01Icon} size={12} />
                      </Link>
                    </div>
                    {meta?.hint && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {routedViaClaude ? "Routed through Claude Code — included in subscription" : meta.hint}
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-sm tabular-nums">{formatCost(info.costUsd)}</span>
                    <p className="text-xs text-muted-foreground">{info.count} calls</p>
                  </div>
                </SettingsRow>
              );
            })}
            <SettingsRow className="bg-muted/20">
              <span className="flex-1 text-sm font-medium">Subtotal</span>
              <span className="text-sm font-medium tabular-nums">{formatCost(backgroundTotal)}</span>
            </SettingsRow>
          </SettingsGroup>
        </section>
      )}

      {/* ── Interactive (30 days) ─────────────────────────────── */}
      {interactive.length > 0 && (
        <section>
          <SectionLabel>Interactive</SectionLabel>
          <p className="text-xs text-muted-foreground px-1 -mt-1 mb-2">
            Triggered when you use Talome
          </p>
          <SettingsGroup>
            {interactive.map(([ctx, info]) => {
              const meta = FEATURES[ctx];
              return (
                <SettingsRow key={ctx}>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm">{meta?.label ?? ctx.replace(/_/g, " ")}</p>
                    {meta?.hint && (
                      <p className="text-xs text-muted-foreground mt-0.5">{meta.hint}</p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-sm tabular-nums">{formatCost(info.costUsd)}</span>
                    <p className="text-xs text-muted-foreground">{info.count} calls</p>
                  </div>
                </SettingsRow>
              );
            })}
            <SettingsRow className="bg-muted/20">
              <span className="flex-1 text-sm font-medium">Subtotal</span>
              <span className="text-sm font-medium tabular-nums">{formatCost(interactiveTotal)}</span>
            </SettingsRow>
          </SettingsGroup>
        </section>
      )}

      {/* ── 30-day total ──────────────────────────────────────── */}
      <section>
        <SettingsGroup>
          <SettingsRow>
            <span className="flex-1 text-sm font-medium">30-day total</span>
            <div className="text-right">
              <span className="text-lg font-medium tabular-nums">{formatCost(data.last30d.cost)}</span>
              <p className="text-xs text-muted-foreground mt-0.5">
                {formatTokens(data.last30d.tokensIn)} in / {formatTokens(data.last30d.tokensOut)} out
              </p>
            </div>
          </SettingsRow>
          {data.projectedMonthly != null && data.projectedMonthly > 0 && (
            <SettingsRow className="bg-muted/20">
              <span className="flex-1 text-sm text-muted-foreground">Projected monthly</span>
              <span className="text-sm tabular-nums text-muted-foreground">~{formatCost(data.projectedMonthly)}/mo</span>
            </SettingsRow>
          )}
        </SettingsGroup>
      </section>
    </div>
  );
}
