import { Hono } from "hono";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { addStore, removeStore, syncStore, syncAllStores } from "../stores/sync.js";
import { UmbrelInstallOptionsSchema } from "../stores/umbrel-v2.js";
import { previewUmbrelV2Install } from "../stores/umbrel-v2-install.js";

const stores = new Hono();

const addStoreSchema = z.object({
  name: z.string().min(1).max(100),
  gitUrl: z.string().url().max(500),
  branch: z.string().max(100).optional(),
});

stores.get("/", (c) => {
  const sources = db.select().from(schema.storeSources).all();
  return c.json(sources);
});

stores.post("/", async (c) => {
  const parsed = addStoreSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { name, gitUrl, branch } = parsed.data;

  const result = await addStore(name, gitUrl, branch || "main");

  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }

  return c.json({ id: result.id, ok: true });
});

stores.delete("/:id", (c) => {
  const id = c.req.param("id");
  removeStore(id);
  return c.json({ ok: true });
});

/** `?force=1` re-parses even when the store's git HEAD is unchanged. */
const syncQuerySchema = z.object({
  force: z.enum(["1", "true", "0", "false"]).optional(),
});

function isForced(query: Record<string, string>): boolean | null {
  const parsed = syncQuerySchema.safeParse(query);
  if (!parsed.success) return null;
  return parsed.data.force === "1" || parsed.data.force === "true";
}

stores.post("/:id/sync", async (c) => {
  const id = c.req.param("id");
  const force = isForced(c.req.query());
  if (force === null) return c.json({ error: "Invalid force flag" }, 400);
  const result = await syncStore(id, { force });
  return c.json(result);
});

stores.post("/sync-all", async (c) => {
  const force = isForced(c.req.query());
  if (force === null) return c.json({ error: "Invalid force flag" }, 400);
  const results = await syncAllStores({ force });
  return c.json(results);
});

/**
 * Preview how an Umbrel app would be installed: folderAccess slots with their
 * default host folders, environment inputs (defaults/options), GPU, data
 * root, dependency providers, warnings and blockers (e.g. torOnly).
 * Body (optional): the same `umbrel` install options accepted by
 * POST /api/apps/:storeId/:appId/install.
 */
stores.post("/:storeId/apps/:appId/install-plan", async (c) => {
  const { storeId, appId } = c.req.param();
  const body: unknown = await c.req.json().catch(() => ({}));
  const parsed = UmbrelInstallOptionsSchema.safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const preview = previewUmbrelV2Install(appId, storeId, parsed.data);
  if (!preview.found) return c.json({ error: "App not found in catalog" }, 404);
  return c.json({ appId, storeId, umbrel: preview.meta, plan: preview.plan });
});

export { stores };
