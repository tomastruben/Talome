/**
 * Client-side types and pure helpers for the agent trust UI:
 * MCP token grants, approvals, and the audit log.
 *
 * Mirrors the core API in apps/core/src/routes/{mcp-tokens,approvals,audit-log}.ts
 * and apps/core/src/approval/grants.ts. Everything here is side-effect free so it
 * can be unit tested without a DOM.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ToolTier = "read" | "modify" | "destructive";

export interface TokenScopes {
  maxTier: ToolTier;
  domains: "all" | string[];
  tools?: string[];
  deniedTools?: string[];
  apps: "all" | string[];
}

export interface McpToken {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  legacy: boolean;
  scopes: TokenScopes;
}

export interface GrantCatalog {
  domains: { name: string; tools: { name: string; tier: ToolTier }[] }[];
  apps: string[];
  defaults: TokenScopes;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "consumed" | "expired";

export interface ApprovalItem {
  id: string;
  actor: { kind: string; id: string; label: string };
  source: string;
  tool: string;
  summary: string;
  argsPreview: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  consumedAt: string | null;
}

/** Shape of an `approval_required` tool result (see core ai/execution.ts). */
export interface ApprovalRequest {
  approvalId: string;
  approvalStatus: "pending" | "approved";
  tool: string;
  summary: string;
  expiresAt: string;
}

export type AuditOutcome = "success" | "error" | "blocked" | "approval_required";

export interface AuditEntry {
  id: number;
  timestamp: string;
  action: string;
  tier: ToolTier;
  approved: boolean;
  details: string;
  actorKind: string | null;
  actorId: string | null;
  actorLabel: string | null;
  source: string | null;
  toolName: string | null;
  outcome: string | null;
  durationMs: number | null;
}

// ── Tiers ────────────────────────────────────────────────────────────────────

export const TIER_RANK: Record<ToolTier, number> = { read: 0, modify: 1, destructive: 2 };

export const TIER_OPTIONS: { value: ToolTier; label: string; description: string }[] = [
  {
    value: "read",
    label: "Read",
    description: "Look, don't touch. See apps, containers, logs, stats and settings.",
  },
  {
    value: "modify",
    label: "Modify",
    description: "Everyday changes. Start, stop and configure apps, manage media and automations.",
  },
  {
    value: "destructive",
    label: "Destructive",
    description:
      "Full control, including uninstalling apps, deleting data and running shell commands. In Cautious mode each of these still waits for your approval.",
  },
];

const TIER_PHRASE: Record<ToolTier, string> = {
  read: "Read only",
  modify: "Read & modify",
  destructive: "Full control",
};

export function tierLabel(tier: string): string {
  return TIER_OPTIONS.find((t) => t.value === tier)?.label ?? tier;
}

// ── Names ────────────────────────────────────────────────────────────────────

