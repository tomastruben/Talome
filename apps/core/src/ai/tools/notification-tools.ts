import { tool } from "ai";
import { z } from "zod";
import { writeNotification } from "../../db/notifications.js";
import { db, schema } from "../../db/index.js";
import { eq, desc } from "drizzle-orm";

export const sendNotificationTool = tool({
  description: `Send a notification to the Talome dashboard. Use for proactive alerts, status updates, or important information the user should see even if they're not in the chat.

After calling: Confirm the notification was sent and its severity level.`,
  inputSchema: z.object({
    type: z
      .enum(["info", "warning", "critical"])
      .describe("Severity — critical and warning also push to messaging channels"),
    title: z.string().describe("Short notification title"),
    body: z.string().default("").describe("Optional longer description"),
  }),
  execute: async ({ type, title, body }) => {
    writeNotification(type, title, body);
    return {
      summary: `Sent ${type} notification: "${title}"`,
      status: "ok",
    };
  },
});

export const getNotificationsTool = tool({
  description: `Read recent notifications from the dashboard. Useful for understanding what alerts the user has received.

After calling: Summarise unread notifications first, then recent ones. Highlight any critical or warning items.`,
  inputSchema: z.object({
    unreadOnly: z.boolean().default(false).describe("Only return unread notifications"),
    limit: z.number().default(10).describe("Maximum notifications to return"),
  }),
  execute: async ({ unreadOnly, limit }) => {
    const rows = unreadOnly
      ? db
          .select()
          .from(schema.notifications)
          .where(eq(schema.notifications.read, false))
          .orderBy(desc(schema.notifications.createdAt))
          .limit(limit)
          .all()
      : db
          .select()
          .from(schema.notifications)
          .orderBy(desc(schema.notifications.createdAt))
          .limit(limit)
          .all();
    const unread = rows.filter((r) => !r.read).length;

    return {
      notifications: rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        body: r.body,
        read: r.read,
        createdAt: r.createdAt,
      })),
      count: rows.length,
      unreadCount: unread,
      summary: `${rows.length} notification(s), ${unread} unread.`,
    };
  },
});
