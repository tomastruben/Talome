import type { TalomeComponentId } from "@talome/types";

export const DESIGN_PATTERN_VERSION = "talome-patterns:2";

export interface DesignPattern {
  id: string;
  title: string;
  description: string;
  intents: readonly string[];
  layout: "dashboard" | "list" | "detail";
  dataShape: string;
  primaryAction: string;
  nativeComponents: readonly TalomeComponentId[];
  shadcnComponents: readonly string[];
  referencePaths: readonly string[];
  requiredStates: readonly string[];
  responsive: string;
  verification: readonly string[];
}

export const DESIGN_FOUNDATIONS = {
  renderer: "Talome AppSpec native renderer",
  componentFoundation: "shadcn/ui with Talome semantic tokens and HugeIcons",
  referencePath: "apps/dashboard/src/components/native-app/native-app-runtime.tsx",
  navigation: "Use surface IDs and declared actions. Cross-app navigation opens the destination desktop window; same-app navigation preserves the current window.",
  accessibility: "Name every control; preserve keyboard focus; provide pending, error, retry, empty and permission states. Confirm destructive actions through the shared action contract.",
  verification: "Exercise the primary workflow against the real app API and capture rendered evidence at phone (390px), tablet (768px), and compact desktop window (480px) widths. A pattern match is guidance, not a visual or functional pass.",
  charts: "Reuse the shipped Recharts renderer through shadcn ChartContainer; no added chart dependency is needed for line, area or grouped bar charts. Choose the chart from the user's comparison question, preserve missing observations as gaps, and include units plus a readable data table. chart-contract.json provides schema-validated examples, not production data.",
} as const;

// These are compositions of shipped native blocks, not new component APIs.
// Stable IDs are usable in experienceDesign.screens[].pattern, including legacy drafts.
export const DESIGN_PATTERNS: readonly DesignPattern[] = [
  {
    id: "analytical-comparison",
    title: "Compare categories and related measures",
    description: "Compare categories or multiple series, identify an exception, and inspect the underlying observations.",
    intents: ["compare", "comparison", "categories", "category", "chart", "charts", "bar", "multi-series", "series", "breakdown", "distribution"],
    layout: "dashboard",
    dataShape: "Ordered rows with a category or observation label and one to six numeric measures sharing the same unit; missing values stay null.",
    primaryAction: "Inspect the records behind a meaningful difference or ask the assistant to explain the observed comparison.",
    nativeComponents: ["time-series", "table", "stat", "actions"],
    shadcnComponents: ["chart", "table", "card", "button", "alert"],
    referencePaths: ["apps/dashboard/src/components/native-app/native-app-blocks.tsx", "apps/dashboard/src/components/ui/chart.tsx"],
    requiredStates: ["loading", "empty", "partial-data", "error", "permission-denied", "action-pending"],
    responsive: "Lead with the comparison chart, keep its legend and units visible, and place exact values in a labelled table below. Preserve signed values and gaps at 390, 480 and 768px; never shrink labels into illegibility.",
    verification: ["Chart marks, legend and exact-value table match the same source rows, including zero, negative and missing observations.", "Grouped bars compare categories; lines or areas use ordered observations. Every measure has the same unit; do not combine unrelated scales on one axis."],
  },
  {
    id: "collection-review",
    title: "Review a collection",
    description: "Find records, narrow the collection, inspect an item and act on it.",
    intents: ["records", "collection", "transactions", "activity", "inbox", "search", "filter", "spreadsheet", "table", "list"],
    layout: "list",
    dataShape: "An array with stable record IDs, readable labels and optional dates, status or values.",
    primaryAction: "Create or review a record using a declared action with explicit inputs.",
    nativeComponents: ["list", "table", "activity-list", "actions"],
    shadcnComponents: ["table", "input", "button", "dropdown-menu", "empty-state"],
    referencePaths: ["apps/dashboard/src/components/native-app/native-app-blocks.tsx", "apps/dashboard/src/components/native-app/native-app-premium-blocks.tsx"],
    requiredStates: ["loading", "empty", "no-results", "error", "permission-denied", "action-pending", "action-success"],
    responsive: "Keep the item identity and main action visible. Use readable rows on narrow screens; confine wide tables to a labelled horizontal scroll region.",
    verification: ["Search and filter yield the expected records and can be cleared.", "A row action receives the selected record ID, and refresh displays the resulting change."],
  },
  {
    id: "metric-monitor",
    title: "Monitor a changing system",
    description: "Understand current conditions and trends, then act on a meaningful exception.",
    intents: ["monitor", "metrics", "analytics", "dashboard", "trend", "weather", "telemetry", "health", "history"],
    layout: "dashboard",
    dataShape: "A current measurement with units and timestamps, plus ordered time-series observations.",
    primaryAction: "Investigate or resolve an exception; keep routine measurements secondary.",
    nativeComponents: ["stat", "time-series", "list", "actions"],
    shadcnComponents: ["card", "chart", "badge", "alert", "button"],
    referencePaths: ["apps/dashboard/src/components/native-app/talome-area-trend.tsx", "apps/dashboard/src/components/native-app/native-app-blocks.tsx"],
    requiredStates: ["loading", "empty", "stale-data", "error", "permission-denied", "action-pending"],
    responsive: "Stack charts and readings at compact widths. Preserve units, timestamps and chart labels. Do not imply that missing data is zero.",
    verification: ["Displayed measurements match the real data source, including units and timestamps.", "A failed or stale source remains distinguishable from healthy or zero values."],
  },
  {
    id: "record-detail",
    title: "Inspect one record",
    description: "Show one item's context, current state and available next action.",
    intents: ["detail", "inspect", "document", "report", "read", "article", "record"],
    layout: "detail",
    dataShape: "One named record with supporting text, properties and related entries.",
    primaryAction: "Perform the next meaningful action for this record; keep a clear return path.",
    nativeComponents: ["markdown", "stat", "list", "actions"],
    shadcnComponents: ["card", "button", "separator", "alert"],
    referencePaths: ["apps/dashboard/src/components/native-app/native-app-blocks.tsx"],
    requiredStates: ["loading", "not-found", "error", "permission-denied", "action-pending", "action-success"],
    responsive: "Use a single readable column in compact windows. Wrap long content and retain the record title and return action.",
    verification: ["Opening a record shows that record, including after reload.", "Return navigation stays inside the current app and destructive actions require confirmation."],
  },
  {
    id: "focused-task",
    title: "Complete a focused task",
    description: "Put a single task and its progress ahead of supporting information.",
    intents: ["timer", "stopwatch", "focus", "start", "pause", "resume", "progress", "task", "upload", "convert"],
    layout: "detail",
    dataShape: "One task state, progress or elapsed value, with explicitly available transitions.",
    primaryAction: "Start, resume or complete the task according to its current state.",
    nativeComponents: ["stat", "progress", "actions", "list"],
    shadcnComponents: ["button", "progress", "card", "alert"],
    referencePaths: ["apps/dashboard/src/components/native-app/native-app-runtime.tsx", "apps/dashboard/src/components/native-app/native-app-blocks.tsx"],
    requiredStates: ["idle", "running", "paused", "completed", "error", "action-pending", "permission-denied"],
    responsive: "Keep the main value and action visible without scrolling on phones. Group supporting history below; respect reduced motion.",
    verification: ["Each declared transition updates the real task and remains correct after refresh.", "Repeated activation while pending does not duplicate the operation."],
  },
  {
    id: "budget-workspace",
    title: "Review a budget",
    description: "Explain available money, planned versus actual spending and the transactions behind it.",
    intents: ["budget", "spending", "expense", "money", "finance", "balance", "allocation"],
    layout: "dashboard",
    dataShape: "Currency totals, category allocations and dated transactions backed by a consistent ledger.",
    primaryAction: "Review or add a transaction; explain its effect on the available balance.",
    nativeComponents: ["budget-overview", "comparison-bars", "activity-list", "actions"],
    shadcnComponents: ["card", "progress", "button", "input", "badge"],
    referencePaths: ["apps/dashboard/src/components/native-app/budget-overview-block.tsx", "apps/dashboard/src/components/native-app/native-app-premium-blocks.tsx"],
    requiredStates: ["loading", "empty", "no-results", "error", "permission-denied", "action-pending", "action-success"],
    responsive: "Stack overview, categories and transactions in task order. Preserve currency and signs; avoid dense grids in compact windows.",
    verification: ["Totals reconcile with transactions and category allocations.", "Adding or reviewing a transaction updates the shared ledger and visible totals."],
  },
];