/** "restart_app" → "Restart app" */
export function humanToolName(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  if (!words) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function listPhrase(items: string[], noun: string, pluralNoun: string): string {
  if (items.length === 0) return `no ${pluralNoun}`;
  if (items.length <= 2) return items.join(", ");
  return `${items.length} ${items.length === 1 ? noun : pluralNoun}`;
}

// ── Grant summary ────────────────────────────────────────────────────────────

/**
 * One-line plain-language summary of a token's access, e.g.
 * "Read only · all tools · all apps" or "Read & modify · arr, core · sonarr".
 */
export function summarizeScopes(scopes: TokenScopes, legacy = false): string {
  if (legacy) return "Legacy full access";
  const parts = [TIER_PHRASE[scopes.maxTier] ?? scopes.maxTier];
  parts.push(scopes.domains === "all" ? "all tools" : listPhrase(scopes.domains, "tool group", "tool groups"));
  parts.push(scopes.apps === "all" ? "all apps" : listPhrase(scopes.apps, "app", "apps"));
  if (scopes.tools && scopes.tools.length > 0) {
    parts.push(`only ${scopes.tools.length} ${scopes.tools.length === 1 ? "tool" : "tools"}`);
  }
  if (scopes.deniedTools && scopes.deniedTools.length > 0) {
    parts.push(`${scopes.deniedTools.length} blocked`);
  }
  return parts.join(" · ");
}

/** Grant editor validation: returns a message when the scopes cannot be saved. */
export function validateScopes(scopes: TokenScopes): string | null {
  if (scopes.domains !== "all" && scopes.domains.length === 0) return "Pick at least one tool group.";
  if (scopes.apps !== "all" && scopes.apps.length === 0) return "Pick at least one app.";
  return null;
}

/** Number of catalog tools a set of scopes would grant (tool-level check only). */
export function countGrantedTools(catalog: GrantCatalog, scopes: TokenScopes): number {
  let count = 0;
  for (const domain of catalog.domains) {
    if (scopes.domains !== "all" && !scopes.domains.includes(domain.name)) continue;
    for (const tool of domain.tools) {
      if (scopes.deniedTools?.includes(tool.name)) continue;
      if (scopes.tools && scopes.tools.length > 0 && !scopes.tools.includes(tool.name)) continue;
      if (TIER_RANK[tool.tier] > TIER_RANK[scopes.maxTier]) continue;
      count++;
    }
  }
  return count;
}

// ── Expiry ───────────────────────────────────────────────────────────────────

export type ExpiryPreset = "7d" | "30d" | "90d" | "never";

export const EXPIRY_OPTIONS: { value: ExpiryPreset; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "never", label: "Never" },
];

export function expiryPresetDays(preset: ExpiryPreset): number | null {
  switch (preset) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    default:
      return null;
  }
}

/** Absolute ISO expiry for a preset, or null for "never". */
export function expiryPresetToIso(preset: ExpiryPreset, now = Date.now()): string | null {
  const days = expiryPresetDays(preset);
  return days === null ? null : new Date(now + days * 86_400_000).toISOString();
}

export function isExpired(expiresAt: string | null, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= now;
}

/** "Never expires" · "Expires in 5h" · "Expires in 12d" · "Expired" */
export function formatExpiry(expiresAt: string | null, now = Date.now()): string {
  if (!expiresAt) return "Never expires";
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return "Never expires";
  const diff = t - now;
  if (diff <= 0) return "Expired";
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 1) return `Expires in ${Math.max(1, Math.floor(diff / 60_000))}m`;
  if (hours < 24) return `Expires in ${hours}h`;
  return `Expires in ${Math.floor(hours / 24)}d`;
}

// ── Countdown ────────────────────────────────────────────────────────────────

/** Milliseconds until `expiresAt` (never negative). */
export function msUntil(expiresAt: string, now = Date.now()): number {
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, t - now);
}

/** Countdown label: "14:05 left" · "1h 12m left" · "Expired" */
export function formatTimeLeft(expiresAt: string, now = Date.now()): string {
  const ms = msUntil(expiresAt, now);
  if (ms <= 0) return "Expired";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}h ${Math.floor((totalSeconds % 3600) / 60)}m left`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")} left`;
}

// ── Audit ────────────────────────────────────────────────────────────────────

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const ACTOR_KIND_LABELS: Record<string, string> = {
  user: "You",
  mcp_token: "MCP token",
  mcp_stdio: "Local MCP",
  automation: "Automation",
  agent_loop: "Agent loop",
};

const SOURCE_LABELS: Record<string, string> = {
  chat: "Chat",
  mcp: "MCP",
  automation: "Automation",
  agent_loop: "Agent loop",
  dashboard: "Dashboard",
};

export function sourceLabel(source: string | null | undefined): string {
  if (!source) return "";
  return SOURCE_LABELS[source] ?? humanToolName(source);
}

/** Who did it: the recorded label, else a generic label for the actor kind. */
export function actorDisplay(kind: string | null | undefined, label: string | null | undefined): string {
  if (label && label.trim()) return label.trim();
  if (kind) return ACTOR_KIND_LABELS[kind] ?? humanToolName(kind);
  return "Talome";
}

