import { exec as execCb, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { db, schema } from "../db/index.js";
import { eq, sql } from "drizzle-orm";
import { detectStoreType, getAdapter, type StoreAdapter } from "./adapters/index.js";
import { notifyCatalogChanged } from "./catalog-events.js";
import { backfillUmbrelBackupIgnore, watchInstallsForBackupIgnore } from "./umbrel-v2-install.js";
import type { AppManifest, StoreSource, StoreType } from "@talome/types";

const exec = promisify(execCb);
const execFile = promisify(execFileCb);

/**
 * Bump when adapter output changes (new fields, parsing fixes) so catalogs
 * parsed by an older Talome are re-parsed once even if git HEAD is unchanged.
 */
export const CATALOG_PARSER_VERSION = "2";

/** Boot sync is skipped when the last successful sync is newer than this. */
export const BOOT_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface StoreSyncResult {
  success: boolean;
  appCount: number;
  error?: string;
  /** True when git HEAD and parser version were unchanged, so parsing was skipped. */
  unchanged?: boolean;
}

export interface SyncStoreOptions {
  /** Re-parse even when git HEAD and parser version are unchanged. */
  force?: boolean;
  /** Re-parse the existing local checkout without git pull (no network). */
  skipPull?: boolean;
}

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
  const extra = m as AppManifest & { localizedFields?: unknown; umbrelMeta?: unknown };
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
    localizedFields: extra.localizedFields ? JSON.stringify(extra.localizedFields) : null,
    defaultUsername: m.defaultUsername || null,
    defaultPassword: m.defaultPassword || null,
    webPort: m.webPort || null,
    umbrelMeta: extra.umbrelMeta ? JSON.stringify(extra.umbrelMeta) : null,
  };
}

/** git HEAD of a local checkout, or null when it is not a git repository. */
async function readGitHead(storePath: string): Promise<string | null> {
  if (!existsSync(join(storePath, ".git"))) return null;
  try {
    const { stdout } = await execFile("git", ["-C", storePath, "rev-parse", "HEAD"], { timeout: 15_000 });
    const sha = stdout.trim();
    return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Identity of a parse: same HEAD + same adapter + same parser version ⇒ same catalog. */
export function makeParseRev(gitHead: string, storeType: string): string {
  return `${gitHead}:${storeType}:v${CATALOG_PARSER_VERSION}`;
}

/** Catalogs at least this big are checked for sudden drops after a parse. */
const DROP_CHECK_MIN_ROWS = 20;

/** True when a re-parse returned under half of a sizeable previous catalog. */
export function isSuspiciousDrop(previous: number, next: number): boolean {
  return previous >= DROP_CHECK_MIN_ROWS && next * 2 < previous;
}

function countCatalogRows(storeId: string): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.appCatalog)
    .where(eq(schema.appCatalog.storeSourceId, storeId))
    .get();
  return row?.count ?? 0;
}

/** Rows per multi-row INSERT (35 columns × 40 rows stays far below SQLite's variable limit). */
const CATALOG_INSERT_CHUNK = 40;

/**
 * Replace a store's catalog rows in ONE transaction: readers never observe a
 * half-written catalog and ~700 rows commit with a single fsync.
 * Duplicate app ids keep the first occurrence (matches the old per-row
 * insert that skipped UNIQUE violations).
 */
export function replaceStoreCatalog(storeId: string, manifests: AppManifest[]): number {
  const seen = new Set<string>();
  const rows: ReturnType<typeof manifestToRow>[] = [];
  for (const m of manifests) {
    if (!m?.id || seen.has(m.id)) continue;
    seen.add(m.id);
    rows.push(manifestToRow(m, storeId));
  }

  let inserted = 0;
  db.transaction((tx) => {
    tx.delete(schema.appCatalog).where(eq(schema.appCatalog.storeSourceId, storeId)).run();
    for (let i = 0; i < rows.length; i += CATALOG_INSERT_CHUNK) {
      const chunk = rows.slice(i, i + CATALOG_INSERT_CHUNK);
      try {
        tx.insert(schema.appCatalog).values(chunk).run();
        inserted += chunk.length;
      } catch {
        // A malformed row fails its whole chunk — fall back to row-by-row so
        // only the bad entry is skipped (a failed statement does not abort
        // the surrounding transaction in SQLite).
        for (const row of chunk) {
          try {
            tx.insert(schema.appCatalog).values(row).run();
            inserted++;
          } catch {
            // Skip malformed entries
          }
        }
      }
    }
  });
  // The container list memoizes catalog lookups (icons, names) — serve the new catalog now.
  notifyCatalogChanged();
  return inserted;
}

export async function syncStore(storeId: string, options: SyncStoreOptions = {}): Promise<StoreSyncResult> {
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
        if (!options.skipPull) await gitCloneOrPull(source.gitUrl, storePath, source.branch);
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

    return syncStoreWithAdapter(storeId, storePath, source, detectedAdapter, options);
  }

  return syncStoreWithAdapter(storeId, storePath, source, adapter, options);
}

