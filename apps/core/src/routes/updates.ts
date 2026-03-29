import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";

export const updates = new Hono();

const updatePolicySchema = z.object({
  policy: z.enum(["auto", "manual", "schedule"]).optional(),
  cron: z.string().max(100).nullable().optional(),
  preBackup: z.boolean().optional(),
});

interface InstalledRow { app_id: string; version: string; store_source_id: string }
interface CatalogRow { app_id: string; version: string; name: string; store_source_id: string }

// Check for available updates
updates.get("/", (c) => {
  const installed = db.all(sql`SELECT app_id, version, store_source_id FROM installed_apps`) as InstalledRow[];
  const results: { appId: string; name: string; installedVersion: string; availableVersion: string; hasUpdate: boolean }[] = [];

  for (const app of installed) {
    const catalog = db.get(sql`SELECT app_id, version, name FROM app_catalog WHERE app_id = ${app.app_id} AND store_source_id = ${app.store_source_id}`) as CatalogRow | undefined;
    if (!catalog) continue;
    const hasUpdate = catalog.version !== app.version && catalog.version !== "latest" && app.version !== "latest";
    results.push({
      appId: app.app_id,
      name: catalog.name ?? app.app_id,
      installedVersion: app.version,
      availableVersion: catalog.version,
      hasUpdate,
    });
  }

  return c.json(results);
});

// Get update policy for an app
updates.get("/policies/:appId", (c) => {
  const appId = c.req.param("appId");
  const policy = db.get(sql`SELECT * FROM app_update_policies WHERE app_id = ${appId}`) as Record<string, unknown> | undefined;
  return c.json(policy ?? { appId, policy: "manual", preBackup: true });
});

// Set update policy
updates.put("/policies/:appId", async (c) => {
  const appId = c.req.param("appId");
  const parsed = updatePolicySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const body = parsed.data;
  const now = new Date().toISOString();

  db.run(sql`INSERT INTO app_update_policies (app_id, policy, cron, pre_backup, created_at)
    VALUES (${appId}, ${body.policy ?? "manual"}, ${body.cron ?? null}, ${body.preBackup !== false ? 1 : 0}, ${now})
    ON CONFLICT(app_id) DO UPDATE SET policy = ${body.policy ?? "manual"}, cron = ${body.cron ?? null}, pre_backup = ${body.preBackup !== false ? 1 : 0}`);

  return c.json({ ok: true });
});
