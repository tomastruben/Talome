import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, desc } from "drizzle-orm";
import { createLogger } from "../utils/logger.js";

const log = createLogger("widgets");

const widgets = new Hono();

type WidgetManifestStatus = "draft" | "pending_review" | "approved" | "disabled";
type WidgetPreset = { cols: 1 | 2 | 3 | 4; rows: 1 | 2 | 3 };
type WidgetLayoutItem = {
  instanceId: string;
  widgetType: string;
  visible: boolean;
  size?: { cols: 1 | 2 | 3 | 4; rows: 1 | 2 | 3 };
};

const DASHBOARD_LAYOUT_KEY = "dashboard_widget_layout";

function parseSizePresets(raw: unknown): WidgetPreset[] {
  if (!Array.isArray(raw) || raw.length === 0) return [{ cols: 2, rows: 1 }];
  const normalized: WidgetPreset[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const cols = (it as { cols?: number }).cols;
    const rows = (it as { rows?: number }).rows;
    if ((cols === 1 || cols === 2 || cols === 3 || cols === 4) && (rows === 1 || rows === 2 || rows === 3)) {
      normalized.push({ cols, rows });
    }
  }
  return normalized.length > 0 ? normalized : [{ cols: 2, rows: 1 }];
}

function parseLayout(raw: unknown): WidgetLayoutItem[] {
  if (!Array.isArray(raw)) return [];
  const normalized: WidgetLayoutItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as {
      instanceId?: unknown;
      widgetType?: unknown;
      visible?: unknown;
      size?: { cols?: unknown; rows?: unknown };
    };
    const instanceId = typeof entry.instanceId === "string" ? entry.instanceId.trim() : "";
    const widgetType = typeof entry.widgetType === "string" ? entry.widgetType.trim() : "";
    const visible = typeof entry.visible === "boolean" ? entry.visible : false;
    if (!instanceId || !widgetType) continue;

    let size: WidgetLayoutItem["size"] | undefined;
    const cols = entry.size?.cols;
    const rows = entry.size?.rows;
    if (
      (cols === 1 || cols === 2 || cols === 3 || cols === 4) &&
      (rows === 1 || rows === 2 || rows === 3)
    ) {
      size = { cols, rows };
    }
    normalized.push({ instanceId, widgetType, visible, ...(size ? { size } : {}) });
  }
  return normalized;
}

widgets.get("/layout", (c) => {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, DASHBOARD_LAYOUT_KEY))
    .get();

  if (!row?.value) return c.json({ layout: [] });

  try {
    const parsed = JSON.parse(row.value) as unknown;
    return c.json({ layout: parseLayout(parsed) });
  } catch {
    return c.json({ layout: [] });
  }
});

widgets.post("/layout", async (c) => {
  const body = await c.req.json().catch((err) => { log.debug("layout body parse failed", err); return {}; });
  const layout = parseLayout((body as { layout?: unknown }).layout);
  if (layout.length === 0) {
    return c.json({ error: "layout must be a non-empty array" }, 400);
  }
  const value = JSON.stringify(layout);
  db.insert(schema.settings)
    .values({ key: DASHBOARD_LAYOUT_KEY, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run();
  return c.json({ ok: true, count: layout.length });
});

widgets.get("/", (c) => {
  const rows = db
    .select()
    .from(schema.widgetManifests)
    .orderBy(desc(schema.widgetManifests.updatedAt))
    .all();

  return c.json({
    widgets: rows.map((row) => ({
      ...row,
      sizePresets: JSON.parse(row.sizePresets || "[]"),
    })),
  });
});

widgets.post("/", async (c) => {
  const body = await c.req.json().catch((err) => { log.debug("widget create body parse failed", err); return {}; });
  const id = String((body as { id?: string }).id ?? "").trim();
  const title = String((body as { title?: string }).title ?? "").trim();
  const description = String((body as { description?: string }).description ?? "").trim();
  const dataSource = String((body as { dataSource?: string }).dataSource ?? "").trim();
  const status = ((body as { status?: WidgetManifestStatus }).status ?? "draft");
  const sizePresets = parseSizePresets((body as { sizePresets?: unknown }).sizePresets);

  if (!id || !title || !dataSource) {
    return c.json({ error: "id, title and dataSource are required" }, 400);
  }

  if (!["draft", "pending_review", "approved", "disabled"].includes(status)) {
    return c.json({ error: "invalid status" }, 400);
  }

  const now = new Date().toISOString();
  db.insert(schema.widgetManifests)
    .values({
      id,
      version: 1,
      title,
      description,
      dataSource,
      sizePresets: JSON.stringify(sizePresets),
      status,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return c.json({ ok: true, id });
});

widgets.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch((err) => { log.debug("widget update body parse failed", err); return {}; });
  const existing = db
    .select()
    .from(schema.widgetManifests)
    .where(eq(schema.widgetManifests.id, id))
    .get();
  if (!existing) return c.json({ error: "Widget manifest not found" }, 404);

  const now = new Date().toISOString();
  const nextVersion = existing.version + 1;

  const title = String((body as { title?: string }).title ?? existing.title).trim();
  const description = String((body as { description?: string }).description ?? existing.description).trim();
  const dataSource = String((body as { dataSource?: string }).dataSource ?? existing.dataSource).trim();
  const status = ((body as { status?: WidgetManifestStatus }).status ?? existing.status) as WidgetManifestStatus;
  const sizePresets = parseSizePresets((body as { sizePresets?: unknown }).sizePresets ?? JSON.parse(existing.sizePresets));

  db.update(schema.widgetManifests)
    .set({
      version: nextVersion,
      title,
      description,
      dataSource,
      sizePresets: JSON.stringify(sizePresets),
      status,
      updatedAt: now,
    })
    .where(eq(schema.widgetManifests.id, id))
    .run();

  return c.json({ ok: true, id, version: nextVersion });
});

widgets.delete("/:id", (c) => {
  const id = c.req.param("id");
  db.delete(schema.widgetManifests)
    .where(eq(schema.widgetManifests.id, id))
    .run();
  return c.json({ ok: true, id });
});

export { widgets };
