import { Hono } from "hono";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { addStore, removeStore, syncStore, syncAllStores } from "../stores/sync.js";

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

stores.post("/:id/sync", async (c) => {
  const id = c.req.param("id");
  const result = await syncStore(id);
  return c.json(result);
});

stores.post("/sync-all", async (c) => {
  const results = await syncAllStores();
  return c.json(results);
});

export { stores };
