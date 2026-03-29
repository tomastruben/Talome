// ── Itemized cost projection for intelligence presets ────────────────────────

export type BudgetZone = "green" | "yellow" | "orange" | "red" | "exhausted";

export interface CostLineItem {
  service: string;
  model: string;
  callsPerMonth: number;
  perCallCost: number;
  monthlyCost: number;
  enabled: boolean;
}

export interface PresetCostBreakdown {
  items: CostLineItem[];
  backgroundTotal: number;
  interactiveBaseline: number;
  grandTotal: number;
}

interface CostContextEntry {
  costUsd: number;
  count: number;
}

interface PresetConfig {
  triage: number;
  remediation: number;
  autoScan: boolean;
}

// Fallback per-call costs when no usage data exists
const DEFAULT_TRIAGE_CPC = 0.001;
const DEFAULT_REMEDIATION_CPC = 0.01;
const DEFAULT_SCAN_MONTHLY = 0.05 * 4 * 30; // ~$6/mo at 4 scans/day
const DEFAULT_ACTIVITY_MONTHLY = 0.001 * 24 * 30; // ~$0.72/mo at 1/hr

const INTERACTIVE_CONTEXTS = ["chat", "automation", "memory_extraction", "conversation_title"];

export function computePresetCost(
  preset: PresetConfig,
  byContext?: Record<string, CostContextEntry>,
  options?: { claudeCodeAvailable?: boolean },
): PresetCostBreakdown {
  const hours = 24 * 30;

  // Derive per-call costs from actual usage, or use defaults
  const triageCtx = byContext?.agent_loop_triage;
  const triageCpc = triageCtx && triageCtx.count > 0
    ? triageCtx.costUsd / triageCtx.count
    : DEFAULT_TRIAGE_CPC;

  const remCtx = byContext?.agent_loop_remediation;
  const remCpc = remCtx && remCtx.count > 0
    ? remCtx.costUsd / remCtx.count
    : DEFAULT_REMEDIATION_CPC;

  const scanMonthly = byContext?.evolution_scan?.costUsd ?? DEFAULT_SCAN_MONTHLY;
  const activityMonthly = byContext?.activity_summary?.costUsd ?? DEFAULT_ACTIVITY_MONTHLY;

  const items: CostLineItem[] = [
    {
      service: "Health checks",
      model: "Haiku",
      callsPerMonth: preset.triage * hours,
      perCallCost: triageCpc,
      monthlyCost: preset.triage * hours * triageCpc,
      enabled: preset.triage > 0,
    },
    {
      service: "Auto-remediation",
      model: options?.claudeCodeAvailable ? "Claude Code" : "Sonnet",
      callsPerMonth: preset.remediation * hours,
      perCallCost: options?.claudeCodeAvailable ? 0 : remCpc,
      monthlyCost: options?.claudeCodeAvailable ? 0 : preset.remediation * hours * remCpc,
      enabled: preset.remediation > 0,
    },
    {
      service: "Self-improvement",
      model: "Sonnet",
      callsPerMonth: preset.autoScan ? 4 * 30 : 0,
      perCallCost: scanMonthly / (4 * 30) || 0,
      monthlyCost: preset.autoScan ? scanMonthly : 0,
      enabled: preset.autoScan,
    },
    {
      service: "Activity summary",
      model: "Haiku",
      callsPerMonth: 24 * 30,
      perCallCost: activityMonthly / (24 * 30) || 0,
      monthlyCost: activityMonthly,
      enabled: true,
    },
  ];

  const backgroundTotal = items.reduce((s, i) => s + i.monthlyCost, 0);

  const interactiveBaseline = INTERACTIVE_CONTEXTS.reduce(
    (sum, key) => sum + (byContext?.[key]?.costUsd ?? 0),
    0,
  );

  return {
    items,
    backgroundTotal,
    interactiveBaseline,
    grandTotal: backgroundTotal + interactiveBaseline,
  };
}

/** Format a calls/hour rate as a human-readable string. */
export function formatRate(callsPerHour: number): string {
  if (callsPerHour <= 0) return "Off";
  if (callsPerHour < 0.2) return `1 every ${Math.round(1 / callsPerHour)} hrs`;
  if (callsPerHour < 1) return `1 every ${Math.round(60 / callsPerHour)} min`;
  if (callsPerHour === 1) return "1/hr";
  return `${callsPerHour}/hr`;
}

/** Zone description for UI display */
export const ZONE_LABELS: Record<BudgetZone, { label: string; detail: string }> = {
  green: { label: "", detail: "" },
  yellow: {
    label: "Conserving",
    detail: "Evolution scans and activity summaries paused to conserve budget.",
  },
  orange: {
    label: "Reduced",
    detail: "Triage rate halved, non-critical remediation deferred.",
  },
  red: {
    label: "Critical only",
    detail: "Only critical events receive AI attention.",
  },
  exhausted: {
    label: "Paused",
    detail: "Daily budget reached. Background AI paused until midnight.",
  },
};
