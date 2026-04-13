import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testEmailChannel, type EmailConfig } from "../notifications/email.js";
import { serverError } from "../middleware/request-logger.js";

const notificationChannels = new Hono();

const addChannelSchema = z.object({
  type: z.enum(["webhook", "ntfy", "webpush", "email"]),
  name: z.string().min(1).max(100),
  config: z.record(z.string(), z.unknown()),
});

const patchChannelSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

interface ChannelRow {
  id: string;
  type: string;
  name: string;
  config: string;
  enabled: number;
  created_at: string;
}

// List all channels
notificationChannels.get("/", (c) => {
  try {
    const channels = db.all(
      sql`SELECT * FROM notification_channels ORDER BY created_at DESC`,
    ) as ChannelRow[];
    return c.json(
      channels.map((ch) => ({
        id: ch.id,
        type: ch.type,
        name: ch.name,
        enabled: Boolean(ch.enabled),
        config: (() => {
          try { return JSON.parse(ch.config); } catch { return {}; }
        })(),
      })),
    );
  } catch {
    return c.json([]);
  }
});

// Add a channel
notificationChannels.post("/", async (c) => {
  try {
    const parsed = addChannelSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.flatten() }, 400);
    const body = parsed.data;
    const id = randomUUID();
    const now = new Date().toISOString();
    const configJson = JSON.stringify(body.config);
    db.run(
      sql`INSERT INTO notification_channels (id, type, name, config, enabled, created_at)
          VALUES (${id}, ${body.type}, ${body.name}, ${configJson}, 1, ${now})`,
    );
    return c.json({ ok: true, id });
  } catch (err) {
    return serverError(c, err, { message: "Failed to add notification channel" });
  }
});

// Update a channel (PATCH — partial config update)
notificationChannels.patch("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const parsed = patchChannelSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.flatten() }, 400);
    const body = parsed.data;

    if (body.config !== undefined) {
      // Merge with existing config
      const existing = db.get(sql`SELECT config FROM notification_channels WHERE id = ${id}`) as { config: string } | undefined;
      if (!existing) return c.json({ ok: false, error: "Channel not found" }, 404);

      let current: Record<string, unknown> = {};
      try { current = JSON.parse(existing.config); } catch { /* empty */ }
      const merged = { ...current, ...body.config };
      db.run(sql`UPDATE notification_channels SET config = ${JSON.stringify(merged)} WHERE id = ${id}`);
    }

    if (body.enabled !== undefined) {
      db.run(sql`UPDATE notification_channels SET enabled = ${body.enabled ? 1 : 0} WHERE id = ${id}`);
    }

    return c.json({ ok: true });
  } catch (err) {
    return serverError(c, err, { message: "Failed to update notification channel" });
  }
});

// Delete a channel
notificationChannels.delete("/:id", (c) => {
  const id = c.req.param("id");
  try {
    db.run(sql`DELETE FROM notification_channels WHERE id = ${id}`);
    return c.json({ ok: true });
  } catch (err) {
    return serverError(c, err, { message: "Failed to delete notification channel" });
  }
});

// Test a channel
notificationChannels.post("/:id/test", async (c) => {
  const id = c.req.param("id");
  try {
    const channel = db.get(sql`SELECT * FROM notification_channels WHERE id = ${id}`) as ChannelRow | undefined;
    if (!channel) return c.json({ ok: false, error: "Channel not found" }, 404);

    const config = JSON.parse(channel.config) as { url?: string; topic?: string; headers?: Record<string, string> };

    switch (channel.type) {
      case "webhook": {
        if (!config.url) return c.json({ ok: false, error: "No URL configured" });
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
        if (!res.ok) return c.json({ ok: false, error: `Webhook returned ${res.status}` });
        return c.json({ ok: true });
      }
      case "ntfy": {
        if (!config.url || !config.topic) return c.json({ ok: false, error: "Missing url or topic" });
        const res = await fetch(`${config.url}/${config.topic}`, {
          method: "POST",
          headers: { Title: "Talome Test", Priority: "default", Tags: "test_tube" },
          body: "This is a test notification from Talome.",
        });
        if (!res.ok) return c.json({ ok: false, error: `ntfy returned ${res.status}` });
        return c.json({ ok: true });
      }
      case "email": {
        const emailConfig = config as unknown as EmailConfig;
        if (!emailConfig.smtpHost || !emailConfig.from || !emailConfig.to?.length) {
          return c.json({ ok: false, error: "Missing SMTP host, from, or to address" });
        }
        await testEmailChannel(emailConfig);
        return c.json({ ok: true });
      }
      default:
        return c.json({ ok: false, error: `Unsupported type: ${channel.type}` });
    }
  } catch (err) {
    return serverError(c, err, { message: "Failed to test notification channel" });
  }
});

export { notificationChannels };
