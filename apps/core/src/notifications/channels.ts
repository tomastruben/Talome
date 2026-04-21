import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { sendWebPush } from "./webpush.js";
import { sendEmail, type EmailConfig } from "./email.js";

interface ChannelRow {
  id: string;
  type: string;
  name: string;
  config: string;
  enabled: number;
}

interface ChannelFilter {
  /** Which severity levels to receive. Default: ["warning", "critical"] */
  levels?: string[];
  /** Which source categories to receive (e.g., "agent-loop", "docker-events"). Empty = all. */
  categories?: string[];
}

interface ChannelConfig {
  url?: string;
  topic?: string;
  headers?: Record<string, string>;
  filter?: ChannelFilter;
}

/** Check if a notification passes a channel's filter. */
function passesFilter(filter: ChannelFilter | undefined, level: string, sourceId?: string): boolean {
  if (!filter) return true; // No filter = receive everything (that reaches dispatch)

  // Level filter
  if (filter.levels && filter.levels.length > 0) {
    if (!filter.levels.includes(level)) return false;
  }

  // Category filter
  if (filter.categories && filter.categories.length > 0 && sourceId) {
    if (!filter.categories.some((cat) => sourceId.includes(cat))) return false;
  }

  return true;
}

/**
 * Dispatch a notification to all enabled channels.
 * Called from writeNotification for warning/critical levels.
 */
export async function dispatchToChannels(title: string, body: string, level: string, sourceId?: string): Promise<void> {
  // Only dispatch for warning and critical (unless a channel explicitly opts into info)
  if (level !== "warning" && level !== "critical" && level !== "info") return;

  const channels = db.all(sql`SELECT * FROM notification_channels WHERE enabled = 1`) as ChannelRow[];

  for (const channel of channels) {
    try {
      const config = JSON.parse(channel.config) as ChannelConfig;

      // Check channel-specific filter
      if (!passesFilter(config.filter, level, sourceId)) continue;

      // Default behavior: skip info unless filter explicitly includes it
      if (level === "info" && (!config.filter?.levels || !config.filter.levels.includes("info"))) continue;

      switch (channel.type) {
        case "webhook":
          if (config.url) {
            await fetch(config.url, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...config.headers },
              body: JSON.stringify({ title, body, level, sourceId, timestamp: new Date().toISOString() }),
            });
          }
          break;

        case "ntfy":
          if (config.url && config.topic) {
            await fetch(`${config.url}/${config.topic}`, {
              method: "POST",
              headers: {
                Title: title,
                Priority: level === "critical" ? "urgent" : "default",
                Tags: level === "critical" ? "rotating_light" : "warning",
              },
              body,
            });
          }
          break;

        case "email": {
          const emailConfig = config as unknown as EmailConfig;
          if (emailConfig.smtpHost && emailConfig.from && emailConfig.to?.length) {
            await sendEmail(emailConfig, title, body, level);
          }
          break;
        }

        case "webpush":
          // Handled below in bulk
          break;
      }
    } catch (err) {
      console.error(`[notifications] Failed to dispatch to ${channel.name}:`, err);
    }
  }

  // Send web push to all subscriptions (respects level — only warning/critical)
  if (level === "warning" || level === "critical") {
    try {
      await sendWebPush(title, body, level);
    } catch (err) {
      console.error("[notifications] Web push dispatch failed:", err);
    }
  }
}
