import { Hono } from "hono";
import { z } from "zod";
import {
  getVapidKeys,
  generateVapidKeys,
  addPushSubscription,
  removePushSubscription,
} from "../notifications/webpush.js";

export const push = new Hono();

// Get VAPID public key for client subscription
push.get("/vapid-key", async (c) => {
  let keys = getVapidKeys();
  if (!keys) {
    keys = await generateVapidKeys();
  }
  if (!keys) {
    return c.json({ error: "Web push not available. Install web-push package." }, 503);
  }
  return c.json({ publicKey: keys.publicKey });
});

// Subscribe to push notifications
const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

push.post("/subscribe", async (c) => {
  const body = subscribeSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);

  const id = addPushSubscription(body.data.endpoint, body.data.keys.p256dh, body.data.keys.auth);
  return c.json({ id }, 201);
});

// Unsubscribe from push notifications
push.delete("/subscribe", async (c) => {
  const body = await c.req.json() as { endpoint?: string };
  if (!body.endpoint) return c.json({ error: "endpoint required" }, 400);

  removePushSubscription(body.endpoint);
  return c.json({ ok: true });
});
