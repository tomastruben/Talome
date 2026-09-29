/**
 * Data-retention settings — mirrors apps/core/src/db/retention.ts
 * (RETENTION_SETTING_KEYS, DEFAULT_RETENTION and the per-key minimums).
 * Values are stored through the generic settings API as strings. In the form
 * draft an empty value means "use the default"; because core POST
 * /api/settings skips empty strings (it never deletes a key), clearing a
 * stored value is persisted as the explicit default, which core
 * resolveRetentionConfig treats exactly like an absent key.
 */

export interface RetentionField {
  key: string;
  label: string;
  description: string;
  unit: "days" | "runs";
  defaultValue: number;
  min: number;
  max: number;
  /** 0 is allowed and means "keep forever". */
  zeroMeansForever?: boolean;
}

const MAX_DAYS = 3650;

export const RETENTION_FIELDS: readonly RetentionField[] = [
  {
    key: "retention_audit_log_days",
    label: "Audit log",
    description: "Every action by the assistant, agents and automations",
    unit: "days",
    defaultValue: 90,
    min: 1,
    max: MAX_DAYS,
  },
  {
    key: "retention_system_events_days",
    label: "System events",
    description: "Health and supervisor events",
    unit: "days",
    defaultValue: 90,
    min: 1,
    max: MAX_DAYS,
  },
  {
    key: "retention_container_events_days",
    label: "Container events",
    description: "Container starts, stops and crashes",
    unit: "days",
    defaultValue: 90,
    min: 1,
    max: MAX_DAYS,
  },
  {
    key: "retention_remediation_log_days",
    label: "Auto-remediation log",
    description: "What the agent loop tried when something broke",
    unit: "days",
    defaultValue: 90,
    min: 1,
    max: MAX_DAYS,
  },
  {
    key: "retention_ai_usage_log_days",
    label: "AI usage",
    description: "Token usage behind API Cost and daily caps (at least 31 days)",
    unit: "days",
    defaultValue: 90,
    min: 31,
    max: MAX_DAYS,
  },
  {
    key: "retention_install_errors_days",
    label: "Install errors",
    description: "Failed installs kept for troubleshooting",
    unit: "days",
    defaultValue: 90,
    min: 1,
    max: MAX_DAYS,
  },
  {
    key: "retention_notifications_read_days",
    label: "Read notifications",
    description: "Notifications you have already seen",
    unit: "days",
    defaultValue: 30,
    min: 1,
    max: MAX_DAYS,
  },
  {
    key: "retention_notifications_unread_days",
    label: "Unread notifications",
    description: "0 keeps unread notifications forever",
    unit: "days",
    defaultValue: 0,
    min: 0,
    max: MAX_DAYS,
    zeroMeansForever: true,
  },
  {
    key: "retention_evolution_runs_keep",
    label: "Self-improvement runs",
    description: "Most recent runs to keep (running ones are never deleted)",
    unit: "runs",
    defaultValue: 200,
    min: 10,
    max: 100_000,
  },
];

export const RETENTION_KEYS: readonly string[] = RETENTION_FIELDS.map((f) => f.key);

/** Draft values keyed by settings key; "" = use the default. */
export type RetentionDraft = Record<string, string>;

/** Stored settings → form draft (unknown/invalid stored values show as the default). */
export function retentionDraftFromSettings(settings: Record<string, unknown> | null | undefined): RetentionDraft {
  const draft: RetentionDraft = {};
  for (const field of RETENTION_FIELDS) {
    const raw = settings?.[field.key];
    const value = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
    draft[field.key] = /^\d+$/.test(value) ? String(Number(value)) : "";
  }
  return draft;
}

/** Validate one value. Returns an error message, or null when valid (empty = default). */
export function validateRetentionValue(field: RetentionField, raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;
  if (!/^\d+$/.test(value)) return "Enter a whole number";
  const n = Number(value);
  if (n === 0 && field.zeroMeansForever) return null;
  if (n < field.min) return `Minimum is ${field.min} ${field.unit}`;
  if (n > field.max) return `Maximum is ${field.max.toLocaleString()} ${field.unit}`;
  return null;
}

/** Field errors keyed by settings key; empty when the whole draft is valid. */
export function validateRetentionDraft(draft: RetentionDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of RETENTION_FIELDS) {
    const error = validateRetentionValue(field, draft[field.key] ?? "");
    if (error) errors[field.key] = error;
  }
  return errors;
}

/**
 * The settings to POST: only changed keys, normalised. A cleared field that
 * had a stored value is sent as the explicit default — core ignores "" and
 * would otherwise keep the old value.
 */
export function retentionChanges(initial: RetentionDraft, draft: RetentionDraft): Record<string, string> {
  const changes: Record<string, string> = {};
  for (const field of RETENTION_FIELDS) {
    const before = (initial[field.key] ?? "").trim();
    const raw = (draft[field.key] ?? "").trim();
    if (raw === "") {
      if (before !== "" && before !== String(field.defaultValue)) changes[field.key] = String(field.defaultValue);
      continue;
    }
    const after = String(Number(raw));
    if (after !== before) changes[field.key] = after;
  }
  return changes;
}

/** "90 days", "Forever", "200 runs" — the value that applies when the field is empty. */
export function describeRetentionDefault(field: RetentionField): string {
  if (field.zeroMeansForever && field.defaultValue === 0) return "Forever";
  return `${field.defaultValue.toLocaleString()} ${field.unit}`;
}
