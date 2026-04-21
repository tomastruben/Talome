import { tool } from "ai";
import { z } from "zod";
import { db } from "../../db/index.js";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

interface ChannelRow {
  id: string;
  type: string;
  name: string;
  config: string;
  enabled: number;
  created_at: string;
}

export const listNotificationChannelsTool = tool({
  description: "List all configured notification channels (webhook, ntfy, webpush, email).",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const channels = db.all(sql`SELECT * FROM notification_channels ORDER BY created_at DESC`) as ChannelRow[];
      return {
        success: true,
        channels: channels.map((ch) => {
          const config = (() => { try { return JSON.parse(ch.config); } catch { return ch.config; } })() as Record<string, unknown>;
          return {
            id: ch.id,
            type: ch.type,
            name: ch.name,
            enabled: Boolean(ch.enabled),
            config,
            filter: (config && typeof config === "object" && "filter" in config) ? config.filter : { levels: ["warning", "critical"], categories: [] },
          };
        }),
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

export const addNotificationChannelTool = tool({
  description: `Add a notification channel. Supported types:
- webhook: sends POST JSON to a URL on warning/critical events
- ntfy: sends to an ntfy.sh topic (or self-hosted ntfy server)

Config format per type:
- webhook: { url: "https://...", headers?: { ... } }
- ntfy: { url: "https://ntfy.sh", topic: "my-talome" }

Optional filter in config to control what gets sent:
- filter.levels: array of levels to receive, e.g. ["critical"] or ["warning", "critical"]
- filter.categories: array of source categories, e.g. ["agent-loop", "docker-events"]
  If omitted, all levels (warning+critical) and all categories are sent.
  To also receive info notifications, include "info" in filter.levels.`,
  inputSchema: z.object({
    type: z.enum(["webhook", "ntfy"]).describe("Channel type"),
    name: z.string().describe("Human-readable name for the channel"),
    config: z.record(z.string(), z.unknown()).describe("Channel-specific config (url, topic, headers, filter, etc.)"),
  }),
  execute: async ({ type, name, config }) => {
    try {
      const id = randomUUID();
      const now = new Date().toISOString();
      const configJson = JSON.stringify(config);
      db.run(sql`INSERT INTO notification_channels (id, type, name, config, enabled, created_at)
        VALUES (${id}, ${type}, ${name}, ${configJson}, 1, ${now})`);
      return { success: true, id, type, name };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

export const removeNotificationChannelTool = tool({
  description: "Remove a notification channel by ID.",
  inputSchema: z.object({
    id: z.string().describe("Channel ID to remove"),
  }),
  execute: async ({ id }) => {
    try {
      db.run(sql`DELETE FROM notification_channels WHERE id = ${id}`);
      return { success: true, message: `Channel ${id} removed.` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

export const testNotificationChannelTool = tool({
  description: "Send a test notification through a specific channel to verify it works.",
  inputSchema: z.object({
    id: z.string().describe("Channel ID to test"),
  }),
  execute: async ({ id }) => {
    try {
      const channel = db.get(sql`SELECT * FROM notification_channels WHERE id = ${id}`) as ChannelRow | undefined;
      if (!channel) return { success: false, error: "Channel not found" };

      const config = JSON.parse(channel.config) as { url?: string; topic?: string; headers?: Record<string, string> };

      switch (channel.type) {
        case "webhook": {
          if (!config.url) return { success: false, error: "No URL configured" };
          const res = await fetch(config.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...config.headers },
            body: JSON.stringify({
              title: "Talome Test Notification",
              body: "This is a test notification from Talome.",
              level: "info",
              timestamp: new Date().toISOString(),
            }),
          });
          if (!res.ok) return { success: false, error: `Webhook returned ${res.status}` };
          return { success: true, message: `Test sent to ${config.url}` };
        }
        case "ntfy": {
          if (!config.url || !config.topic) return { success: false, error: "Missing url or topic" };
          const res = await fetch(`${config.url}/${config.topic}`, {
            method: "POST",
            headers: { Title: "Talome Test", Priority: "default", Tags: "test_tube" },
            body: "This is a test notification from Talome.",
          });
          if (!res.ok) return { success: false, error: `ntfy returned ${res.status}` };
          return { success: true, message: `Test sent to ${config.url}/${config.topic}` };
        }
        default:
          return { success: false, error: `Unsupported channel type: ${channel.type}` };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});
