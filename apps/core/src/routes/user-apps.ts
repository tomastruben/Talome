import { Hono } from "hono";
import { serverError } from "../middleware/request-logger.js";
import { createUserApp, listUserApps, deleteUserApp } from "../stores/creator.js";
import { exportApp, exportAppAsBundle } from "../stores/export.js";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { db, schema } from "../db/index.js";
import { eq, and } from "drizzle-orm";
import { writeAuditEntry } from "../db/audit.js";
import { submitCommunityBundle } from "../stores/community-pipeline.js";

const BACKUP_DIR = join(process.env.HOME || "/tmp", ".talome", "backups", "compose");

const userApps = new Hono();

userApps.get("/", (c) => {
  return c.json(listUserApps());
});

userApps.post("/", async (c) => {
  const body = await c.req.json();

  if (!body.id || !body.name || !body.services) {
    return c.json({ error: "id, name, and services are required" }, 400);
  }

  const result = createUserApp(body);

  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }

  return c.json(result);
});

userApps.delete("/:appId", async (c) => {
  const appId = c.req.param("appId");
  const result = await deleteUserApp(appId);
  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }
  return c.json({ ok: true });
});

/** POST /api/user-apps/:appId/cover — upload a cover image */
userApps.post("/:appId/cover", async (c) => {
  const appId = c.req.param("appId");
  const USER_APPS_DIR = join(homedir(), ".talome", "user-apps");
  const appDir = join(USER_APPS_DIR, "apps", appId);

  try {
    await stat(appDir);
  } catch {
    return c.json({ error: "App not found" }, 404);
  }

  const formData = await c.req.formData();
  const file = formData.get("cover");
  if (!file || !(file instanceof File)) {
    return c.json({ error: "No cover file provided" }, 400);
  }

  const ext = file.name.split(".").pop()?.toLowerCase() || "png";
  const allowed = ["png", "jpg", "jpeg", "webp", "gif"];
  if (!allowed.includes(ext)) {
    return c.json({ error: "Unsupported image format" }, 400);
  }

  const coverFileName = `cover.${ext}`;
  const coverPath = join(appDir, coverFileName);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(coverPath, buffer);

  // Update coverUrl in the app catalog DB
  const coverUrl = `/api/user-apps/${appId}/cover`;
  db.update(schema.appCatalog)
    .set({ coverUrl })
    .where(
      and(
        eq(schema.appCatalog.appId, appId),
        eq(schema.appCatalog.storeSourceId, "user-apps"),
      ),
    )
    .run();

  return c.json({ ok: true, coverUrl });
});

/** POST /api/user-apps/:appId/icon — upload a custom icon */
userApps.post("/:appId/icon", async (c) => {
  const appId = c.req.param("appId");
  const USER_APPS_DIR = join(homedir(), ".talome", "user-apps");
  const appDir = join(USER_APPS_DIR, "apps", appId);

  try {
    await stat(appDir);
  } catch {
    return c.json({ error: "App not found" }, 404);
  }

  const formData = await c.req.formData();
  const file = formData.get("icon");
  if (!file || !(file instanceof File)) {
    return c.json({ error: "No icon file provided" }, 400);
  }

  const ext = file.name.split(".").pop()?.toLowerCase() || "png";
  const allowed = ["png", "jpg", "jpeg", "webp", "gif", "svg"];
  if (!allowed.includes(ext)) {
    return c.json({ error: "Unsupported image format" }, 400);
  }

  const iconFileName = `icon.${ext}`;
  const iconPath = join(appDir, iconFileName);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(iconPath, buffer);

  // Update iconUrl in the app catalog DB
  const iconUrl = `/api/user-apps/${appId}/icon`;
  db.update(schema.appCatalog)
    .set({ iconUrl })
    .where(
      and(
        eq(schema.appCatalog.appId, appId),
        eq(schema.appCatalog.storeSourceId, "user-apps"),
      ),
    )
    .run();

  return c.json({ ok: true, iconUrl });
});

