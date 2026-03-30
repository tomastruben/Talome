import { Hono } from "hono";
import { z } from "zod";
import type { TalomeStack, StackExport, EnrichedStackApp, StackListItem } from "@talome/types";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { listContainers } from "../docker/client.js";
import { mediaServerStack } from "../stacks/media-server.js";
import { smartHomeStack } from "../stacks/smart-home.js";
import { privacySuiteStack } from "../stacks/privacy-suite.js";
import { developerLabStack } from "../stacks/developer-lab.js";
import { photoManagementStack } from "../stacks/photo-management.js";
import { productivityStack } from "../stacks/productivity.js";
import { monitoringStack } from "../stacks/monitoring.js";
import { aiLocalStack } from "../stacks/ai-local.js";
import { booksStack } from "../stacks/books.js";

const stacks = new Hono();

const BUILT_IN_STACKS: TalomeStack[] = [
  mediaServerStack,
  smartHomeStack,
  privacySuiteStack,
  developerLabStack,
  photoManagementStack,
  productivityStack,
  monitoringStack,
  aiLocalStack,
  booksStack,
];

const TALOME_VERSION = "0.1.0";

/* ── Catalog enrichment ────────────────────────────────── */

interface CatalogRow {
  app_id: string;
  store_source_id: string;
  icon: string;
  icon_url: string | null;
  category: string;
  tagline: string;
  source: string;
}

function buildCatalogMap(): Map<string, CatalogRow> {
  const allAppIds = [...new Set(BUILT_IN_STACKS.flatMap((s) => s.apps.map((a) => a.appId)))];
  if (allAppIds.length === 0) return new Map();

  const rows = db.all(
    sql`SELECT app_id, store_source_id, icon, icon_url, category, tagline, source FROM app_catalog WHERE app_id IN (${sql.join(allAppIds.map((id) => sql`${id}`), sql`, `)})`,
  ) as CatalogRow[];

  // Source priority: talome > umbrel > casaos > others
  const SOURCE_PRIORITY: Record<string, number> = { talome: 0, umbrel: 1, casaos: 2 };
  const priority = (source: string) => SOURCE_PRIORITY[source] ?? 3;

  const map = new Map<string, CatalogRow>();
  for (const row of rows) {
    const existing = map.get(row.app_id);
    if (!existing || priority(row.source) < priority(existing.source)) {
      map.set(row.app_id, row);
    }
  }
  return map;
}

function enrichApp(
  appId: string,
  name: string,
  catalogMap: Map<string, CatalogRow>,
  installedSet?: Set<string>,
): EnrichedStackApp {
  const cat = catalogMap.get(appId);
  return {
    appId,
    name,
    icon: cat?.icon,
    iconUrl: cat?.icon_url ?? undefined,
    category: cat?.category,
    tagline: cat?.tagline,
    storeId: cat?.store_source_id,
    installed: installedSet?.has(appId) ?? false,
  };
}

/**
 * Build a set of app IDs that are detected as installed,
 * by checking both the installed_apps DB table and running Docker containers.
 */
async function buildInstalledSet(stackAppIds: string[]): Promise<Set<string>> {
  const installed = new Set<string>();

  // 1. Check installed_apps table
  if (stackAppIds.length > 0) {
    const rows = db.all(
      sql`SELECT app_id FROM installed_apps WHERE app_id IN (${sql.join(stackAppIds.map((id) => sql`${id}`), sql`, `)})`,
    ) as { app_id: string }[];
    for (const r of rows) installed.add(r.app_id);
  }

  // 2. Check running Docker containers by name and image
  try {
    const containers = await listContainers();
    const appIdSet = new Set(stackAppIds);

    for (const c of containers) {
      // Direct name match (most common — Talome uses appId as container_name)
      if (appIdSet.has(c.name)) {
        installed.add(c.name);
        continue;
      }

      // Image-based match: extract image name (e.g. "linuxserver/jellyfin:latest" → "jellyfin")
      const imageName = c.image.split("/").pop()?.split(":")[0] ?? "";
      const normalized = imageName.replace(/-/g, "").toLowerCase();
      for (const appId of stackAppIds) {
        if (!installed.has(appId) && appId.toLowerCase() === normalized) {
          installed.add(appId);
        }
      }
    }
  } catch {
    // Docker not available — rely on DB results only
  }

  return installed;
}

