"use client";

import { useState, useEffect, useMemo } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SettingsGroup, SettingsRow, SectionLabel } from "@/components/settings/settings-primitives";
import { CORE_URL } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { computePresetCost, formatRate } from "@/lib/cost-projection";

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentConfig {
  enabled: boolean;
  checkIntervalMs: number;
  maxTriagePerHour: number;
  maxRemediationPerHour: number;
  autoRemediate: boolean;
  restartLoopThreshold: number;
  highCpuThreshold: number;
  highMemoryThreshold: number;
  imageStalenessDays: number;
}

interface EvolutionConfig {
  autoScan: boolean;
  autoExecutePolicy: string;
  executionMode: string;
}

interface StatusResponse {
  config: AgentConfig;
  evolutionConfig: EvolutionConfig;
}

interface CostContextEntry {
  costUsd: number;
  count: number;
}

interface CostData {
  today: { cost: number; cap: number };
  last30d: {
    cost: number;
    byContext: Record<string, CostContextEntry>;
  };
  claudeCode?: {
    available: boolean;
    version: string | null;
  };
}

// ── Presets ───────────────────────────────────────────────────────────────────

interface Preset {
  label: string;
  cap: number;
  interval: number;
  triage: number;
  remediation: number;
  autoRemediate: boolean;
  autoScan: boolean;
  autoExecutePolicy: "none" | "low" | "medium";
}

