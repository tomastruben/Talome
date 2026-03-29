import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { detectStoreType, getAdapter } from "./adapters/index.js";
import type { AppManifest, StoreSource, StoreType } from "@talome/types";

const exec = promisify(execCb);

const STORES_CACHE_DIR = join(homedir(), ".talome", "stores");

const DEFAULT_STORES: { name: string; gitUrl: string; type: StoreType }[] = [
  { name: "CasaOS Official", gitUrl: "https://github.com/IceWhaleTech/CasaOS-AppStore.git", type: "casaos" },
  { name: "Umbrel Official", gitUrl: "https://github.com/getumbrel/umbrel-apps.git", type: "umbrel" },
  { name: "BigBearCasaOS", gitUrl: "https://github.com/bigbeartechworld/big-bear-casaos.git", type: "casaos" },
];

function generateId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function ensureDefaultStores(): void {
  const existing = db.select().from(schema.storeSources).all();
  const existingUrls = new Set(existing.map((s) => s.gitUrl).filter(Boolean));

  for (const store of DEFAULT_STORES) {
    if (existingUrls.has(store.gitUrl)) continue;

    db.insert(schema.storeSources)
      .values({
        id: generateId(),
        name: store.name,
        type: store.type,
        gitUrl: store.gitUrl,
        branch: "main",
        enabled: true,
        appCount: 0,
      })
      .run();
  }
}

async function gitCloneOrPull(gitUrl: string, localPath: string, branch: string): Promise<void> {
  mkdirSync(STORES_CACHE_DIR, { recursive: true });

  if (existsSync(join(localPath, ".git"))) {
    try {
      await exec(`git -C "${localPath}" pull --ff-only`, { timeout: 120_000 });
    } catch {
      await exec(
        `git -C "${localPath}" fetch origin ${branch} && git -C "${localPath}" reset --hard origin/${branch}`,
        { timeout: 120_000 },
      );
    }
  } else {
    await exec(`git clone --depth 1 --branch ${branch} "${gitUrl}" "${localPath}"`, {
      timeout: 300_000,
    });
  }
}

/**
 * Detect the real default branch for a remote repo by trying common names.
 * Returns the branch that worked, or throws if none succeed.
 */
async function cloneWithBranchFallback(gitUrl: string, localPath: string, preferredBranch: string): Promise<string> {
  const candidates = [preferredBranch, ...["main", "master"].filter((b) => b !== preferredBranch)];

  let lastErr: Error | undefined;
  for (const branch of candidates) {
    try {
      await exec(`git clone --depth 1 --branch ${branch} "${gitUrl}" "${localPath}"`, {
        timeout: 300_000,
      });
      return branch;
    } catch (err: any) {
      lastErr = err;
      // Clean up any partial clone before retrying
      try {
        await exec(`rm -rf "${localPath}"`);
      } catch {}
    }
  }

  throw lastErr;
}

function manifestToRow(m: AppManifest, storeSourceId: string) {
  return {
    appId: m.id,
    storeSourceId,
    name: m.name,
    version: m.version,
    tagline: m.tagline,
    description: m.description,
    releaseNotes: m.releaseNotes || null,
    icon: m.icon,
    iconUrl: m.iconUrl || null,
    coverUrl: m.coverUrl || null,
    screenshots: m.screenshots ? JSON.stringify(m.screenshots) : null,
    installNotes: m.installNotes || null,
    category: m.category,
    author: m.author,
    website: m.website || null,
    repo: m.repo || null,
    support: m.support || null,
    source: m.source,
    composePath: m.composePath,
    image: m.image || null,
    ports: JSON.stringify(m.ports),
    volumes: JSON.stringify(m.volumes),
    env: JSON.stringify(m.env),
    architectures: m.architectures ? JSON.stringify(m.architectures) : null,
    dependencies: m.dependencies ? JSON.stringify(m.dependencies) : null,
    hooks: m.hooks ? JSON.stringify(m.hooks) : null,
    permissions: m.permissions ? JSON.stringify(m.permissions) : null,
    localizedFields: (m as unknown as Record<string, unknown>).localizedFields ? JSON.stringify((m as unknown as Record<string, unknown>).localizedFields) : null,
    defaultUsername: m.defaultUsername || null,
    defaultPassword: m.defaultPassword || null,
    webPort: m.webPort || null,
  };
}

