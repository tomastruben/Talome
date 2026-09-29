import { db, schema } from "./index.js";
import { eq, and, gte, like } from "drizzle-orm";
import { ensureNotificationLinkColumn } from "./migrations/wire-backend.js";

export type NotificationType = "info" | "warning" | "critical";

// Exact title dedup — prevents identical notifications within this window
const TITLE_DEDUP_MS = 10 * 60 * 1000; // 10 minutes

// Source cooldown tiers — different subsystems need different suppression
const SOURCE_COOLDOWN_UPDATES_MS = 2 * 24 * 60 * 60 * 1000; // 2 days (app updates — noisy, low urgency)
const SOURCE_COOLDOWN_MONITORING_MS = 4 * 60 * 60 * 1000;    // 4 hours (CPU, disk, memory alerts)
const SOURCE_COOLDOWN_DEFAULT_MS = 30 * 60 * 1000;            // 30 minutes (general)
const SOURCE_COOLDOWN_EVENTS_MS = 2 * 60 * 1000;              // 2 minutes (installs, downloads)

// App update notifications — low urgency, suppress aggressively
const UPDATE_PATTERNS = ["updated", "upgraded"];

// One-off lifecycle events (short cooldown — each one matters)
const EVENT_PATTERNS = [
  "installed", "downloaded", "removed",
  "backup", "restored", "rolled back", "improved",
];

// Recurring monitoring (long cooldown — repetitive by nature)
const MONITORING_PATTERNS = [
  "cpu usage", "memory usage", "disk usage", "connectivity",
];

function getSourceCooldown(title: string): number {
  const lower = title.toLowerCase();
  if (UPDATE_PATTERNS.some((p) => lower.includes(p))) return SOURCE_COOLDOWN_UPDATES_MS;
  if (MONITORING_PATTERNS.some((p) => lower.includes(p))) return SOURCE_COOLDOWN_MONITORING_MS;
  if (EVENT_PATTERNS.some((p) => lower.includes(p))) return SOURCE_COOLDOWN_EVENTS_MS;
  return SOURCE_COOLDOWN_DEFAULT_MS;
}

/**
 * Check if an identical notification was written recently.
 * Two layers:
 *   1. Exact title match within short dedup window
 *   2. Same sourceId + similar prefix with context-aware cooldown
 */
function isDuplicate(title: string, sourceId?: string | null): boolean {
  try {
    // Layer 1: exact title match (short window — catches rapid-fire duplicates)
    const titleCutoff = new Date(Date.now() - TITLE_DEDUP_MS).toISOString();
    const titleMatch = db
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.title, title),
          gte(schema.notifications.createdAt, titleCutoff),
        ),
      )
      .limit(1)
      .get();
    if (titleMatch) return true;

    // Layer 2: same sourceId with similar title prefix, context-aware cooldown
    if (sourceId) {
      const cooldown = getSourceCooldown(title);
      const sourceCutoff = new Date(Date.now() - cooldown).toISOString();
      const prefix = title.slice(0, 30);
      const sourceMatch = db
        .select({ id: schema.notifications.id })
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.sourceId, sourceId),
            like(schema.notifications.title, `${prefix}%`),
            gte(schema.notifications.createdAt, sourceCutoff),
          ),
        )
        .limit(1)
        .get();
      if (sourceMatch) return true;
    }

    return false;
  } catch {
    return false; // On error, allow the notification through
  }
}

export interface WriteNotificationOptions {
  /**
   * In-app link for the notification (e.g. /dashboard/settings/approvals?id=…).
   * Must be a relative path inside the dashboard; anything else is dropped.
   */
  link?: string | null;
  /** Skip title/source de-duplication (default true = de-duplicate). */
  dedupe?: boolean;
}

/** Only same-origin, absolute-path links are stored — never external URLs. */
export function sanitizeNotificationLink(link: string | null | undefined): string | null {
  if (typeof link !== "string") return null;
  const trimmed = link.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\")) return null;
  if (/[\s<>"'`]/.test(trimmed)) return null;
  return trimmed.slice(0, 500);
}

function isMissingLinkColumn(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("link") && (msg.includes("no column") || msg.includes("has no column"));
}

function insertNotification(values: typeof schema.notifications.$inferInsert): void {
  try {
    db.insert(schema.notifications).values(values).run();
  } catch (err) {
    // A process that never ran migrations (the MCP stdio server against an
    // older server's DB) may lack the link column: add it and retry once.
    if (!isMissingLinkColumn(err)) throw err;
    ensureNotificationLinkColumn();
    db.insert(schema.notifications).values(values).run();
  }
}

export function writeNotification(
  type: NotificationType,
  title: string,
  body = "",
  sourceId?: string,
  options: WriteNotificationOptions = {},
) {
  // Skip if an identical notification was written recently
  if (options.dedupe !== false && isDuplicate(title, sourceId ?? null)) return;

  try {
    insertNotification({ type, title, body, sourceId: sourceId ?? null, link: sanitizeNotificationLink(options.link) });
  } catch {
    // Non-fatal — notifications are best-effort
  }

  // Push to connected messaging channels and notification channels
  // Level filtering is handled by each dispatch function
  if (type === "critical" || type === "warning") {
    import("../routes/notifications.js")
      .then(({ pushToMessaging }) => pushToMessaging(title, body, type))
      .catch(() => {});
  }
  // Dispatch to external channels (webhook, ntfy) — supports per-channel level filtering
  import("../notifications/channels.js")
    .then(({ dispatchToChannels }) => dispatchToChannels(title, body, type, sourceId))
    .catch(() => {});
}

export function getUnreadCount(): number {
  try {
    const rows = db
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(eq(schema.notifications.read, false))
      .all();
    return rows.length;
  } catch {
    return 0;
  }
}