function terms(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []);
}

/** Small deterministic keyword retrieval. No match stays explicit rather than inventing a fit. */
export function searchDesignPatterns(intent = "", limit = 3) {
  const query = terms(intent.slice(0, 2000));
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(10, Math.floor(limit))) : 3;
  const matches = DESIGN_PATTERNS.map((pattern) => {
    const authored = terms(pattern.intents.join(" "));
    const descriptive = terms(`${pattern.title} ${pattern.description}`);
    const matchedTerms = [...query].filter((term) => authored.has(term) || descriptive.has(term) || term === pattern.id);
    const score = matchedTerms.reduce((total, term) => total + (term === pattern.id ? 100 : authored.has(term) ? 4 : 1), 0);
    return { ...pattern, score, matchedTerms };
  }).filter((pattern) => query.size === 0 || pattern.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    version: DESIGN_PATTERN_VERSION,
    foundations: DESIGN_FOUNDATIONS,
    patterns: intent.trim() ? matches.slice(0, count) : matches,
  };
}

export function renderDesignPatternGuide() {
  return [
    "# Talome composition patterns",
    `Catalog version: ${DESIGN_PATTERN_VERSION}. Machine-readable contract: pattern-catalog.json in this instruction pack.`,
    "Discover by task vocabulary with GET /api/apps/design-patterns?intent=... (existing authenticated creator access). This is keyword guidance, not automatic design approval.",
    "Use a matching stable pattern ID in experienceDesign.screens[].pattern. Record its relevant required states and primary action in the screen plan. Explicitly explain any state that does not apply; do not implement fake transitions to satisfy a checklist.",
    "Use the existing native renderer and declared AppSpec actions for both user and assistant behavior. Native components below are alternatives to compose as needed, not a requirement to place every component. Reused open-source services must expose real domain data and actions; generic service uptime is not the requested app workflow.",
    ...Object.values(DESIGN_FOUNDATIONS),
    ...DESIGN_PATTERNS.map((pattern) => [
      `## ${pattern.id}: ${pattern.title}`,
      pattern.description,
      `Data: ${pattern.dataShape}`,
      `Primary action: ${pattern.primaryAction}`,
      `Native blocks: ${pattern.nativeComponents.join(", ")}. shadcn foundations: ${pattern.shadcnComponents.join(", ")}.`,
      `States: ${pattern.requiredStates.join(", ")}.`,
      `Responsive: ${pattern.responsive}`,
      `Verify: ${pattern.verification.join(" ")}`,
      `References: ${pattern.referencePaths.join(", ")}`,
    ].join("\n")),
  ].join("\n\n");
}
