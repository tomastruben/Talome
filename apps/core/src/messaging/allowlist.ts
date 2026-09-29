/**
 * Who the Telegram and Discord bots answer.
 *
 * A bot message runs as an owner-level actor (the agent can restart, stop and
 * configure apps), so the bots answer only senders the owner allowed —
 * Telegram user ids / Discord user ids stored in `messaging_senders`. Every
 * other sender is refused: nothing they send reaches the agent or is stored
 * as a conversation. The refusal tells them their user id, and the owner is
 * notified (with a link to Settings -> Chat Bots, where the blocked sender can
 * be allowed with one click) — that is the pairing path.
 *
 * The list lives in its own table, not in settings: set_setting is a
 * modify-tier tool, and a scoped MCP token or the agent itself must not be
 * able to allow a sender. It is managed through admin-only routes
 * (routes/messaging-senders.ts). Existing single-owner setups keep working:
 * the table is seeded once from the senders of existing bot conversations
 * (db/migrations/wire-backend.ts).
 */

import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { writeNotification } from "../db/notifications.js";
import { writeAuditEntry } from "../db/audit.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("messaging");

export type MessagingPlatform = "telegram" | "discord";

export const MESSAGING_PLATFORMS: readonly MessagingPlatform[] = ["telegram", "discord"];

/** Telegram user ids and Discord user ids (snowflakes) are positive integers. */
export const SENDER_ID_PATTERN = /^[0-9]{1,32}$/;

export type SenderStatus = "allowed" | "rejected";

export interface MessagingSender {
  platform: MessagingPlatform;
  userId: string;
  status: SenderStatus;
  displayName: string | null;
  addedBy: string | null;
  rejectedCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Blocked senders kept per platform (for one-click allow); older ones are dropped. */
const MAX_REJECTED_PER_PLATFORM = 50;
/** One owner notification / audit entry per blocked sender per window. */
const REJECTION_NOTIFY_WINDOW_MS = 30 * 60 * 1000;
const lastRejectionNotice = new Map<string, number>();

const PLATFORM_LABEL: Record<MessagingPlatform, string> = { telegram: "Telegram", discord: "Discord" };

export const CHAT_BOTS_SETTINGS_LINK = "/dashboard/settings/integrations";

function cleanName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const cleaned = name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 80);
  return cleaned || null;
}

