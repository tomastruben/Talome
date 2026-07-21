import { Hono } from "hono";
import { z } from "zod";
import type {
  AppEnvVar,
  TalomeStack,
  StackExport,
  StackEnvVar,
  EnrichedStackApp,
  StackListItem,
} from "@talome/types";
import { db, schema } from "../db/index.js";
import { sql } from "drizzle-orm";
import { existsSync, readFileSync } from "node:fs";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
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
const SHARE_CODE_PREFIX = "t1.";
const CAPSULE_CODE_PREFIX = "t2.";
const MAX_STACK_JSON_BYTES = 5_000_000;
const MAX_CAPSULE_JSON_BYTES = 128_000;
const MAX_CAPSULE_LINK_LENGTH = 7_500;
const MAX_QR_PAYLOAD_LENGTH = 2_200;
const SHARE_LINK_TTL_MS = 30 * 24 * 60 * 60_000;

const stackEnvVarSchema = z.object({
  key: z.string().min(1).max(128),
  description: z.string().max(1_000).default(""),
  required: z.boolean().default(false),
  secret: z.boolean().optional(),
  defaultValue: z.string().max(10_000).optional(),
});

const stackAppSchema = z.object({
  appId: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  description: z.string().max(5_000).optional(),
  storeId: z.string().min(1).max(256).optional(),
  compose: z.string().max(500_000),
  configSchema: z.object({
    envVars: z.array(stackEnvVarSchema).max(250),
  }),
});

const talomeStackSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  description: z.string().max(10_000),
  tagline: z.string().max(1_000),
  author: z.string().max(256),
  tags: z.array(z.string().max(128)).max(50),
  apps: z.array(stackAppSchema).min(1).max(250),
  version: z.string().min(1).max(128),
  createdAt: z.string().min(1).max(128),
  postInstallPrompt: z.string().max(20_000).optional(),
});

const capsuleInputSchema = z.object({
  key: z.string().min(1).max(128),
  label: z.string().min(1).max(160),
  secret: z.boolean(),
});

const stackCapsuleSchema = z.object({
  v: z.literal(2),
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  description: z.string().max(500),
  author: z.string().max(128),
  tags: z.array(z.string().max(64)).max(10),
  apps: z.array(z.object({
    appId: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    description: z.string().max(240).optional(),
    storeId: z.string().min(1).max(256).optional(),
    requiredInputs: z.array(capsuleInputSchema).max(250),
  })).min(1).max(250),
});

type StackCapsule = z.infer<typeof stackCapsuleSchema>;

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
  /database[_-]?url/i,
  /dsn/i,
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
    apps: stack.apps.map((app) => {
      const secretKeys = new Set(
        app.configSchema.envVars
          .filter((envVar) => envVar.secret || looksLikeSecret(envVar.key))
          .map((envVar) => envVar.key),
      );

      return {
        ...app,
        compose: sanitizeCompose(app.compose, secretKeys),
        configSchema: {
          envVars: app.configSchema.envVars.map((envVar) => {
            const secret = secretKeys.has(envVar.key);
            return {
              ...envVar,
              secret,
              defaultValue: secret && envVar.defaultValue && !envVar.defaultValue.startsWith("<PLACEHOLDER")
                ? `<PLACEHOLDER: ${envVar.key}>`
                : envVar.defaultValue,
            };
          }),
        },
      };
    }),
  };
}

/**
 * Replace secret-looking env var values in raw compose YAML with placeholders.
 */