/** Regex patterns for env var values that look like secrets */
const SECRET_PATTERNS = [
  /key/i,
  /token/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /api[_-]?key/i,
  /auth/i,
  /credential/i,
];

function looksLikeSecret(key: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(key));
}

/**
 * Sanitize a TalomeStack for export: replace secret env var values with placeholders.
 */
export function sanitizeStackForExport(stack: TalomeStack): TalomeStack {
  return {
    ...stack,
    apps: stack.apps.map((app) => ({
      ...app,
      compose: sanitizeCompose(app.compose, app.appId),
      configSchema: {
        envVars: app.configSchema.envVars.map((ev) => ({
          ...ev,
          // Mark as secret if not already flagged but key looks secret-like
          secret: ev.secret || looksLikeSecret(ev.key),
        })),
      },
    })),
  };
}

/**
 * Replace secret-looking env var values in raw compose YAML with placeholders.
 */
function sanitizeCompose(compose: string, appId: string): string {
  return compose.replace(
    /^(\s*-?\s*)([\w_]+)=(?!<PLACEHOLDER)(.+)$/gm,
    (match, prefix, key, value) => {
      if (looksLikeSecret(key) && !value.startsWith("<PLACEHOLDER")) {
        return `${prefix}${key}=<PLACEHOLDER: ${key}>`;
      }
      return match;
    },
  );
}

/** GET /api/stacks — list all built-in stack templates with enriched app data */
stacks.get("/", async (c) => {
  const catalogMap = buildCatalogMap();
  const allAppIds = [...new Set(BUILT_IN_STACKS.flatMap((s) => s.apps.map((a) => a.appId)))];
  const installedSet = await buildInstalledSet(allAppIds);

  const list: StackListItem[] = BUILT_IN_STACKS.map((s) => ({
    id: s.id,
    name: s.name,
    tagline: s.tagline,
    description: s.description,
    author: s.author,
    tags: s.tags,
    appCount: s.apps.length,
    apps: s.apps.map((a) => enrichApp(a.appId, a.name, catalogMap, installedSet)),
  }));
  return c.json({ stacks: list, count: list.length });
});

/** GET /api/stacks/feature-status — feature stack readiness (must precede /:id) */
import { getFeatureStackStatus } from "../stacks/feature-stacks.js";

stacks.get("/feature-status", async (c) => {
  const status = await getFeatureStackStatus();
  return c.json({ stacks: status });
});

/** GET /api/stacks/:id — get a single stack template with enriched app data */
stacks.get("/:id", async (c) => {
  const id = c.req.param("id");
  const stack = BUILT_IN_STACKS.find((s) => s.id === id);
  if (!stack) {
    return c.json({ error: `Stack '${id}' not found` }, 404);
  }
  const catalogMap = buildCatalogMap();
  const installedSet = await buildInstalledSet(stack.apps.map((a) => a.appId));

  return c.json({
    ...stack,
    apps: stack.apps.map((a) => ({
      ...a,
      ...enrichApp(a.appId, a.name, catalogMap, installedSet),
    })),
  });
});

/** POST /api/stacks/export — export a stack with secrets sanitized */
stacks.post("/export", async (c) => {
  let body: { stackId?: string; stack?: TalomeStack };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  let stack: TalomeStack | undefined;

  if (body.stackId) {
    stack = BUILT_IN_STACKS.find((s) => s.id === body.stackId);
    if (!stack) {
      return c.json({ error: `Stack '${body.stackId}' not found` }, 404);
    }
  } else if (body.stack) {
    stack = body.stack;
  } else {
    return c.json({ error: "Provide either stackId or stack" }, 400);
  }

  const sanitized = sanitizeStackForExport(stack);
  const exportPayload: StackExport = {
    stack: sanitized,
    exportedAt: new Date().toISOString(),
    talomeVersion: TALOME_VERSION,
  };

  return c.json(exportPayload);
});