function toSender(row: typeof schema.messagingSenders.$inferSelect): MessagingSender {
  return {
    platform: row.platform as MessagingPlatform,
    userId: row.userId,
    status: row.status === "allowed" ? "allowed" : "rejected",
    displayName: row.displayName,
    addedBy: row.addedBy,
    rejectedCount: row.rejectedCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function findSender(platform: MessagingPlatform, userId: string): typeof schema.messagingSenders.$inferSelect | undefined {
  return db
    .select()
    .from(schema.messagingSenders)
    .where(and(eq(schema.messagingSenders.platform, platform), eq(schema.messagingSenders.userId, userId)))
    .get();
}

/** True only for a sender the owner allowed. Fails closed on any error. */
export function isAllowedSender(platform: MessagingPlatform, userId: string | null | undefined): boolean {
  if (!userId || !SENDER_ID_PATTERN.test(userId)) return false;
  try {
    return findSender(platform, userId)?.status === "allowed";
  } catch {
    return false;
  }
}

/** Allowed sender ids for a platform (e.g. to filter notification recipients). */
export function allowedSenderIds(platform: MessagingPlatform): Set<string> {
  try {
    return new Set(
      db
        .select({ userId: schema.messagingSenders.userId })
        .from(schema.messagingSenders)
        .where(and(eq(schema.messagingSenders.platform, platform), eq(schema.messagingSenders.status, "allowed")))
        .all()
        .map((r) => r.userId),
    );
  } catch {
    return new Set();
  }
}

/** Every allowed and recently blocked sender, newest first. */
export function listSenders(platform?: MessagingPlatform): MessagingSender[] {
  const query = db.select().from(schema.messagingSenders);
  const rows = platform
    ? query.where(eq(schema.messagingSenders.platform, platform)).orderBy(desc(schema.messagingSenders.updatedAt)).all()
    : query.orderBy(desc(schema.messagingSenders.updatedAt)).all();
  return rows.map(toSender);
}

/** Allow a sender (owner action). Keeps a known display name. */
export function allowSender(platform: MessagingPlatform, userId: string, displayName?: string | null): MessagingSender {
  if (!SENDER_ID_PATTERN.test(userId)) throw new Error("Invalid user id");
  const now = new Date().toISOString();
  const name = cleanName(displayName);
  db.insert(schema.messagingSenders)
    .values({ platform, userId, status: "allowed", displayName: name, addedBy: "owner", createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [schema.messagingSenders.platform, schema.messagingSenders.userId],
      set: { status: "allowed", addedBy: "owner", updatedAt: now, ...(name ? { displayName: name } : {}) },
    })
    .run();
  lastRejectionNotice.delete(`${platform}:${userId}`);
  writeAuditEntry(`Messaging: allowed ${PLATFORM_LABEL[platform]} sender ${userId}`, "modify", name ?? "");
  return toSender(findSender(platform, userId)!);
}

/** Remove a sender (allowed or blocked). Returns false when unknown. */
export function removeSender(platform: MessagingPlatform, userId: string): boolean {
  const res = db
    .delete(schema.messagingSenders)
    .where(and(eq(schema.messagingSenders.platform, platform), eq(schema.messagingSenders.userId, userId)))
    .run();
  if (res.changes > 0) writeAuditEntry(`Messaging: removed ${PLATFORM_LABEL[platform]} sender ${userId}`, "modify");
  return res.changes > 0;
}

function pruneRejected(platform: MessagingPlatform): void {
  const keep = db
    .select({ userId: schema.messagingSenders.userId })
    .from(schema.messagingSenders)
    .where(and(eq(schema.messagingSenders.platform, platform), eq(schema.messagingSenders.status, "rejected")))
    .orderBy(desc(schema.messagingSenders.updatedAt))
    .limit(MAX_REJECTED_PER_PLATFORM)
    .all()
    .map((r) => r.userId);
  if (keep.length < MAX_REJECTED_PER_PLATFORM) return;
  db.delete(schema.messagingSenders)
    .where(and(
      eq(schema.messagingSenders.platform, platform),
      eq(schema.messagingSenders.status, "rejected"),
      notInArray(schema.messagingSenders.userId, keep),
    ))
    .run();
}

/** Record a refused sender, and tell the owner (once per sender per window). */
function recordRejectedSender(platform: MessagingPlatform, userId: string, senderName: string | null): void {
  const now = new Date();
  try {
    db.insert(schema.messagingSenders)
      .values({
        platform,
        userId,
        status: "rejected",
        displayName: senderName,
        addedBy: "rejected",
        rejectedCount: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })
      .onConflictDoUpdate({
        target: [schema.messagingSenders.platform, schema.messagingSenders.userId],
        set: {
          rejectedCount: sql`${schema.messagingSenders.rejectedCount} + 1`,
          updatedAt: now.toISOString(),
          ...(senderName ? { displayName: senderName } : {}),
        },
      })
      .run();
    pruneRejected(platform);
  } catch (err) {
    log.error("Could not record a blocked sender", err);
  }

  const key = `${platform}:${userId}`;
  const last = lastRejectionNotice.get(key);
  if (last !== undefined && now.getTime() - last < REJECTION_NOTIFY_WINDOW_MS) return;
  lastRejectionNotice.set(key, now.getTime());

  const label = PLATFORM_LABEL[platform];
  const who = senderName ? `${senderName} (${label} user id ${userId})` : `${label} user id ${userId}`;
  log.warn(`Blocked a ${label} message from an unknown sender`, { platform, userId });
  writeAuditEntry(`Messaging: blocked ${label} sender ${userId}`, "read", who, false);
  writeNotification(
    "warning",
    `${label}: blocked unknown sender ${userId}`,
    `${who} messaged your ${label} bot. The bot answers only senders you allow, so the message was ignored. If this is you (or someone you trust), allow them in Settings -> Chat Bots.`,
    `messaging:${platform}:${userId}`,
    { link: CHAT_BOTS_SETTINGS_LINK },
  );
}

export type SenderDecision = { allowed: true } | { allowed: false; reply: string };

/** What a refused sender is told: their id, and how to get access. */
export function rejectionReply(platform: MessagingPlatform, userId: string | null | undefined): string {
  const label = PLATFORM_LABEL[platform];
  const id = userId && SENDER_ID_PATTERN.test(userId) ? ` Your ${label} user id is ${userId}.` : "";
  return `This Talome server only answers people its owner has allowed.${id} Ask the owner to allow it in Talome: Settings -> Chat Bots.`;
}

/**
 * The gate every bot message and command passes first. Allowed senders
 * continue; anyone else is refused (recorded, owner notified) and gets the
 * pairing instructions as the reply.
 */
export function authorizeSender(
  platform: MessagingPlatform,
  senderId: string | null | undefined,
  senderName?: string | null,
): SenderDecision {
  if (isAllowedSender(platform, senderId)) return { allowed: true };
  if (senderId && SENDER_ID_PATTERN.test(senderId)) recordRejectedSender(platform, senderId, cleanName(senderName));
  return { allowed: false, reply: rejectionReply(platform, senderId) };
}

/** Test-only: forget notification throttling. */
export function __resetSenderNoticesForTests(): void {
  lastRejectionNotice.clear();
}
