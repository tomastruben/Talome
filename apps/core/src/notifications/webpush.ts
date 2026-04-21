/**
 * Web Push notification support.
 * VAPID keys are auto-generated and stored in settings.
 * The web-push npm package is optional — if not installed, push is a no-op.
 */

import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Get or generate VAPID keys for web push.
 * Keys are stored in the settings table.
 */
export function getVapidKeys(): VapidKeys | null {
  try {
    const pubRow = db.get(sql`SELECT value FROM settings WHERE key = 'vapid_public_key'`) as { value: string } | undefined;
    const privRow = db.get(sql`SELECT value FROM settings WHERE key = 'vapid_private_key'`) as { value: string } | undefined;

    if (pubRow?.value && privRow?.value) {
      return { publicKey: pubRow.value, privateKey: privRow.value };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Try to load web-push dynamically. Returns null if not installed.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WEB_PUSH_MODULE = "web-push";

async function loadWebPush(): Promise<any | null> {
  try {
    return await import(WEB_PUSH_MODULE);
  } catch {
    return null;
  }
}

/**
 * Generate and store new VAPID keys.
 * Requires the web-push library — returns null if not available.
 */
export async function generateVapidKeys(): Promise<VapidKeys | null> {
  try {
    const webpush = await loadWebPush();
    if (!webpush) return null;

    const keys = webpush.generateVAPIDKeys() as VapidKeys;

    db.run(sql`INSERT INTO settings (key, value) VALUES ('vapid_public_key', ${keys.publicKey})
      ON CONFLICT(key) DO UPDATE SET value = ${keys.publicKey}`);
    db.run(sql`INSERT INTO settings (key, value) VALUES ('vapid_private_key', ${keys.privateKey})
      ON CONFLICT(key) DO UPDATE SET value = ${keys.privateKey}`);

    return keys;
  } catch {
    return null;
  }
}

/**
 * Send a web push notification to all subscribed clients.
 */
export async function sendWebPush(title: string, body: string, level: string): Promise<{ sent: number; failed: number }> {
  const keys = getVapidKeys();
  if (!keys) return { sent: 0, failed: 0 };

  const webpush = await loadWebPush();
  if (!webpush) return { sent: 0, failed: 0 };

  const emailRow = db.get(sql`SELECT value FROM settings WHERE key = 'proxy_email'`) as { value: string } | undefined;
  const email = emailRow?.value ?? "mailto:admin@talome.local";

  webpush.setVapidDetails(
    email.startsWith("mailto:") ? email : `mailto:${email}`,
    keys.publicKey,
    keys.privateKey,
  );

  const subscriptions = db.all(sql`SELECT * FROM push_subscriptions`) as PushSubscriptionRow[];

  let sent = 0;
  let failed = 0;

  const payload = JSON.stringify({ title, body, level, timestamp: new Date().toISOString() });

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        payload,
      );
      sent++;
    } catch (err: unknown) {
      failed++;
      // Remove expired subscriptions (410 Gone)
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 410 || statusCode === 404) {
        db.run(sql`DELETE FROM push_subscriptions WHERE id = ${sub.id}`);
      }
    }
  }

  return { sent, failed };
}

/**
 * Add a push subscription.
 */
export function addPushSubscription(endpoint: string, p256dh: string, auth: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.run(sql`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at)
    VALUES (${id}, ${endpoint}, ${p256dh}, ${auth}, ${now})`);
  return id;
}

/**
 * Remove a push subscription by endpoint.
 */
export function removePushSubscription(endpoint: string): void {
  db.run(sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`);
}
