import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { serverError } from "../middleware/request-logger.js";

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
  try {
    const installed = db.all(sql`SELECT app_id, version, store_source_id FROM installed_apps`) as InstalledRow[];
    const results: { appId: string; storeId: string; name: string; installedVersion: string; availableVersion: string; hasUpdate: boolean }[] = [];

    for (const app of installed) {
      const catalog = db.get(sql`SELECT app_id, version, name FROM app_catalog WHERE app_id = ${app.app_id} AND store_source_id = ${app.store_source_id}`) as CatalogRow | undefined;
      if (!catalog) continue;
      const hasUpdate = catalog.version !== app.version && catalog.version !== "latest" && app.version !== "latest";
      results.push({
        appId: app.app_id,
        storeId: app.store_source_id,
        name: catalog.name ?? app.app_id,
        installedVersion: app.version,
        availableVersion: catalog.version,
        hasUpdate,
      });
    }

    return c.json(results);
  } catch (err) {
    return serverError(c, err, { message: "Failed to check for updates" });
  }
});

// Get available update info for a specific app
updates.get("/:appId", (c) => {
  try {
    const appId = c.req.param("appId");

    const installed = db.get(sql`SELECT app_id, version, store_source_id, installed_at, updated_at FROM installed_apps WHERE app_id = ${appId}`) as
      (InstalledRow & { installed_at: string; updated_at: string }) | undefined;
    if (!installed) return c.json({ error: "App not installed" }, 404);

    const catalog = db.get(sql`SELECT app_id, version, name, release_notes FROM app_catalog WHERE app_id = ${installed.app_id} AND store_source_id = ${installed.store_source_id}`) as
      (CatalogRow & { release_notes: string | null }) | undefined;
    if (!catalog) return c.json({ error: "App not in catalog" }, 404);

    const hasUpdate = catalog.version !== installed.version && catalog.version !== "latest" && installed.version !== "latest";

    return c.json({
      appId,
      name: catalog.name ?? appId,
      currentVersion: installed.version,
      availableVersion: catalog.version,
      hasUpdate,
      releaseNotes: catalog.release_notes || null,
      installedDate: installed.installed_at,
      lastUpdated: installed.updated_at,
    });
  } catch (err) {
    return serverError(c, err, { message: "Failed to get update info", context: { appId: c.req.param("appId") } });
  }
});

// Get update policy for an app
updates.get("/policies/:appId", (c) => {
  try {
    const appId = c.req.param("appId");
    const policy = db.get(sql`SELECT * FROM app_update_policies WHERE app_id = ${appId}`) as Record<string, unknown> | undefined;
    return c.json(policy ?? { appId, policy: "manual", preBackup: true });
  } catch (err) {
    return serverError(c, err, { message: "Failed to get update policy", context: { appId: c.req.param("appId") } });
  }
});

// Set update policy
updates.put("/policies/:appId", async (c) => {
  try {
    const appId = c.req.param("appId");
    const parsed = updatePolicySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const body = parsed.data;
    const now = new Date().toISOString();

    db.run(sql`INSERT INTO app_update_policies (app_id, policy, cron, pre_backup, created_at)
      VALUES (${appId}, ${body.policy ?? "manual"}, ${body.cron ?? null}, ${body.preBackup !== false ? 1 : 0}, ${now})
      ON CONFLICT(app_id) DO UPDATE SET policy = ${body.policy ?? "manual"}, cron = ${body.cron ?? null}, pre_backup = ${body.preBackup !== false ? 1 : 0}`);

    return c.json({ ok: true });
  } catch (err) {
    return serverError(c, err, { message: "Failed to set update policy", context: { appId: c.req.param("appId") } });
  }
});
