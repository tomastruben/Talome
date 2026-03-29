import { Hono } from "hono";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { fireTrigger } from "../automation/engine.js";

export const webhooks = new Hono();

interface AutomationRow {
  id: string;
  name: string;
  enabled: number;
  trigger: string;
}

// POST /api/webhooks/:automationId — unauthenticated webhook trigger
webhooks.post("/:automationId", async (c) => {
  const automationId = c.req.param("automationId");

  const automation = db.get(sql`SELECT id, name, enabled, trigger FROM automations WHERE id = ${automationId}`) as AutomationRow | undefined;

  if (!automation) {
    return c.json({ error: "Automation not found" }, 404);
  }

  if (!automation.enabled) {
    return c.json({ error: "Automation is disabled" }, 400);
  }

  // Parse trigger to verify it's a webhook type
  let trigger: { type?: string; webhookSecret?: string };
  try {
    trigger = JSON.parse(automation.trigger);
  } catch {
    return c.json({ error: "Invalid trigger configuration" }, 500);
  }

  if (trigger.type !== "webhook") {
    return c.json({ error: "Automation does not have a webhook trigger" }, 400);
  }

  // Optional HMAC verification — timing-safe to prevent side-channel attacks
  if (trigger.webhookSecret) {
    const signature = c.req.header("x-webhook-signature") ?? "";
    const expected = trigger.webhookSecret;
    // Pad to equal length for timingSafeEqual, then compare
    const sigBuf = Buffer.from(signature.padEnd(expected.length));
    const expBuf = Buffer.from(expected.padEnd(signature.length));
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return c.json({ error: "Invalid webhook signature" }, 403);
    }
  }

  // Parse payload
  let payload: Record<string, unknown> = {};
  try {
    payload = await c.req.json();
  } catch {
    // No body is fine
  }

  // Fire the trigger
  void fireTrigger("webhook", { automationId, payload });

  return c.json({ ok: true, message: `Webhook trigger fired for "${automation.name}"` });
});