const PRESETS: Preset[] = [
  {
    label: "Minimal",
    cap: 0.25,
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
    interval: 30_000,
    triage: 50,
    remediation: 15,
    autoRemediate: true,
    autoScan: true,
    autoExecutePolicy: "medium",
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

const INTERACTIVE_CONTEXTS = ["chat", "automation", "memory_extraction", "conversation_title"];

// ── Server mode toggle ──────────────────────────────────────────────────────

// ── Component ────────────────────────────────────────────────────────────────

export function IntelligenceSection() {
  const { data, mutate } = useSWR<StatusResponse>(
    `${CORE_URL}/api/agent-loop/status`,
    fetcher,
    { refreshInterval: 30_000 },
  );

  const { data: costData } = useSWR<CostData>(
    `${CORE_URL}/api/settings/ai-cost`,
    fetcher,
    { refreshInterval: 60_000 },
  );

  const [agent, setAgent] = useState<AgentConfig | null>(null);
  const [evo, setEvo] = useState<EvolutionConfig | null>(null);

  useEffect(() => {
    if (data?.config && !agent) setAgent(data.config);
    if (data?.evolutionConfig && !evo) setEvo({
      autoScan: data.evolutionConfig.autoScan ?? false,
      autoExecutePolicy: data.evolutionConfig.autoExecutePolicy || "none",
      executionMode: data.evolutionConfig.executionMode || "headless",
    });
  }, [data, agent, evo]);

  // ── Per-call costs from actual usage ──────────────────────────────────────

  const triageCpc = useMemo(() => {
    const ctx = costData?.last30d.byContext.agent_loop_triage;
    return ctx && ctx.count > 0 ? ctx.costUsd / ctx.count : 0.001;
  }, [costData]);

  const remediationCpc = useMemo(() => {
    const ctx = costData?.last30d.byContext.agent_loop_remediation;
    return ctx && ctx.count > 0 ? ctx.costUsd / ctx.count : 0.01;
  }, [costData]);

  const scanMonthly = useMemo(() => {
    return costData?.last30d.byContext.evolution_scan?.costUsd ?? 0;
  }, [costData]);

  const interactiveBaseline = useMemo(() => {
    if (!costData) return 0;
    return INTERACTIVE_CONTEXTS.reduce(
      (sum, key) => sum + (costData.last30d.byContext[key]?.costUsd ?? 0),
      0,
    );
  }, [costData]);

  // ── Live projected monthly cost from current settings ─────────────────────

  const claudeCodeAvailable = costData?.claudeCode?.available ?? false;

  const projectedMonthly = useMemo(() => {
    if (!agent || !costData) return 0;
    const hours = 24 * 30;
    const remCost = claudeCodeAvailable ? 0 : agent.maxRemediationPerHour * hours * remediationCpc;
    return (
      agent.maxTriagePerHour * hours * triageCpc +
      remCost +
      (evo?.autoScan ? scanMonthly : 0) +
      interactiveBaseline
    );
  }, [agent, evo, costData, triageCpc, remediationCpc, scanMonthly, interactiveBaseline, claudeCodeAvailable]);

  const hasUsageData = (costData?.last30d.cost ?? 0) > 0;

  // ── Mutations ─────────────────────────────────────────────────────────────

  async function updateAgent<K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) {
    setAgent((prev) => prev ? { ...prev, [key]: value } : prev);
    await fetch(`${CORE_URL}/api/agent-loop/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });
    void mutate();
  }

  async function updateEvo(patch: Partial<EvolutionConfig>) {
    setEvo((prev) => prev ? { ...prev, ...patch } : prev);
    await fetch(`${CORE_URL}/api/agent-loop/evolution-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    void mutate();
  }

  function isPresetActive(p: Preset): boolean {
    if (!agent || !evo) return false;
    return (
      agent.checkIntervalMs === p.interval &&
      agent.maxTriagePerHour === p.triage &&
      agent.maxRemediationPerHour === p.remediation &&
      agent.autoRemediate === p.autoRemediate &&
      evo.autoScan === p.autoScan &&
      evo.autoExecutePolicy === p.autoExecutePolicy
    );
  }

  async function applyPreset(p: Preset) {
    setAgent((prev) => prev ? {
      ...prev,
      checkIntervalMs: p.interval,
      maxTriagePerHour: p.triage,
      maxRemediationPerHour: p.remediation,
      autoRemediate: p.autoRemediate,
    } : prev);
    setEvo((prev) => prev ? {
      ...prev,
      autoScan: p.autoScan,
      autoExecutePolicy: p.autoExecutePolicy,
    } : prev);

    await Promise.all([
      fetch(`${CORE_URL}/api/settings/ai-cost/cap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cap: p.cap }),
      }),
      fetch(`${CORE_URL}/api/agent-loop/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkIntervalMs: p.interval,
          maxTriagePerHour: p.triage,
          maxRemediationPerHour: p.remediation,
          autoRemediate: p.autoRemediate,
        }),
      }),
      fetch(`${CORE_URL}/api/agent-loop/evolution-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoScan: p.autoScan,
          autoExecutePolicy: p.autoExecutePolicy,
        }),
      }),
    ]);
    void mutate();
  }

  if (!agent || !evo) return null;

  return (
    <div className="grid gap-8">
      {/* ── Cost Projection + Presets ────────────────────────────── */}
      {costData && (
        <section>
          <div className="rounded-xl border border-border bg-card px-4 py-4 sm:px-6 sm:py-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1">
                  Projected monthly
                </p>
                <p className="text-2xl font-medium tabular-nums tracking-tight">
                  ~{formatCost(projectedMonthly)}
                  <span className="text-base text-muted-foreground">/mo</span>
                </p>
              </div>
              <Link
                href="/dashboard/settings/ai-cost"
                className="text-xs text-dim-foreground hover:text-muted-foreground transition-colors"
              >
                Cost breakdown
              </Link>
            </div>

            {hasUsageData && (
              <p className="text-xs text-muted-foreground mt-1">
                Based on your last 30 days of usage
              </p>
            )}

            {/* Preset pills */}
            <TooltipProvider delayDuration={300}>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
                {PRESETS.map((p) => {
                  const breakdown = computePresetCost(p, costData?.last30d.byContext, { claudeCodeAvailable });
                  return (
                    <Tooltip key={p.label}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => applyPreset(p)}
                          className={cn(
                            "rounded-lg px-3 py-2 text-xs font-medium transition-all duration-150",
                            isPresetActive(p)
                              ? "bg-primary/10 text-primary border border-primary/20"
                              : "bg-muted/30 text-muted-foreground hover:bg-muted/50 border border-transparent",
                          )}
                        >
                          {p.label}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="w-64 p-3">
                        <div className="space-y-1">
                          {breakdown.items.filter((i) => i.enabled).map((item) => (
                            <div key={item.service} className="flex justify-between gap-3 text-xs">
                              <span className="text-muted-foreground truncate">
                                {item.service}
                                <span className="text-muted-foreground ml-1">
                                  {formatRate(item.service === "Health checks" ? p.triage : item.service === "Auto-remediation" ? p.remediation : 0)}
                                </span>
                              </span>
                              <span className="tabular-nums shrink-0">{formatCost(item.monthlyCost)}</span>
                            </div>
                          ))}
                          {breakdown.interactiveBaseline > 0 && (
                            <div className="flex justify-between gap-3 text-xs">
                              <span className="text-muted-foreground">Interactive</span>
                              <span className="tabular-nums">{formatCost(breakdown.interactiveBaseline)}</span>
                            </div>
                          )}
                          <div className="border-t border-border/50 pt-1 flex justify-between gap-3 text-xs font-medium">
                            <span>Total</span>
                            <span className="tabular-nums">~{formatCost(breakdown.grandTotal)}/mo</span>
                          </div>
                          {!hasUsageData && (
                            <p className="text-xs text-muted-foreground pt-0.5">Estimated from model pricing</p>
                          )}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </TooltipProvider>
          </div>
        </section>
      )}

      {/* ── Runtime Agent ──────────────────────────────────────────── */}
      <section>
        <SectionLabel>Runtime Agent</SectionLabel>
        <SettingsGroup>
          <SettingsRow>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">Background agent</p>
              <p className="text-xs text-muted-foreground mt-0.5">Monitor system health continuously</p>
            </div>
            <Switch checked={agent.enabled} onCheckedChange={(v) => updateAgent("enabled", v)} />
          </SettingsRow>
          <SettingsRow>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">Auto-remediate</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {claudeCodeAvailable
                  ? "Allow the agent to diagnose and fix issues via Claude Code"
                  : "Allow the agent to restart containers and clean resources"}
              </p>
            </div>
            <Switch checked={agent.autoRemediate} onCheckedChange={(v) => updateAgent("autoRemediate", v)} />
          </SettingsRow>
          <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
            <div className="flex-1 min-w-0">
              <Label className="text-sm font-medium">Check interval</Label>
              <p className="text-xs text-muted-foreground mt-0.5">How often to check system health</p>
            </div>
            <Select
              value={String(agent.checkIntervalMs)}
              onValueChange={(v) => updateAgent("checkIntervalMs", Number(v))}
            >
              <SelectTrigger className="w-36 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30000">30 seconds</SelectItem>
                <SelectItem value="60000">1 minute</SelectItem>
                <SelectItem value="120000">2 minutes</SelectItem>
                <SelectItem value="300000">5 minutes</SelectItem>
                <SelectItem value="600000">10 minutes</SelectItem>
                <SelectItem value="900000">15 minutes</SelectItem>
                <SelectItem value="1800000">30 minutes</SelectItem>
                <SelectItem value="3600000">1 hour</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
            <div className="flex-1 min-w-0">
              <Label className="text-sm font-medium">Triage rate</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Haiku — event classification</p>
            </div>
            <Select
              value={String(agent.maxTriagePerHour)}
              onValueChange={(v) => updateAgent("maxTriagePerHour", Number(v))}
            >
              <SelectTrigger className="w-40 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Off</SelectItem>
                <SelectItem value="0.125">1 every 8 hours</SelectItem>
                <SelectItem value="0.25">1 every 4 hours</SelectItem>
                <SelectItem value="0.5">1 every 2 hours</SelectItem>
                <SelectItem value="1">1 per hour</SelectItem>
                <SelectItem value="5">5 per hour</SelectItem>
                <SelectItem value="15">15 per hour</SelectItem>
                <SelectItem value="30">30 per hour</SelectItem>
                <SelectItem value="50">50 per hour</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
            <div className="flex-1 min-w-0">
              <Label className="text-sm font-medium">Remediation rate</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                {claudeCodeAvailable
                  ? "Via Claude Code — included in subscription"
                  : "Sonnet — diagnosis and fixes"}
              </p>
            </div>
            <Select
              value={String(agent.maxRemediationPerHour)}
              onValueChange={(v) => updateAgent("maxRemediationPerHour", Number(v))}
            >
              <SelectTrigger className="w-40 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Off</SelectItem>
                <SelectItem value="0.125">1 every 8 hours</SelectItem>
                <SelectItem value="0.25">1 every 4 hours</SelectItem>
                <SelectItem value="0.5">1 every 2 hours</SelectItem>
                <SelectItem value="1">1 per hour</SelectItem>
                <SelectItem value="2">2 per hour</SelectItem>
                <SelectItem value="5">5 per hour</SelectItem>
                <SelectItem value="10">10 per hour</SelectItem>
                <SelectItem value="15">15 per hour</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsGroup>
      </section>

      {/* ── Detection Thresholds ───────────────────────────────────── */}
      <section>
        <SectionLabel>Detection Thresholds</SectionLabel>
        <SettingsGroup>
          <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
            <div className="flex-1 min-w-0">
              <Label className="text-sm font-medium">CPU alert</Label>
            </div>
            <InputGroup className="w-20 h-8">
              <InputGroupInput
                type="number"
                className="h-8 text-sm text-right"
                value={agent.highCpuThreshold}
                min={50}
                max={100}
                onChange={(e) => updateAgent("highCpuThreshold", Number(e.target.value))}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText className="text-xs text-dim-foreground">%</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
          </SettingsRow>
          <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
            <div className="flex-1 min-w-0">
              <Label className="text-sm font-medium">Memory alert</Label>
            </div>
            <InputGroup className="w-20 h-8">
              <InputGroupInput
                type="number"
                className="h-8 text-sm text-right"
                value={agent.highMemoryThreshold}
                min={50}
                max={100}
                onChange={(e) => updateAgent("highMemoryThreshold", Number(e.target.value))}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText className="text-xs text-dim-foreground">%</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
          </SettingsRow>
          <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
            <div className="flex-1 min-w-0">
              <Label className="text-sm font-medium">Restart loop</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Restarts within 1 hour to trigger alert</p>
            </div>
            <InputGroup className="w-20 h-8">
              <InputGroupInput
                type="number"
                className="h-8 text-sm text-right"
                value={agent.restartLoopThreshold}
                min={2}
                max={10}
                onChange={(e) => updateAgent("restartLoopThreshold", Number(e.target.value))}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText className="text-xs text-dim-foreground">x</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
          </SettingsRow>
          <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
            <div className="flex-1 min-w-0">
              <Label className="text-sm font-medium">Image staleness</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Days before an image is flagged as stale</p>
            </div>
            <InputGroup className="w-24 h-8">
              <InputGroupInput
                type="number"
                className="h-8 text-sm text-right"
                value={agent.imageStalenessDays}
                min={1}
                max={365}
                onChange={(e) => updateAgent("imageStalenessDays", Number(e.target.value))}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText className="text-xs text-dim-foreground">days</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
          </SettingsRow>
        </SettingsGroup>
      </section>

      {/* ── Claude Code ────────────────────────────────────────────── */}
      {costData && (
        <section>
          <SectionLabel>Claude Code</SectionLabel>
          <SettingsGroup>
            <SettingsRow>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">Status</p>
                  {claudeCodeAvailable ? (
                    <span className="text-xs text-[oklch(0.723_0.191_149.58)] px-1.5 py-0.5 rounded bg-[oklch(0.723_0.191_149.58/0.08)]">
                      Connected
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground px-1.5 py-0.5 rounded bg-muted/30">
                      Not found
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 break-words">
                  {claudeCodeAvailable
                    ? `${costData.claudeCode?.version ?? "Unknown version"} — auto-remediation routed through subscription at no extra cost`
                    : "Install Claude Code to route remediation through your subscription instead of per-token API calls"}
                </p>
              </div>
            </SettingsRow>
          </SettingsGroup>
        </section>
      )}

      {/* ── Self-Improvement ───────────────────────────────────────── */}
      <section>
        <SectionLabel>Self-Improvement</SectionLabel>
        <SettingsGroup>
          <SettingsRow>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">Auto-scan</p>
              <p className="text-xs text-muted-foreground mt-0.5">Scan for improvement opportunities every 6 hours</p>
            </div>
            <Switch
              checked={evo.autoScan}
              onCheckedChange={(v) => updateEvo({ autoScan: v })}
            />
          </SettingsRow>
          <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">Auto-execute policy</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Each auto-improvement runs Claude Code. Failed changes are automatically rolled back.
              </p>
            </div>
            <Select
              value={evo.autoExecutePolicy || "none"}
              onValueChange={(v) => updateEvo({ autoExecutePolicy: v })}
            >
              <SelectTrigger className="w-44 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Off</SelectItem>
                <SelectItem value="low">Low risk only</SelectItem>
                <SelectItem value="medium">Low + Medium risk</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">Execution mode</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Headless runs silently in the background with auto-rollback.
                Terminal delegates tasks to your Claude Code session.
              </p>
            </div>
            <Select
              value={evo.executionMode || "headless"}
              onValueChange={(v) => updateEvo({ executionMode: v })}
            >
              <SelectTrigger className="w-36 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="headless">Headless</SelectItem>
                <SelectItem value="terminal">Terminal</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsGroup>
      </section>

      {/* ── Auto-Setup ────────────────────────────────────────────── */}
      <AutoSetupSection />

    </div>
  );
}

// ── Auto-Setup sub-section ──────────────────────────────────────────────────

function AutoSetupSection() {
  const { data: config, mutate } = useSWR<{
    autoConfigureEnabled: boolean;
    excludedApps: string[];
  }>(`${CORE_URL}/api/setup/config`, fetcher, { revalidateOnFocus: false });

  const { data: health } = useSWR<{
    apps: Array<{ appId: string; name: string; score: number }>;
  }>(`${CORE_URL}/api/setup/health-score`, fetcher, { revalidateOnFocus: false });

  async function toggleAutoConfig(enabled: boolean) {
    await fetch(`${CORE_URL}/api/setup/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoConfigureEnabled: enabled }),
    });
    void mutate();
  }

  async function toggleExclusion(appId: string) {
    if (!config) return;
    const excluded = new Set(config.excludedApps);
    if (excluded.has(appId)) excluded.delete(appId);
    else excluded.add(appId);
    await fetch(`${CORE_URL}/api/setup/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ excludedApps: [...excluded] }),
    });
    void mutate();
  }

  if (!config) return null;

  return (
    <section>
      <SectionLabel>Auto-Setup</SectionLabel>
      <SettingsGroup>
        <SettingsRow>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Auto-configure apps</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Automatically configure newly installed apps — extract API keys, set URLs, wire services
            </p>
          </div>
          <Switch
            checked={config.autoConfigureEnabled}
            onCheckedChange={toggleAutoConfig}
          />
        </SettingsRow>
        {health && health.apps.length > 0 && (
          <div className="px-4 py-3">
            <p className="text-xs text-muted-foreground mb-2">Exclude apps from auto-setup:</p>
            <div className="flex flex-wrap gap-1.5">
              {health.apps.map((app) => {
                const isExcluded = config.excludedApps.includes(app.appId);
                return (
                  <button
                    key={app.appId}
                    onClick={() => toggleExclusion(app.appId)}
                    className={cn(
                      "text-xs px-2.5 py-1 rounded-md transition-colors",
                      isExcluded
                        ? "bg-muted/50 text-muted-foreground line-through"
                        : "bg-foreground/[0.06] text-foreground",
                    )}
                  >
                    {app.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </SettingsGroup>
    </section>
  );
}