/** POST /api/stacks/import — validate and preview a stack before install */
stacks.post("/import", async (c) => {
  let body: { stack?: TalomeStack };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { stack } = body;
  if (!stack) {
    return c.json({ error: "No stack provided" }, 400);
  }

  // Validate required fields
  if (!stack.id || !stack.name || !Array.isArray(stack.apps)) {
    return c.json({ error: "Stack must have id, name, and apps array" }, 400);
  }

  // Find which env vars still need to be filled in (still have <PLACEHOLDER>)
  const requiredInputs: { appId: string; key: string; description: string }[] = [];
  for (const app of stack.apps) {
    for (const ev of app.configSchema.envVars) {
      if (ev.required && (!ev.defaultValue || ev.defaultValue.startsWith("<PLACEHOLDER"))) {
        requiredInputs.push({ appId: app.appId, key: ev.key, description: ev.description });
      }
    }
  }

  return c.json({
    valid: true,
    stack: {
      id: stack.id,
      name: stack.name,
      description: stack.description,
      apps: stack.apps.map((a) => ({ appId: a.appId, name: a.name })),
    },
    requiredInputs,
    message: requiredInputs.length > 0
      ? `Please provide values for ${requiredInputs.length} required field(s) before installing.`
      : "Stack is ready to install.",
  });
});

/** POST /api/stacks/export-running — build a stack from currently installed apps */
stacks.post("/export-running", async (c) => {
  const installed = db.all(sql`SELECT ia.app_id, ia.env_config, ia.version, ac.name, ac.description, ac.icon, ac.compose_path, ac.ports, ac.volumes, ac.env
    FROM installed_apps ia LEFT JOIN app_catalog ac ON ia.app_id = ac.app_id AND ia.store_source_id = ac.store_source_id`) as {
    app_id: string; env_config: string; version: string; name: string; description: string;
    icon: string; compose_path: string; ports: string; volumes: string; env: string;
  }[];

  if (installed.length === 0) {
    return c.json({ error: "No apps installed to export" }, 400);
  }

  const stack: TalomeStack = {
    id: `custom-${Date.now()}`,
    name: "My Server Stack",
    description: `Exported ${installed.length} running apps`,
    tagline: "Custom exported stack",
    author: "Talome",
    tags: ["custom"],
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    apps: installed.map((app) => ({
      appId: app.app_id,
      name: app.name ?? app.app_id,
      description: app.description ?? "",
      compose: "", // Compose content would need to be read from disk
      configSchema: {
        envVars: [],
      },
    })),
  };

  const sanitized = sanitizeStackForExport(stack);
  return c.json({
    stack: sanitized,
    exportedAt: new Date().toISOString(),
    talomeVersion: TALOME_VERSION,
  } satisfies StackExport);
});

/** POST /api/stacks/share-link — encode a stack as a share code */
stacks.post("/share-link", async (c) => {
  let body: { stack?: TalomeStack; stackId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  let stack: TalomeStack | undefined;
  if (body.stackId) {
    stack = BUILT_IN_STACKS.find((s) => s.id === body.stackId);
  } else if (body.stack) {
    stack = body.stack;
  }

  if (!stack) return c.json({ error: "Stack not found" }, 404);

  const sanitized = sanitizeStackForExport(stack);
  const json = JSON.stringify(sanitized);
  const encoded = Buffer.from(json).toString("base64url");

  return c.json({
    shareCode: encoded,
    length: encoded.length,
    message: "Share this code to let others import your stack.",
  });
});

const importCodeSchema = z.object({
  code: z.string().min(1).max(500_000),
});

/** POST /api/stacks/import-code — decode a share code and preview */
stacks.post("/import-code", async (c) => {
  const parsed = importCodeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  try {
    const json = Buffer.from(parsed.data.code, "base64url").toString("utf-8");
    const stack = JSON.parse(json) as TalomeStack;
    if (!stack.id || !stack.name) {
      return c.json({ error: "Invalid stack data" }, 400);
    }
    return c.json({ valid: true, stack });
  } catch {
    return c.json({ error: "Invalid share code" }, 400);
  }
});

export { stacks };