function sanitizeCompose(compose: string, explicitlySecretKeys: Set<string>): string {
  const isSecretKey = (key: string) => explicitlySecretKeys.has(key) || looksLikeSecret(key);

  const listSanitized = compose.replace(
    /^([ \t]*-[ \t]*)(["']?)([A-Za-z_][\w.-]*)=(.*?)(\2)[ \t]*$/gm,
    (match, prefix: string, quote: string, key: string, value: string) => {
      if (isSecretKey(key) && value.trim() && !value.trim().startsWith("<PLACEHOLDER")) {
        return `${prefix}${quote}${key}=<PLACEHOLDER: ${key}>${quote}`;
      }
      return match;
    },
  );

  return listSanitized.replace(
    /^([ \t]*)(["']?)([A-Za-z_][\w.-]*)(\2)([ \t]*:[ \t]*)(.+)$/gm,
    (match, prefix: string, keyQuote: string, key: string, _closingQuote: string, separator: string, value: string) => {
      const unquotedValue = value.trim().replace(/^['"]|['"]$/g, "");
      if (isSecretKey(key) && !unquotedValue.startsWith("<PLACEHOLDER")) {
        return `${prefix}${keyQuote}${key}${keyQuote}${separator}"<PLACEHOLDER: ${key}>"`;
      }
      return match;
    },
  );
}

function encodeShareCode(stack: TalomeStack): string {
  const json = JSON.stringify(stack);
  const compressed = deflateRawSync(Buffer.from(json, "utf-8"));
  return `${SHARE_CODE_PREFIX}${compressed.toString("base64url")}`;
}

function decodeShareCode(code: string): unknown {
  const json = code.startsWith(SHARE_CODE_PREFIX)
    ? inflateRawSync(Buffer.from(code.slice(SHARE_CODE_PREFIX.length), "base64url"), {
      maxOutputLength: MAX_STACK_JSON_BYTES,
    }).toString("utf-8")
    : Buffer.from(code, "base64url").toString("utf-8");

  if (Buffer.byteLength(json, "utf-8") > MAX_STACK_JSON_BYTES) {
    throw new Error("Decoded stack is too large");
  }
  return JSON.parse(json);
}

function buildStackCapsule(stack: TalomeStack): StackCapsule {
  return {
    v: 2,
    id: stack.id,
    name: stack.name,
    description: stack.description.slice(0, 500),
    author: stack.author.slice(0, 128),
    tags: stack.tags.slice(0, 10).map((tag) => tag.slice(0, 64)),
    apps: stack.apps.map((app) => ({
      appId: app.appId,
      name: app.name,
      description: app.description?.slice(0, 240),
      storeId: app.storeId,
      requiredInputs: app.configSchema.envVars
        .filter((envVar) => envVar.required && (!envVar.defaultValue || envVar.defaultValue.startsWith("<PLACEHOLDER")))
        .map((envVar) => ({
          key: envVar.key,
          label: (envVar.description || envVar.key).slice(0, 160),
          secret: envVar.secret || looksLikeSecret(envVar.key),
        })),
    })),
  };
}

function encodeCapsuleCode(capsule: StackCapsule): string {
  const json = JSON.stringify(capsule);
  const payload = Buffer.from(json, "utf-8").toString("base64url");
  return `${CAPSULE_CODE_PREFIX}${payload}.${capsuleFingerprint(json)}`;
}

function decodeCapsuleCode(code: string): unknown {
  if (!code.startsWith(CAPSULE_CODE_PREFIX)) throw new Error("Not a stack capsule");
  const encoded = code.slice(CAPSULE_CODE_PREFIX.length);
  const separator = encoded.indexOf(".");
  const payload = separator === -1 ? encoded : encoded.slice(0, separator);
  const fingerprint = separator === -1 ? null : encoded.slice(separator + 1);
  if (!payload || (fingerprint !== null && !/^[A-Za-z0-9_-]{12}$/.test(fingerprint))) {
    throw new Error("Invalid capsule encoding");
  }
  const json = Buffer.from(payload, "base64url").toString("utf-8");
  if (Buffer.byteLength(json, "utf-8") > MAX_CAPSULE_JSON_BYTES) {
    throw new Error("Decoded capsule is too large");
  }
  if (fingerprint && fingerprint !== capsuleFingerprint(json)) {
    throw new Error("Capsule integrity check failed");
  }
  return JSON.parse(json);
}

function capsuleFingerprint(json: string): string {
  return createHash("sha256").update(json, "utf-8").digest().subarray(0, 9).toString("base64url");
}

function normalizeImportCode(input: string): string {
  const code = input.trim();
  if (!/^https?:\/\//i.test(code)) return code;

  try {
    const parsed = new URL(code);
    return decodeURIComponent(parsed.hash.slice(1)) || code;
  } catch {
    return code;
  }
}

function capsuleToStack(capsule: StackCapsule): TalomeStack {
  return {
    id: capsule.id,
    name: capsule.name,
    description: capsule.description,
    tagline: "Shared Talome stack capsule",
    author: capsule.author,
    tags: capsule.tags,
    version: "2.0.0",
    createdAt: new Date(0).toISOString(),
    apps: capsule.apps.map((app) => ({
      appId: app.appId,
      name: app.name,
      description: app.description,
      storeId: app.storeId,
      compose: "",
      configSchema: {
        envVars: app.requiredInputs.map((input) => ({
          key: input.key,
          description: input.label,
          required: true,
          secret: input.secret,
          defaultValue: input.secret ? `<PLACEHOLDER: ${input.key}>` : undefined,
        })),
      },
    })),
  };
}

function stackFileStem(stack: TalomeStack): string {
  const slug = stack.name.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return slug || "talome-stack";
}

function parseCatalogEnv(raw: string | null): AppEnvVar[] {
  if (!raw) return [];
  try {
    const parsed = z.array(z.object({
      key: z.string().min(1),
      label: z.string().optional(),
      required: z.boolean().optional(),
      default: z.string().optional(),
      secret: z.boolean().optional(),
    })).safeParse(JSON.parse(raw));
    if (!parsed.success) return [];
    return parsed.data.map((envVar) => ({
      key: envVar.key,
      label: envVar.label ?? envVar.key,
      required: envVar.required ?? false,
      default: envVar.default,
      secret: envVar.secret,
    }));
  } catch {
    return [];
  }
}

function toStackEnvVar(envVar: AppEnvVar): StackEnvVar {
  const secret = envVar.secret || looksLikeSecret(envVar.key);
  return {
    key: envVar.key,
    description: envVar.label,
    required: envVar.required,
    secret,
    defaultValue: secret
      ? `<PLACEHOLDER: ${envVar.key}>`
      : envVar.default,
  };
}

interface ImportCatalogRow {
  app_id: string;
  store_source_id: string;
  name: string;
  description: string;
  source: string;
}

function buildStackImportPreview(stack: TalomeStack) {
  const appIds = [...new Set(stack.apps.map((app) => app.appId))];
  const catalogRows = db.all(
    sql`SELECT app_id, store_source_id, name, description, source FROM app_catalog WHERE app_id IN (${sql.join(appIds.map((id) => sql`${id}`), sql`, `)})`,
  ) as ImportCatalogRow[];
  const installedRows = db.all(
    sql`SELECT app_id FROM installed_apps WHERE app_id IN (${sql.join(appIds.map((id) => sql`${id}`), sql`, `)})`,
  ) as { app_id: string }[];
  const installedSet = new Set(installedRows.map((row) => row.app_id));
  const sourcePriority: Record<string, number> = { talome: 0, umbrel: 1, casaos: 2 };

  const requiredInputs = stack.apps.flatMap((app) => app.configSchema.envVars
    .filter((envVar) => envVar.required && (!envVar.defaultValue || envVar.defaultValue.startsWith("<PLACEHOLDER")))
    .map((envVar) => ({
      appId: app.appId,
      appName: app.name,
      key: envVar.key,
      description: envVar.description,
      secret: envVar.secret ?? false,
    })));

  const apps = stack.apps.map((app) => {
    const candidates = catalogRows.filter((row) => row.app_id === app.appId);
    const preferred = candidates.find((row) => row.store_source_id === app.storeId)
      ?? [...candidates].sort(
        (a, b) => (sourcePriority[a.source] ?? 3) - (sourcePriority[b.source] ?? 3),
      )[0];
    const appRequiredInputs = requiredInputs.filter((input) => input.appId === app.appId);

    return {
      appId: app.appId,
      name: app.name || preferred?.name || app.appId,
      description: app.description || preferred?.description || undefined,
      storeId: preferred?.store_source_id,
      available: Boolean(preferred),
      installed: installedSet.has(app.appId),
      requiredInputCount: appRequiredInputs.length,
    };
  });

  return {
    valid: true as const,
    stack: {
      id: stack.id,
      name: stack.name,
      description: stack.description,
      apps,
    },
    requiredInputs,
    summary: {
      installedCount: apps.filter((app) => app.installed).length,
      availableCount: apps.filter((app) => app.available).length,
      missingCount: apps.filter((app) => !app.available).length,
      requiredInputCount: requiredInputs.length,
    },
    message: requiredInputs.length > 0
      ? `${requiredInputs.length} required field(s) will be requested during setup.`
      : "This stack is ready for Assistant review.",
  };
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

function getPublicStackShare(shareId: string) {
  if (!/^[A-Za-z0-9_-]{20,32}$/.test(shareId)) return null;
  const row = db.select().from(schema.sharedStacks)
    .where(sql`${schema.sharedStacks.id} = ${shareId}`).get();
  if (!row || row.revokedAt || Date.parse(row.expiresAt) <= Date.now()) return null;

  try {
    const parsed = talomeStackSchema.safeParse(JSON.parse(row.stackJson));
    if (!parsed.success) return null;
    return { row, stack: parsed.data };
  } catch {
    return null;
  }
}

/** GET /api/stacks/public/:shareId — safe public preview; never returns compose. */
stacks.get("/public/:shareId", (c) => {
  const shared = getPublicStackShare(c.req.param("shareId"));
  if (!shared) return c.json({ error: "This shared stack is unavailable or has expired" }, 404);

  const { row, stack } = shared;
  return c.json({
    id: row.id,
    name: stack.name,
    description: stack.description,
    tagline: stack.tagline,
    author: stack.author,
    tags: stack.tags,
    version: stack.version,
    appCount: stack.apps.length,
    apps: stack.apps.map((app) => ({
      appId: app.appId,
      name: app.name,
      description: app.description?.slice(0, 240),
      requiredInputCount: app.configSchema.envVars.filter((envVar) =>
        envVar.required && (!envVar.defaultValue || envVar.defaultValue.startsWith("<PLACEHOLDER"))
      ).length,
    })),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  });
});

/** GET /api/stacks/public/:shareId/code — retrieve the sanitized portable import code. */
stacks.get("/public/:shareId/code", (c) => {
  const shared = getPublicStackShare(c.req.param("shareId"));
  if (!shared) return c.json({ error: "This shared stack is unavailable or has expired" }, 404);

  db.update(schema.sharedStacks)
    .set({ viewCount: shared.row.viewCount + 1 })
    .where(sql`${schema.sharedStacks.id} = ${shared.row.id}`)
    .run();
  return c.json({ shareCode: encodeShareCode(shared.stack) });
});

/** DELETE /api/stacks/shares/:shareId — revoke a link created by this account. */
stacks.delete("/shares/:shareId", (c) => {
  const shareId = c.req.param("shareId");
  const row = db.select().from(schema.sharedStacks)
    .where(sql`${schema.sharedStacks.id} = ${shareId}`).get();
  const currentUser = c.get("sessionUser" as never) as string | undefined;
  if (!row || !currentUser || row.createdBy !== currentUser) {
    return c.json({ error: "Shared stack not found" }, 404);
  }

  db.update(schema.sharedStacks)
    .set({ revokedAt: new Date().toISOString() })
    .where(sql`${schema.sharedStacks.id} = ${shareId}`)
    .run();
  return c.json({ ok: true });
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
  const body = await c.req.json().catch(() => null) as { stack?: unknown } | null;
  const parsed = talomeStackSchema.safeParse(body?.stack);
  if (!parsed.success) {
    return c.json({ error: "Invalid stack data", details: parsed.error.flatten() }, 400);
  }

  return c.json(buildStackImportPreview(parsed.data));
});

/** POST /api/stacks/export-running — build a stack from currently installed apps */
stacks.post("/export-running", async (c) => {
  const installed = db.all(sql`SELECT ia.app_id, ia.store_source_id, ac.name, ac.description, ac.compose_path, ac.env
    FROM installed_apps ia LEFT JOIN app_catalog ac ON ia.app_id = ac.app_id AND ia.store_source_id = ac.store_source_id`) as {
    app_id: string;
    store_source_id: string;
    name: string | null;
    description: string | null;
    compose_path: string | null;
    env: string | null;
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
    apps: installed.map((app) => {
      let compose = "";
      if (app.compose_path && existsSync(app.compose_path)) {
        try {
          const rawCompose = readFileSync(app.compose_path, "utf-8");
          compose = rawCompose.length <= 500_000 ? rawCompose : "";
        } catch {
          compose = "";
        }
      }

      return {
        appId: app.app_id,
        name: app.name ?? app.app_id,
        description: app.description ?? undefined,
        storeId: app.store_source_id,
        compose,
        configSchema: {
          envVars: parseCatalogEnv(app.env).map(toStackEnvVar),
        },
      };
    }),
    postInstallPrompt: "Review the imported apps, request only the required configuration, then install and connect the stack.",
  };

  const sanitized = sanitizeStackForExport(stack);
  return c.json({
    stack: sanitized,
    exportedAt: new Date().toISOString(),
    talomeVersion: TALOME_VERSION,
  } satisfies StackExport);
});

/**
 * POST /api/stacks/share-capsule — create a VPN-independent sharing payload.
 *
 * The compact t2 capsule contains only catalog identifiers, display metadata,
 * and the names of required inputs. It is safe to embed in a talome.dev URL
 * fragment because it never includes Compose YAML, defaults, or secret values.
 * A sanitized t1 file code is returned separately for custom/off-catalog apps.
 */
stacks.post("/share-capsule", async (c) => {
  let body: { stack?: unknown; stackId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  let stack: TalomeStack | undefined;
  if (typeof body.stackId === "string") {
    stack = BUILT_IN_STACKS.find((candidate) => candidate.id === body.stackId);
  } else if (body.stack) {
    const parsedStack = talomeStackSchema.safeParse(body.stack);
    if (!parsedStack.success) {
      return c.json({ error: "Invalid stack data", details: parsedStack.error.flatten() }, 400);
    }
    stack = parsedStack.data;
  }

  if (!stack) return c.json({ error: "Stack not found" }, 404);

  const sanitized = sanitizeStackForExport(stack);
  const capsule = buildStackCapsule(sanitized);
  const capsuleCode = encodeCapsuleCode(capsule);
  const fileCode = encodeShareCode(sanitized);
  const fileStem = stackFileStem(sanitized);
  const appIds = [...new Set(capsule.apps.map((app) => app.appId))];
  const availableRows = db.all(
    sql`SELECT DISTINCT app_id FROM app_catalog WHERE app_id IN (${sql.join(appIds.map((id) => sql`${id}`), sql`, `)})`,
  ) as { app_id: string }[];
  const availableIds = new Set(availableRows.map((row) => row.app_id));
  const missingCatalogApps = capsule.apps
    .filter((app) => !availableIds.has(app.appId))
    .map((app) => ({ appId: app.appId, name: app.name }));
  const fingerprint = capsuleCode.slice(capsuleCode.lastIndexOf(".") + 1);
  const qrEligible = capsuleCode.length <= MAX_QR_PAYLOAD_LENGTH;

  return c.json({
    capsuleCode,
    fingerprint,
    qrEligible,
    maxQrPayloadLength: MAX_QR_PAYLOAD_LENGTH,
    publicLinkEligible: capsuleCode.length <= MAX_CAPSULE_LINK_LENGTH,
    recipeFileCode: capsuleCode,
    recipeFileName: `${fileStem}.talome-stack`,
    recoveryFileCode: fileCode,
    recoveryFileName: `${fileStem}.talome-recovery`,
    hasCustomApps: missingCatalogApps.length > 0,
    recommendedTransport: missingCatalogApps.length > 0 ? "recovery-file" : qrEligible ? "qr-or-code" : "code-or-file",
    // Backward-compatible aliases for clients created before recipe/recovery files were split.
    fileCode,
    fileName: `${fileStem}.talome-stack`,
    linkCompatible: capsuleCode.length <= MAX_CAPSULE_LINK_LENGTH,
    capsuleLength: capsuleCode.length,
    maxLinkLength: MAX_CAPSULE_LINK_LENGTH,
    missingCatalogApps,
    privacy: {
      includesCompose: false,
      includesValues: false,
      includesServerAddress: false,
    },
    message: missingCatalogApps.length > 0
      ? "The public capsule works as a preview. Share the .talome-recovery file for exact custom-app recovery."
      : "This capsule can be opened without reaching the sender's Talome server.",
  });
});

/** POST /api/stacks/share-link — legacy server-hosted links kept for existing clients */
stacks.post("/share-link", async (c) => {
  let body: { stack?: unknown; stackId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  let stack: TalomeStack | undefined;
  if (typeof body.stackId === "string") {
    stack = BUILT_IN_STACKS.find((s) => s.id === body.stackId);
  } else if (body.stack) {
    const parsedStack = talomeStackSchema.safeParse(body.stack);
    if (!parsedStack.success) {
      return c.json({ error: "Invalid stack data", details: parsedStack.error.flatten() }, 400);
    }
    stack = parsedStack.data;
  }

  if (!stack) return c.json({ error: "Stack not found" }, 404);

  const sanitized = sanitizeStackForExport(stack);
  const encoded = encodeShareCode(sanitized);
  const now = new Date();
  const shareId = randomBytes(16).toString("base64url");
  const expiresAt = new Date(now.getTime() + SHARE_LINK_TTL_MS).toISOString();
  const createdBy = (c.get("sessionUser" as never) as string | undefined) ?? "system";

  db.insert(schema.sharedStacks).values({
    id: shareId,
    stackJson: JSON.stringify(sanitized),
    createdBy,
    createdAt: now.toISOString(),
    expiresAt,
  }).run();

  return c.json({
    shareCode: encoded,
    shareId,
    sharePath: `/s/${shareId}`,
    expiresAt,
    length: encoded.length,
    message: "Share this preview link, or use the portable code for another Talome instance.",
  });
});

const importCodeSchema = z.object({
  code: z.string().min(1).max(500_000),
});

/** POST /api/stacks/import-code — decode a share code and preview */
stacks.post("/import-code", async (c) => {
  const parsed = importCodeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const code = normalizeImportCode(parsed.data.code);
  let decoded: unknown;
  try {
    decoded = code.startsWith(CAPSULE_CODE_PREFIX)
      ? decodeCapsuleCode(code)
      : decodeShareCode(code);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid share code" }, 400);
  }

  if (code.startsWith(CAPSULE_CODE_PREFIX)) {
    const capsule = stackCapsuleSchema.safeParse(decoded);
    if (!capsule.success) {
      return c.json({ error: "Invalid stack capsule", details: capsule.error.flatten() }, 400);
    }
    return c.json(buildStackImportPreview(capsuleToStack(capsule.data)));
  }

  const stack = talomeStackSchema.safeParse(decoded);
  if (!stack.success) {
    return c.json({ error: "Invalid stack data", details: stack.error.flatten() }, 400);
  }
  return c.json(buildStackImportPreview(stack.data));
});

export { stacks };