/** GET /api/user-apps/:appId/cover — serve the cover image */
userApps.get("/:appId/cover", async (c) => {
  const appId = c.req.param("appId");
  const USER_APPS_DIR = join(homedir(), ".talome", "user-apps");
  const appDir = join(USER_APPS_DIR, "apps", appId);

  const exts = ["png", "jpg", "jpeg", "webp", "gif"];
  for (const ext of exts) {
    const coverPath = join(appDir, `cover.${ext}`);
    try {
      const data = await readFile(coverPath);
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      return new Response(new Uint8Array(data), {
        headers: {
          "Content-Type": mime,
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch {
      continue;
    }
  }

  return c.json({ error: "No cover image found" }, 404);
});

/** GET /api/user-apps/:appId/icon — serve the custom icon */
userApps.get("/:appId/icon", async (c) => {
  const appId = c.req.param("appId");
  const USER_APPS_DIR = join(homedir(), ".talome", "user-apps");
  const appDir = join(USER_APPS_DIR, "apps", appId);

  const exts = ["png", "jpg", "jpeg", "webp", "gif", "svg"];
  for (const ext of exts) {
    const iconPath = join(appDir, `icon.${ext}`);
    try {
      const data = await readFile(iconPath);
      const mime =
        ext === "jpg" ? "image/jpeg" :
        ext === "svg" ? "image/svg+xml" :
        `image/${ext}`;
      return new Response(new Uint8Array(data), {
        headers: {
          "Content-Type": mime,
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch {
      continue;
    }
  }

  return c.json({ error: "No icon image found" }, 404);
});

userApps.get("/:appId/export", (c) => {
  const appId = c.req.param("appId");
  const result = exportAppAsBundle(appId);
  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }
  return c.json(result.bundle);
});

userApps.post("/:appId/publish", async (c) => {
  const appId = c.req.param("appId");
  const body = await c.req.json().catch(() => ({}));
  const authorName = body.authorName || "Talome User";
  const authorEmail = body.authorEmail;

  const exported = exportAppAsBundle(appId);
  if (!exported.success || !exported.bundle) {
    return c.json({ error: exported.error || "Failed to export app bundle" }, 400);
  }

  const result = await submitCommunityBundle({
    bundle: exported.bundle,
    authorName,
    authorEmail,
  });
  if (!result.success) {
    return c.json({ error: result.error || "Failed to submit to community review" }, 400);
  }

  return c.json({
    ok: true,
    submissionId: result.submissionId,
    checks: result.checks,
    message: "Submitted to community review queue",
  });
});

/** GET /api/user-apps/:appId/config — read current compose config */
userApps.get("/:appId/config", async (c) => {
  const appId = c.req.param("appId");
  try {
    const row = db
      .select()
      .from(schema.installedApps)
      .where(eq(schema.installedApps.appId, appId))
      .get();

    if (!row?.overrideComposePath) {
      return c.json({ error: `No compose path found for '${appId}'` }, 404);
    }

    const content = await readFile(row.overrideComposePath, "utf-8");
    const parsed = parseYaml(content);
    return c.json({ appId, composePath: row.overrideComposePath, config: parsed });
  } catch (err: unknown) {
    return serverError(c, err, { context: { appId } });
  }
});

/**
 * PATCH /api/user-apps/:appId/config
 * Body: { serviceName: string, env?: Record<string,string>, ports?: Record<number,number> }
 * Backs up the original compose file, applies the patch, writes it back.
 */
userApps.patch("/:appId/config", async (c) => {
  const appId = c.req.param("appId");

  interface ConfigPatch {
    serviceName: string;
    env?: Record<string, string>;
    ports?: Record<string, number>; // { "containerPort": newHostPort }
  }

  let body: ConfigPatch;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.serviceName) {
    return c.json({ error: "serviceName is required" }, 400);
  }

  try {
    const row = db
      .select()
      .from(schema.installedApps)
      .where(eq(schema.installedApps.appId, appId))
      .get();

    if (!row?.overrideComposePath) {
      return c.json({ error: `No compose path found for '${appId}'` }, 404);
    }

    const composePath = row.overrideComposePath;
    const content = await readFile(composePath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;

    const services = parsed.services as Record<string, Record<string, unknown>>;
    const service = services?.[body.serviceName];
    if (!service) {
      return c.json({ error: `Service '${body.serviceName}' not found` }, 400);
    }

    // Apply env patches
    if (body.env) {
      if (!service.environment || typeof service.environment !== "object") {
        service.environment = {};
      }
      Object.assign(service.environment as Record<string, string>, body.env);
    }

    // Apply port patches
    if (body.ports && Array.isArray(service.ports)) {
      service.ports = (service.ports as string[]).map((p: string) => {
        const [, container] = p.split(":");
        const newHost = body.ports![container];
        return newHost !== undefined ? `${newHost}:${container}` : p;
      });
    }

    // Backup original
    await mkdir(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    await writeFile(join(BACKUP_DIR, `${appId}-${ts}.yml.bak`), content, "utf-8");

    // Write patched file
    await writeFile(composePath, stringifyYaml(parsed), "utf-8");
    writeAuditEntry(`config patch: ${appId}`, "modify", JSON.stringify(body));

    return c.json({ ok: true, appId, message: "Config updated. Recreate the container to apply changes." });
  } catch (err: unknown) {
    return serverError(c, err, { context: { appId } });
  }
});

export { userApps };