async function syncStoreWithAdapter(
  storeId: string,
  storePath: string,
  source: typeof schema.storeSources.$inferSelect,
  adapter: StoreAdapter,
  options: SyncStoreOptions,
): Promise<StoreSyncResult> {
  const head = await readGitHead(storePath);
  const parseRev = head ? makeParseRev(head, adapter.type) : null;

  // Unchanged checkout + unchanged parser ⇒ the catalog is already current.
  // An empty catalog is always re-parsed: it can only come from a bad parse.
  const existing = countCatalogRows(storeId);
  if (!options.force && parseRev && source.lastParsedRev === parseRev) {
    if (existing > 0) {
      db.update(schema.storeSources)
        .set({ lastSyncedAt: new Date().toISOString(), appCount: existing })
        .where(eq(schema.storeSources.id, storeId))
        .run();
      return { success: true, appCount: existing, unchanged: true };
    }
  }

  let manifests: AppManifest[];
  try {
    manifests = adapter.parseAsync
      ? await adapter.parseAsync(storePath, storeId, source as StoreSource)
      : adapter.parse(storePath, storeId, source as StoreSource);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, appCount: 0, error: `Parse failed: ${message}` };
  }

  // A parse that finds nothing (unreadable checkout, adapter failure) must not
  // wipe a working catalog — keep what we have and try again next sync.
  if (manifests.length === 0 && existing > 0) {
    return {
      success: false,
      appCount: existing,
      error: "Parse found no apps; keeping the existing catalog",
    };
  }

  const appCount = replaceStoreCatalog(storeId, manifests);

  // Only remember this parse (and so skip the next one) when it looks
  // complete: an empty result or a sudden drop to under half the previous
  // catalog is re-parsed on the next sync instead of sticking until upstream
  // HEAD moves.
  const suspicious = appCount === 0 || isSuspiciousDrop(existing, appCount);

  db.update(schema.storeSources)
    .set({
      lastSyncedAt: new Date().toISOString(),
      appCount,
      lastParsedRev: suspicious ? null : parseRev,
    })
    .where(eq(schema.storeSources.id, storeId))
    .run();

  return { success: true, appCount };
}

export async function syncAllStores(options: SyncStoreOptions = {}): Promise<Record<string, StoreSyncResult>> {
  const sources = db
    .select()
    .from(schema.storeSources)
    .where(eq(schema.storeSources.enabled, true))
    .all();

  const settled = await Promise.allSettled(
    sources.map(async (source) => {
      const result = await syncStore(source.id, options);
      return [source.id, result] as const;
    }),
  );

  const results: Record<string, StoreSyncResult> = {};
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
  notifyCatalogChanged();
}

export type BootSyncAction = "skip" | "reparse" | "sync";

/**
 * Decide what a store needs at boot:
 * - `sync`    — never synced, stale (≥ 24h), empty, or forced: git pull + parse
 * - `reparse` — synced recently but by an older parser: re-parse the local
 *               checkout without touching the network
 * - `skip`    — synced recently by the current parser
 */
export function planBootSync(
  source: { lastSyncedAt: string | null; lastParsedRev: string | null; appCount: number; gitUrl: string | null },
  now: number = Date.now(),
  force = false,
): BootSyncAction {
  if (force || !source.lastSyncedAt) return "sync";
  const last = Date.parse(source.lastSyncedAt);
  if (Number.isNaN(last) || now - last >= BOOT_SYNC_MAX_AGE_MS || last > now + 60_000) return "sync";
  if (source.appCount === 0) return "sync";
  if (!source.lastParsedRev?.endsWith(`:v${CATALOG_PARSER_VERSION}`)) {
    // Local-path stores have no git HEAD; re-parsing them is always local.
    return "reparse";
  }
  return "skip";
}

function isForcedBootSync(): boolean {
  const flag = process.env.TALOME_FORCE_STORE_SYNC;
  return flag === "1" || flag === "true";
}

export function initializeStores(options: { force?: boolean } = {}): void {
  // Umbrel backupIgnore merges settle when install operations finish.
  watchInstallsForBackupIgnore();

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

  // Sync on startup only what needs it: a recent catalog is served as-is, so
  // boot no longer pulls and re-parses ~700 app directories every time.
  // Set TALOME_FORCE_STORE_SYNC=1 (or pass force) to sync everything.
  const force = options.force === true || isForcedBootSync();
  const sources = db
    .select()
    .from(schema.storeSources)
    .where(eq(schema.storeSources.enabled, true))
    .all();

  const now = Date.now();
  const work = sources
    .map((source) => ({ source, action: planBootSync(source, now, force) }))
    .filter((w) => w.action !== "skip");

  if (work.length === 0) {
    console.log(`[stores] Catalog is fresh (< 24h) — skipping startup sync for ${sources.length} store(s)`);
    scheduleCatalogBackfills();
    return;
  }

  Promise.allSettled(
    work.map(async ({ source, action }) => {
      const result = await syncStore(source.id, { force, skipPull: action === "reparse" });
      if (!result.success) {
        console.error(`[stores] Startup sync failed for ${source.id}: ${result.error ?? "Unknown error"}`);
      }
      return { type: source.type, success: result.success };
    }),
  )
    .then((settled) => {
      // Backfills read Umbrel metadata from the catalog: only run them once
      // every Umbrel store parsed with the current parser, else retry next boot.
      const umbrelFailed = settled.some((r) =>
        r.status === "rejected" || (r.value.type === "umbrel" && !r.value.success),
      );
      if (!umbrelFailed) scheduleCatalogBackfills();
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[stores] Startup sync-all failed: ${message}`);
    });
}

/**
 * One-time data backfills that need a current catalog (runs after migrations,
 * off the startup path). Each backfill is idempotent and guards itself.
 */
function scheduleCatalogBackfills(): void {
  setImmediate(() => {
    backfillUmbrelBackupIgnore({ isCatalogCurrent: isStoreCatalogCurrent });
  });
}

/**
 * Enabled stores were just synced (or verified fresh) by initializeStores;
 * a disabled store's catalog is only current when its last parse used the
 * current parser. A removed store has nothing left to wait for.
 */
export function isStoreCatalogCurrent(storeSourceId: string): boolean {
  const source = db.select().from(schema.storeSources).where(eq(schema.storeSources.id, storeSourceId)).get();
  if (!source) return true;
  return source.enabled || !!source.lastParsedRev?.endsWith(`:v${CATALOG_PARSER_VERSION}`);
}