export type OutcomeTone = "healthy" | "warning" | "critical" | "muted";

export const OUTCOME_META: Record<AuditOutcome, { label: string; tone: OutcomeTone }> = {
  success: { label: "Succeeded", tone: "healthy" },
  error: { label: "Failed", tone: "critical" },
  blocked: { label: "Blocked", tone: "warning" },
  approval_required: { label: "Needs approval", tone: "warning" },
};

/**
 * Outcome for any audit row. Rows written before the trust columns existed
 * have no outcome; fall back to the legacy `approved` flag.
 */
export function auditOutcome(entry: Pick<AuditEntry, "outcome" | "approved">): { label: string; tone: OutcomeTone } {
  if (entry.outcome && entry.outcome in OUTCOME_META) return OUTCOME_META[entry.outcome as AuditOutcome];
  return entry.approved ? { label: "Recorded", tone: "muted" } : { label: "Blocked", tone: "warning" };
}

/** Build the audit-log query string for the active filters. */
export function auditQuery(filters: { outcome: string; source: string; limit: number }): string {
  const params = new URLSearchParams({ limit: String(filters.limit) });
  if (filters.outcome !== "all") params.set("outcome", filters.outcome);
  if (filters.source !== "all") params.set("source", filters.source);
  return params.toString();
}

/** Row title: approval decisions read as such; tool calls by their human name. */
export function auditTitle(entry: Pick<AuditEntry, "action" | "toolName">): string {
  const decision = /^Approval (approved|denied): (.+)$/.exec(entry.action);
  if (decision) return `${decision[1] === "approved" ? "Approved" : "Denied"}: ${humanToolName(decision[2])}`;
  if (entry.toolName) return humanToolName(entry.toolName);
  return entry.action;
}

// ── Approvals ────────────────────────────────────────────────────────────────

export const APPROVALS_PATH = "/dashboard/settings/approvals";

export function approvalHref(id: string): string {
  return `${APPROVALS_PATH}?id=${encodeURIComponent(id)}`;
}

const APPROVAL_ID_RE = /^apr_[A-Za-z0-9]{8,64}$/;

/**
 * Detect an `approval_required` tool result. Tool outputs may arrive as an
 * object or as a JSON string; anything malformed returns null.
 */
export function parseApprovalRequest(output: unknown): ApprovalRequest | null {
  let value = output;
  if (typeof value === "string") {
    if (!value.includes("approval_required")) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.status !== "approval_required") return null;
  if (typeof v.approvalId !== "string" || !APPROVAL_ID_RE.test(v.approvalId)) return null;
  if (typeof v.tool !== "string" || !v.tool) return null;
  return {
    approvalId: v.approvalId,
    approvalStatus: v.approvalStatus === "approved" ? "approved" : "pending",
    tool: v.tool,
    summary: typeof v.summary === "string" ? v.summary : "",
    expiresAt: typeof v.expiresAt === "string" ? v.expiresAt : "",
  };
}

const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: "Waiting",
  approved: "Approved",
  denied: "Denied",
  consumed: "Approved · ran",
  expired: "Expired",
};

export function approvalStatusLabel(status: ApprovalStatus): string {
  return APPROVAL_STATUS_LABELS[status] ?? status;
}

/** Status as the user should see it: a pending row past its TTL is expired. */
export function effectiveApprovalStatus(item: Pick<ApprovalItem, "status" | "expiresAt">, now = Date.now()): ApprovalStatus {
  if ((item.status === "pending" || item.status === "approved") && msUntil(item.expiresAt, now) <= 0) return "expired";
  return item.status;
}

/** Pending approvals that have not passed their TTL yet. */
export function livePending(items: ApprovalItem[] | undefined, now = Date.now()): ApprovalItem[] {
  if (!Array.isArray(items)) return [];
  return items.filter((a) => a.status === "pending" && msUntil(a.expiresAt, now) > 0);
}
