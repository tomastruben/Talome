import { Hono } from "hono";
import { z } from "zod";
import { streamSSE } from "hono/streaming";
import { serverError } from "../middleware/request-logger.js";
import { db, schema } from "../db/index.js";
import { eq, and, like, or, sql, inArray, type SQL } from "drizzle-orm";
import {
  installApp,
  uninstallApp,
  startApp,
  stopApp,
  restartApp,
  updateApp,
} from "../stores/lifecycle.js";
import { installProgress, emitProgress, type InstallProgressEvent } from "../stores/install-emitter.js";
import type { CatalogApp, AppManifest, InstalledApp, StoreType, InstalledAppStatus } from "@talome/types";
import { listContainers } from "../docker/client.js";
import os from "node:os";

const apps = new Hono();

const dockerArch = os.arch() === "arm64" ? "arm64" : "amd64";

function isArchCompatible(manifest: AppManifest): boolean {
  if (!manifest.architectures || manifest.architectures.length === 0) return true;
  return manifest.architectures.includes(dockerArch);
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Resolve best locale match from localized fields, applying overrides to the manifest */
function applyLocale(manifest: AppManifest, localizedFields: string | null, locale: string | null): AppManifest {
  if (!localizedFields || !locale) return manifest;
  try {
    const fields = JSON.parse(localizedFields) as Record<string, Record<string, string>>;
    // Normalize locale: "en-US" → "en_us", "zh-CN" → "zh_cn"
    const normalized = locale.toLowerCase().replace("-", "_");
    const lang = normalized.split("_")[0]; // "en" from "en_us"
    const result = { ...manifest };

    for (const [field, locales] of Object.entries(fields)) {
      // Try exact match, then language-only, then any variant of the language
      const value = locales[normalized]
        || locales[lang]
        || Object.entries(locales).find(([k]) => k.startsWith(lang + "_"))?.[1];
      if (value) {
        if (field === "title") result.name = value;
        else if (field === "tagline") result.tagline = value;
        else if (field === "description") result.description = value;
      }
    }
    return result;
  } catch {
    return manifest;
  }
}

function rowToManifest(row: typeof schema.appCatalog.$inferSelect): AppManifest {
  return {
    id: row.appId,
    name: row.name,
    version: row.version,
    tagline: row.tagline,
    description: row.description,
    releaseNotes: row.releaseNotes || undefined,
    icon: row.icon,
    iconUrl: row.iconUrl || undefined,
    coverUrl: row.coverUrl || undefined,
    screenshots: safeJsonParse(row.screenshots, undefined),
    installNotes: row.installNotes || undefined,
    category: row.category,
    author: row.author,
    website: row.website || undefined,
    repo: row.repo || undefined,
    support: row.support || undefined,
    source: row.source as StoreType,
    storeId: row.storeSourceId,
    composePath: row.composePath,
    image: row.image || undefined,
    ports: safeJsonParse(row.ports, []),
    volumes: safeJsonParse(row.volumes, []),
    env: safeJsonParse(row.env, []),
    architectures: safeJsonParse(row.architectures, undefined),
    dependencies: safeJsonParse(row.dependencies, undefined),
    permissions: safeJsonParse(row.permissions, undefined),
    defaultUsername: row.defaultUsername || undefined,
    defaultPassword: row.defaultPassword || undefined,
    webPort: row.webPort || undefined,
  };
}

function rowToInstalledApp(row: typeof schema.installedApps.$inferSelect): InstalledApp {
  return {
    appId: row.appId,
    storeId: row.storeSourceId,
    status: row.status as InstalledAppStatus,
    installedAt: row.installedAt,
    updatedAt: row.updatedAt,
    envConfig: safeJsonParse(row.envConfig, {}),
    containerIds: safeJsonParse(row.containerIds, []),
    version: row.version,
    displayName: row.displayName || undefined,
  };
}

function enrichWithInstallStatus(manifest: AppManifest): CatalogApp {
  const installed = db
    .select()
    .from(schema.installedApps)
    .where(eq(schema.installedApps.appId, manifest.id))
    .get();

  return {
    ...manifest,
    installed: installed ? rowToInstalledApp(installed) : null,
  };
}

/** Batch-enrich manifests with install status using a single DB query. */
function batchEnrichWithInstallStatus(manifests: AppManifest[]): CatalogApp[] {
  if (manifests.length === 0) return [];

  const allInstalled = db.select().from(schema.installedApps).all();
  const installedMap = new Map<string, typeof allInstalled[number]>();
  for (const row of allInstalled) {
    installedMap.set(row.appId, row);
  }

  return manifests.map((manifest) => {
    const installed = installedMap.get(manifest.id);
    return {
      ...manifest,
      installed: installed ? rowToInstalledApp(installed) : null,
    };
  });
}

apps.get("/", (c) => {
  try {
    const search = c.req.query("search");
    const category = c.req.query("category");
    const source = c.req.query("source");
    const installed = c.req.query("installed");
    const locale = c.req.query("locale") || c.req.header("Accept-Language")?.split(",")[0]?.trim() || null;
    const page = parseInt(c.req.query("page") || "1");
    const limit = Math.min(parseInt(c.req.query("limit") || "2000"), 5000);
    const offset = (page - 1) * limit;

    let query = db.select().from(schema.appCatalog).$dynamic();

    const conditions: (SQL | undefined)[] = [];

    if (search) {
      const term = `%${search}%`;
      conditions.push(
        or(
          like(schema.appCatalog.name, term),
          like(schema.appCatalog.tagline, term),
          like(schema.appCatalog.description, term),
        ),
      );
    }

    if (category && category !== "all") {
      conditions.push(eq(schema.appCatalog.category, category));
    }

    if (source && source !== "all") {
      const storeIds = db
        .select({ id: schema.storeSources.id })
        .from(schema.storeSources)
        .where(eq(schema.storeSources.type, source))
        .all()
        .map((r) => r.id);

      if (storeIds.length > 0) {
        conditions.push(inArray(schema.appCatalog.storeSourceId, storeIds));
      } else {
        conditions.push(eq(schema.appCatalog.source, source));
      }
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const rows = query.limit(limit).offset(offset).all() as (typeof schema.appCatalog.$inferSelect)[];
    const manifests = rows.map((row) => applyLocale(rowToManifest(row), row.localizedFields, locale));

    // Batch-enrich with install status (single DB query instead of N+1)
    const allInstalled = db.select().from(schema.installedApps).all();
    const installedMap = new Map<string, typeof allInstalled[number]>();
    for (const row of allInstalled) {
      installedMap.set(row.appId, row);
    }

    function enrich(manifest: AppManifest): CatalogApp {
      const inst = installedMap.get(manifest.id);
      return { ...manifest, installed: inst ? rowToInstalledApp(inst) : null };
    }

    let results: CatalogApp[];

    if (installed === "true") {
      const installedIds = new Set(allInstalled.map((r) => r.appId));
      results = manifests.filter((m) => installedIds.has(m.id)).map(enrich);
    } else if (installed === "false") {
      const installedIds = new Set(allInstalled.map((r) => r.appId));
      results = manifests.filter((m) => !installedIds.has(m.id)).map(enrich);
    } else {
      results = manifests.map(enrich);
    }

    // Sort: Umbrel first (always has covers), then Talome, then CasaOS, then user-created.
    // Within each source, apps with cover images sort before those without.
    const SOURCE_ORDER: Record<string, number> = { umbrel: 0, talome: 1, casaos: 2, "user-created": 3 };
    results.sort((a, b) => {
      const sa = SOURCE_ORDER[a.source] ?? 2;
      const sb = SOURCE_ORDER[b.source] ?? 2;
      if (sa !== sb) return sa - sb;
      const ca = a.coverUrl ? 0 : 1;
      const cb = b.coverUrl ? 0 : 1;
      return ca - cb;
    });

    return c.json(results.filter(isArchCompatible));
  } catch (err) {
    return serverError(c, err, { message: "Failed to load apps" });
  }
});

apps.get("/installed", (c) => {
  try {
    const rows = db
      .select({
        catalog: schema.appCatalog,
        installed: schema.installedApps,
      })
      .from(schema.installedApps)
      .innerJoin(
        schema.appCatalog,
        and(
          eq(schema.appCatalog.appId, schema.installedApps.appId),
          eq(schema.appCatalog.storeSourceId, schema.installedApps.storeSourceId),
        ),
      )
      .all();

    const results: CatalogApp[] = rows.map((row) => ({
      ...rowToManifest(row.catalog),
      installed: rowToInstalledApp(row.installed),
    }));

    return c.json(results);
  } catch (err) {
    return serverError(c, err, { message: "Failed to load installed apps" });
  }
});

apps.get("/categories", (c) => {
  try {
    const rows = db
      .select({ category: schema.appCatalog.category })
      .from(schema.appCatalog)
      .groupBy(schema.appCatalog.category)
      .all();

    const categories = rows.map((r) => r.category).sort();
    return c.json(categories);
  } catch (err) {
    return serverError(c, err, { message: "Failed to load categories" });
  }
});

apps.get("/:storeId/:appId", async (c) => {
  const { storeId, appId } = c.req.param();
  const locale = c.req.query("locale") || c.req.header("Accept-Language")?.split(",")[0]?.trim() || null;

  const row = db
    .select()
    .from(schema.appCatalog)
    .where(
      and(
        eq(schema.appCatalog.appId, appId),
        eq(schema.appCatalog.storeSourceId, storeId),
      ),
    )
    .get();

  if (!row) return c.json({ error: "App not found" }, 404);

  const result = enrichWithInstallStatus(applyLocale(rowToManifest(row), row.localizedFields, locale));

  // If not installed via Talome, check if running as a Docker container
  if (!result.installed) {
    try {
      const containers = await listContainers();
      const id = result.id.toLowerCase();
      result.detectedRunning = containers.some((ct) => {
        if (ct.name.toLowerCase() === id) return true;
        const img = ct.image.split("/").pop()?.split(":")[0] ?? "";
        return img.replace(/-/g, "").toLowerCase() === id.replace(/-/g, "");
      });
    } catch {
      // Docker unavailable — skip detection
    }
  }

  return c.json(result);
});

const installSchema = z.object({
  env: z.record(z.string(), z.string()).default({}),
  volumeMounts: z.record(z.string(), z.string()).default({}),
});

apps.post("/:storeId/:appId/install", async (c) => {
  const { storeId, appId } = c.req.param();
  const parsed = installSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { env, volumeMounts } = parsed.data;

  emitProgress(appId, { stage: "queued", message: "Preparing..." });

  const result = await installApp(appId, storeId, env, volumeMounts, (stage, message) => {
    emitProgress(appId, { stage: stage as InstallProgressEvent["stage"], message });
  });

  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }

  return c.json({
    ok: true,
    message: `${appId} installed`,
    remappedPorts: result.remappedPorts,
  });
});

apps.get("/:storeId/:appId/progress", (c) => {
  const { appId } = c.req.param();

  return streamSSE(c, async (stream) => {
    let id = 0;
    let done = false;

    const listener = (event: { stage: string; message: string }) => {
      stream.writeSSE({
        data: JSON.stringify(event),
        event: "progress",
        id: String(id++),
      });
      if (event.stage === "running" || event.stage === "error") {
        done = true;
      }
    };

    installProgress.on(appId, listener);

    // Send initial heartbeat so the client knows the connection is live
    await stream.writeSSE({
      data: JSON.stringify({ stage: "queued", message: "Waiting for install to start..." }),
      event: "progress",
      id: String(id++),
    });

    // Keep the stream open until install completes or client disconnects
    while (!done && !stream.aborted) {
      await stream.sleep(500);
    }

    installProgress.off(appId, listener);
  });
});

apps.post("/:storeId/:appId/start", async (c) => {
  const { appId } = c.req.param();
  const result = await startApp(appId);
  if (!result.success) return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

apps.post("/:storeId/:appId/stop", async (c) => {
  const { appId } = c.req.param();
  const result = await stopApp(appId);
  if (!result.success) return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

apps.post("/:storeId/:appId/restart", async (c) => {
  const { appId } = c.req.param();
  const result = await restartApp(appId);
  if (!result.success) return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

apps.post("/:storeId/:appId/update", async (c) => {
  const { appId } = c.req.param();
  const result = await updateApp(appId);
  if (!result.success) return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

/* ── Rename app / change port mappings ─────────────────────────────── */

const patchSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  ports: z.record(z.string(), z.number().int().min(1).max(65535)).optional(),
});

apps.patch("/:storeId/:appId", async (c) => {
  const { storeId, appId } = c.req.param();
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { displayName, ports } = parsed.data;

  if (!displayName && !ports) {
    return c.json({ error: "Nothing to update" }, 400);
  }

  const installedRow = db
    .select()
    .from(schema.installedApps)
    .where(eq(schema.installedApps.appId, appId))
    .get();

  // ── Display name update ─────────────────────────────────────────────
  if (displayName !== undefined) {
    if (installedRow) {
      db.update(schema.installedApps)
        .set({ displayName, updatedAt: new Date().toISOString() })
        .where(eq(schema.installedApps.appId, appId))
        .run();
    } else {
      // Create a minimal installed_apps row to store the display name
      db.insert(schema.installedApps)
        .values({
          appId,
          storeSourceId: storeId,
          status: "unknown",
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          displayName,
        })
        .onConflictDoUpdate({
          target: schema.installedApps.appId,
          set: { displayName, updatedAt: new Date().toISOString() },
        })
        .run();
    }
  }

  // ── Port mapping update ─────────────────────────────────────────────
  let portMessage: string | undefined;
  if (ports && Object.keys(ports).length > 0) {
    // Try installed app compose path first, then fall back to catalog compose path
    let composePath = installedRow?.overrideComposePath;
    if (!composePath) {
      const catalogRow = db
        .select({ composePath: schema.appCatalog.composePath })
        .from(schema.appCatalog)
        .where(
          and(
            eq(schema.appCatalog.appId, appId),
            eq(schema.appCatalog.storeSourceId, storeId),
          ),
        )
        .get();
      composePath = catalogRow?.composePath;
    }
    if (!composePath) {
      return c.json({ error: "No compose file found for this app" }, 400);
    }

    const { readFile, writeFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { parse: parseYaml, stringify: stringifyYaml } = await import("yaml");

    const content = await readFile(composePath, "utf-8");
    const doc = parseYaml(content) as Record<string, unknown>;
    const services = doc.services as Record<string, Record<string, unknown>> | undefined;
    if (!services) return c.json({ error: "No services in compose file" }, 400);

    // Apply port changes across all services
    let changed = false;
    for (const service of Object.values(services)) {
      if (!Array.isArray(service.ports)) continue;
      service.ports = (service.ports as string[]).map((p: string) => {
        const [, container] = p.split(":");
        const newHost = ports[container];
        if (newHost !== undefined) { changed = true; return `${newHost}:${container}`; }
        return p;
      });
    }

    if (changed) {
      const BACKUP_DIR = join(process.env.HOME || "/tmp", ".talome", "backups", "compose");
      await mkdir(BACKUP_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      await writeFile(join(BACKUP_DIR, `${appId}-${ts}.yml.bak`), content, "utf-8");
      await writeFile(composePath, stringifyYaml(doc), "utf-8");
      portMessage = "Port mappings updated. Restart the app to apply.";
    }
  }

  return c.json({ ok: true, portMessage });
});

apps.delete("/:storeId/:appId", async (c) => {
  const { appId } = c.req.param();
  const result = await uninstallApp(appId);
  if (!result.success) return c.json({ error: result.error }, 400);
  return c.json({ ok: true, message: `${appId} uninstalled` });
});

/* ── Serve local store assets (icons, screenshots, covers) ─────────── */

apps.get("/store-asset", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path required" }, 400);

  // Security: only allow files inside known store directories
  const { homedir } = await import("node:os");
  const { resolve, extname } = await import("node:path");
  const resolved = resolve(filePath);
  const storeBase = resolve(homedir(), ".talome", "stores");
  if (!resolved.startsWith(storeBase)) {
    return c.json({ error: "forbidden" }, 403);
  }

  const ext = extname(resolved).slice(1).toLowerCase();
  const mimeMap: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
  };
  const mime = mimeMap[ext];
  if (!mime) return c.json({ error: "unsupported type" }, 400);

  try {
    const { readFile } = await import("node:fs/promises");
    const data = await readFile(resolved);
    return new Response(new Uint8Array(data), {
      headers: { "Content-Type": mime, "Cache-Control": "public, max-age=86400" },
    });
  } catch {
    return c.json({ error: "not found" }, 404);
  }
});

export { apps };
