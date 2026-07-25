import { Hono } from "hono";
import { z } from "zod";
import { serverError } from "../middleware/request-logger.js";
import { TalomeAppSpecSchema } from "../app-specs/schema.js";
import {
  deleteAppSpec,
  executeAppSpecAction,
  executeAppSpecDataSource,
  getStoredAppSpec,
  listStoredAppSpecs,
  saveAppSpec,
} from "../app-specs/service.js";

export const appSpecs = new Hono();

const saveSchema = z.object({
  storeId: z.string().min(1).max(128),
  status: z.enum(["draft", "approved", "disabled"]).default("draft"),
  spec: TalomeAppSpecSchema,
});

appSpecs.get("/", (c) => {
  const includeInactive = c.req.query("includeInactive") === "true"
    && c.get("sessionRole" as never) === "admin";
  const specs = listStoredAppSpecs({ includeInactive }).map((stored) => ({
    appId: stored.appId,
    storeId: stored.storeId,
    schemaVersion: stored.schemaVersion,
    revision: stored.revision,
    status: stored.status,
    name: stored.spec.name,
    description: stored.spec.description,
    icon: stored.spec.icon,
    updatedAt: stored.updatedAt,
  }));
  return c.json({ specs });
});

appSpecs.get("/:storeId/:appId/data/:dataSourceId", async (c) => {
  try {
    const data = await executeAppSpecDataSource({
      storeId: c.req.param("storeId"),
      appId: c.req.param("appId"),
      dataSourceId: c.req.param("dataSourceId"),
      cookie: c.req.header("cookie"),
    });
    return c.json({ data });
  } catch (error) {
    return serverError(c, error, { message: "Failed to resolve native app data" });
  }
});

appSpecs.post("/:storeId/:appId/actions/:actionId", async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    values?: unknown;
    confirmed?: boolean;
  };
  try {
    const result = await executeAppSpecAction({
      storeId: c.req.param("storeId"),
      appId: c.req.param("appId"),
      actionId: c.req.param("actionId"),
      values: body.values,
      confirmed: body.confirmed === true,
      cookie: c.req.header("cookie"),
    });
    return c.json(result, result.ok ? 200 : 409);
  } catch (error) {
    return serverError(c, error, { message: "Native app action failed" });
  }
});

appSpecs.get("/:storeId/:appId", (c) => {
  const includeInactive = c.req.query("includeInactive") === "true"
    && c.get("sessionRole" as never) === "admin";
  const stored = getStoredAppSpec(c.req.param("storeId"), c.req.param("appId"), { includeInactive });
  if (!stored) return c.json({ error: "Approved AppSpec not found" }, 404);
  return c.json(stored);
});

appSpecs.post("/", async (c) => {
  if (c.get("sessionRole" as never) !== "admin") {
    return c.json({ error: "Admin access is required to publish AppSpecs" }, 403);
  }
  const parsed = saveSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  try {
    return c.json(saveAppSpec(parsed.data), 201);
  } catch (error) {
    return serverError(c, error, { message: "Failed to save AppSpec" });
  }
});

appSpecs.put("/:storeId/:appId", async (c) => {
  if (c.get("sessionRole" as never) !== "admin") {
    return c.json({ error: "Admin access is required to update AppSpecs" }, 403);
  }
  const parsed = saveSchema.omit({ storeId: true }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  if (parsed.data.spec.appId !== c.req.param("appId")) {
    return c.json({ error: "AppSpec appId does not match the route" }, 400);
  }
  try {
    return c.json(saveAppSpec({
      storeId: c.req.param("storeId"),
      ...parsed.data,
    }));
  } catch (error) {
    return serverError(c, error, { message: "Failed to update AppSpec" });
  }
});

appSpecs.delete("/:storeId/:appId", (c) => {
  if (c.get("sessionRole" as never) !== "admin") {
    return c.json({ error: "Admin access is required to delete AppSpecs" }, 403);
  }
  deleteAppSpec(c.req.param("storeId"), c.req.param("appId"));
  return c.json({ ok: true });
});
