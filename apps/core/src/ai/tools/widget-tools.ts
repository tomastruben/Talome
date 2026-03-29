import { tool } from "ai";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";
import { writeAuditEntry } from "../../db/audit.js";

const sizePresetSchema = z.object({
  cols: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  rows: z.union([z.literal(1), z.literal(2)]),
});

export const listWidgetsTool = tool({
  description: "List declarative dashboard widget manifests and their status.",
  inputSchema: z.object({}),
  execute: async () => {
    const rows = db.select().from(schema.widgetManifests).all();
    return rows.map((row) => ({
      ...row,
      sizePresets: JSON.parse(row.sizePresets || "[]"),
    }));
  },
});

export const createWidgetManifestTool = tool({
  description: "Create a declarative dashboard widget manifest (safe, no arbitrary code).",
  inputSchema: z.object({
    id: z.string().min(2),
    title: z.string().min(2),
    description: z.string().default(""),
    dataSource: z.string().min(2).describe("API path, e.g. /api/containers or media/downloads"),
    sizePresets: z.array(sizePresetSchema).min(1).default([{ cols: 2, rows: 1 }]),
    status: z.enum(["draft", "pending_review", "approved", "disabled"]).default("draft"),
  }),
  execute: async ({ id, title, description, dataSource, sizePresets, status }) => {
    const now = new Date().toISOString();
    db.insert(schema.widgetManifests).values({
      id,
      title,
      description,
      dataSource,
      sizePresets: JSON.stringify(sizePresets),
      status,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }).run();
    writeAuditEntry("AI: create_widget_manifest", "modify", `${id} -> ${dataSource}`);
    return { ok: true, id, version: 1 };
  },
});

export const updateWidgetManifestTool = tool({
  description: "Update an existing declarative dashboard widget manifest.",
  inputSchema: z.object({
    id: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    dataSource: z.string().optional(),
    sizePresets: z.array(sizePresetSchema).optional(),
    status: z.enum(["draft", "pending_review", "approved", "disabled"]).optional(),
  }),
  execute: async ({ id, title, description, dataSource, sizePresets, status }) => {
    const existing = db.select().from(schema.widgetManifests).where(eq(schema.widgetManifests.id, id)).get();
    if (!existing) return { ok: false, error: "manifest_not_found" };
    const nextVersion = existing.version + 1;
    db.update(schema.widgetManifests).set({
      title: title ?? existing.title,
      description: description ?? existing.description,
      dataSource: dataSource ?? existing.dataSource,
      sizePresets: JSON.stringify(sizePresets ?? JSON.parse(existing.sizePresets)),
      status: status ?? existing.status,
      version: nextVersion,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.widgetManifests.id, id)).run();
    writeAuditEntry("AI: update_widget_manifest", "modify", `${id} v${nextVersion}`);
    return { ok: true, id, version: nextVersion };
  },
});