export async function syncStore(storeId: string): Promise<{ success: boolean; appCount: number; error?: string }> {
  const source = db
    .select()
    .from(schema.storeSources)
    .where(eq(schema.storeSources.id, storeId))
    .get();

  if (!source) return { success: false, appCount: 0, error: "Store not found" };

  let storePath: string;

  if (source.gitUrl) {
    storePath = source.localPath || join(STORES_CACHE_DIR, storeId);

    try {
      if (existsSync(join(storePath, ".git"))) {
        await gitCloneOrPull(source.gitUrl, storePath, source.branch);
      } else {
        const resolvedBranch = await cloneWithBranchFallback(source.gitUrl, storePath, source.branch);
        if (resolvedBranch !== source.branch) {
          db.update(schema.storeSources)
            .set({ branch: resolvedBranch })
            .where(eq(schema.storeSources.id, storeId))
            .run();
        }
      }
    } catch (err: any) {
      return { success: false, appCount: 0, error: `Git sync failed: ${err.message}` };
    }

    if (!source.localPath) {
      db.update(schema.storeSources)
        .set({ localPath: storePath })
        .where(eq(schema.storeSources.id, storeId))
        .run();
    }
  } else if (source.localPath) {
    storePath = source.localPath;
  } else {
    return { success: false, appCount: 0, error: "No git URL or local path configured" };
  }

  const storeType = source.type as StoreType;
  const adapter = getAdapter(storeType);
  if (!adapter) {
    const detected = detectStoreType(storePath);
    if (!detected) return { success: false, appCount: 0, error: "Could not detect store format" };

    const detectedAdapter = getAdapter(detected);
    if (!detectedAdapter) return { success: false, appCount: 0, error: `No adapter for format: ${detected}` };

    db.update(schema.storeSources)
      .set({ type: detected })
      .where(eq(schema.storeSources.id, storeId))
      .run();

    return syncStoreWithAdapter(storeId, storePath, source, detectedAdapter);
  }

  return syncStoreWithAdapter(storeId, storePath, source, adapter);
}

function syncStoreWithAdapter(
  storeId: string,
  storePath: string,
  source: { id: string; type: string; name: string; gitUrl: string | null; branch: string; localPath: string | null },
  adapter: { parse: (path: string, storeId: string, source?: StoreSource) => AppManifest[] },
): { success: boolean; appCount: number; error?: string } {
  let manifests: AppManifest[];
  try {
    manifests = adapter.parse(storePath, storeId, source as StoreSource);
  } catch (err: any) {
    return { success: false, appCount: 0, error: `Parse failed: ${err.message}` };
  }

  db.delete(schema.appCatalog)
    .where(eq(schema.appCatalog.storeSourceId, storeId))
    .run();

  for (const m of manifests) {
    try {
      db.insert(schema.appCatalog)
        .values(manifestToRow(m, storeId))
        .run();
    } catch {
      // Skip duplicates or malformed entries
    }
  }

  db.update(schema.storeSources)
    .set({
      lastSyncedAt: new Date().toISOString(),
      appCount: manifests.length,
    })
    .where(eq(schema.storeSources.id, storeId))
    .run();

  return { success: true, appCount: manifests.length };
}

export async function syncAllStores(): Promise<Record<string, { success: boolean; appCount: number; error?: string }>> {
  const sources = db
    .select()
    .from(schema.storeSources)
    .where(eq(schema.storeSources.enabled, true))
    .all();

  const settled = await Promise.allSettled(
    sources.map(async (source) => {
      const result = await syncStore(source.id);
      return [source.id, result] as const;
    }),
  );

  const results: Record<string, { success: boolean; appCount: number; error?: string }> = {};
  for (const entry of settled) {
    if (entry.status === "fulfilled") {
      const [id, result] = entry.value;
      results[id] = result;
    } else {
      // Find the source that failed — Promise.allSettled preserves order
      const idx = settled.indexOf(entry);
      const source = sources[idx];
      if (source) {
        results[source.id] = { success: false, appCount: 0, error: String(entry.reason) };
      }
    }
  }

  return results;
}

export async function addStore(
  name: string,
  gitUrl: string,
  branch = "main",
): Promise<{ id: string; success: boolean; error?: string }> {
  const id = generateId();

  db.insert(schema.storeSources)
    .values({
      id,
      name,
      type: "talome",
      gitUrl,
      branch,
      enabled: true,
      appCount: 0,
    })
    .run();

  const result = await syncStore(id);

  if (!result.success) {
    db.delete(schema.storeSources)
      .where(eq(schema.storeSources.id, id))
      .run();
    return { id, success: false, error: result.error };
  }

  return { id, success: true };
}

export function removeStore(storeId: string): void {
  db.delete(schema.appCatalog)
    .where(eq(schema.appCatalog.storeSourceId, storeId))
    .run();
  db.delete(schema.storeSources)
    .where(eq(schema.storeSources.id, storeId))
    .run();
}

export function initializeStores(): void {
  // One-time cleanup for legacy local built-in store rows.
  const legacyBuiltinStores = db
    .select()
    .from(schema.storeSources)
    .where(eq(schema.storeSources.type, "builtin"))
    .all();
  for (const store of legacyBuiltinStores) {
    removeStore(store.id);
  }

  ensureDefaultStores();

  // Warm/sync all enabled stores on startup so branch fallbacks are resolved
  // early and startup issues become visible in logs.
  syncAllStores()
    .then((results) => {
      for (const [storeId, result] of Object.entries(results)) {
        if (!result.success) {
          console.error(`[stores] Startup sync failed for ${storeId}: ${result.error ?? "Unknown error"}`);
        }
      }
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[stores] Startup sync-all failed: ${message}`);
    });
}
