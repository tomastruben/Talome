/**
 * Store sync performance behaviour against a real (temporary) SQLite DB and a
 * local git "remote" (file:// — no network): migrations, HEAD-sha skip,
 * transactional catalog rewrite, boot-sync planning.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const tmp = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/talome-store-compat-sync-${process.pid}-${Date.now()}`.replace(/\/+/g, "/");
  process.env.DATABASE_PATH = `${dir}/db/talome.db`;
  return { dir, home: `${dir}/home` };
});

// Keep ~/.talome untouched: every homedir() lookup lands in the temp dir.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedir = () => tmp.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

// Safety net: no git/network access to real remotes from this suite.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const guard = (cmd: string) => {
    if (/https?:\/\//.test(cmd)) throw new Error(`network git command blocked in tests: ${cmd}`);
  };
  const { promisify } = await import("node:util");
  const exec = ((cmd: string, ...rest: unknown[]) => {
    guard(cmd);
    return (actual.exec as (...args: unknown[]) => unknown)(cmd, ...rest);
  }) as typeof actual.exec;
  const promisified = promisify(actual.exec);
  Object.defineProperty(exec, promisify.custom, {
    value: (cmd: string, opts?: object) => {
      guard(cmd);
      return promisified(cmd, opts ?? {});
    },
  });
  return { ...actual, exec, default: { ...actual, exec } };
});

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { runStoreCompatMigrations } from "../db/migrations/store-compat.js";
import {
  BOOT_SYNC_MAX_AGE_MS,
  CATALOG_PARSER_VERSION,
  initializeStores,
  makeParseRev,
  planBootSync,
  replaceStoreCatalog,
  syncStore,
} from "../stores/sync.js";
import type { AppManifest } from "@talome/types";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "umbrel-apps");
const ORIGIN = join(tmp.dir, "origin");
const CHECKOUT = join(tmp.dir, "checkout");

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Talome Test", "-c", "user.email=test@talome.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function addFixtureApp(appId: string): void {
  cpSync(join(FIXTURES, appId), join(ORIGIN, appId), { recursive: true });
}

beforeAll(() => {
  runMigrations();

  mkdirSync(ORIGIN, { recursive: true });
  git(ORIGIN, "init", "-q", "-b", "main");
  cpSync(join(FIXTURES, "umbrel-app-store.yml"), join(ORIGIN, "umbrel-app-store.yml"));
  for (const app of ["immich", "photo-vault", "webui-tuner"]) addFixtureApp(app);
  git(ORIGIN, "add", "-A");
  git(ORIGIN, "commit", "-q", "-m", "initial");

  db.insert(schema.storeSources)
    .values({
      id: "umb",
      name: "Umbrel test",
      type: "umbrel",
      gitUrl: `file://${ORIGIN}`,
      branch: "main",
      localPath: CHECKOUT,
      enabled: true,
      appCount: 0,
    })
    .run();
});

afterAll(() => {
  rmSync(tmp.dir, { recursive: true, force: true });
});

function source(id: string) {
  return db.select().from(schema.storeSources).where(eq(schema.storeSources.id, id)).get()!;
}

function catalogCount(storeId: string): number {
  return db
    .select({ n: sql<number>`count(*)` })
    .from(schema.appCatalog)
    .where(eq(schema.appCatalog.storeSourceId, storeId))
    .get()!.n;
}

describe("store-compat migration", () => {
  it("adds columns, table and index, and is idempotent", () => {
    runStoreCompatMigrations();
    runStoreCompatMigrations();
    const catalogCols = (db.all(sql`PRAGMA table_info(app_catalog)`) as { name: string }[]).map((c) => c.name);
    const storeCols = (db.all(sql`PRAGMA table_info(store_sources)`) as { name: string }[]).map((c) => c.name);
    expect(catalogCols).toContain("umbrel_meta");
    expect(storeCols).toContain("last_parsed_rev");
    const indexes = (db.all(sql`PRAGMA index_list(app_catalog)`) as { name: string }[]).map((i) => i.name);
    expect(indexes).toContain("idx_app_catalog_store_source");
    const tables = db.all(sql`SELECT name FROM sqlite_master WHERE type='table' AND name='app_install_options'`);
    expect(tables).toHaveLength(1);
    const versions = db.all(sql`SELECT version FROM schema_versions WHERE version = 19`);
    expect(versions).toHaveLength(1);
  });

  it("uses an index for the catalog store filter", () => {
    const plan = db.all(
      sql`EXPLAIN QUERY PLAN SELECT * FROM app_catalog WHERE store_source_id IN ('a', 'b')`,
    ) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/USING (COVERING )?INDEX/);
  });
});

describe("syncStore — git HEAD skip + transactional rewrite", () => {
  it("clones and parses on first sync, persisting Umbrel 2.0 metadata", async () => {
    const result = await syncStore("umb");
    expect(result).toEqual({ success: true, appCount: 3 });
    const head = git(CHECKOUT, "rev-parse", "HEAD");
    expect(source("umb").lastParsedRev).toBe(makeParseRev(head, "umbrel"));
    expect(catalogCount("umb")).toBe(3);

    const row = db.select().from(schema.appCatalog).where(eq(schema.appCatalog.appId, "photo-vault")).get()!;
    const meta = JSON.parse(row.umbrelMeta!);
    expect(meta.folderAccess.map((f: { id: string }) => f.id)).toEqual(["photos", "import"]);
    expect(meta.storage).toEqual({ dataRoot: "data" });
  });

  it("skips re-parsing when HEAD is unchanged", async () => {
    db.update(schema.appCatalog).set({ tagline: "sentinel" }).where(eq(schema.appCatalog.appId, "immich")).run();
    const result = await syncStore("umb");
    expect(result).toEqual({ success: true, appCount: 3, unchanged: true });
    // Catalog was not rewritten
    const row = db.select().from(schema.appCatalog).where(eq(schema.appCatalog.appId, "immich")).get()!;
    expect(row.tagline).toBe("sentinel");
    expect(source("umb").lastSyncedAt).toBeTruthy();
  });

  it("re-parses when forced", async () => {
    const result = await syncStore("umb", { force: true });
    expect(result).toEqual({ success: true, appCount: 3 });
    const row = db.select().from(schema.appCatalog).where(eq(schema.appCatalog.appId, "immich")).get()!;
    expect(row.tagline).toBe("Self-hosted photo and video backup");
  });

  it("re-parses after new commits land", async () => {
    addFixtureApp("ollama");
    git(ORIGIN, "add", "-A");
    git(ORIGIN, "commit", "-q", "-m", "add ollama");
    const result = await syncStore("umb");
    expect(result).toEqual({ success: true, appCount: 4 });
    expect(source("umb").lastParsedRev).toBe(makeParseRev(git(ORIGIN, "rev-parse", "HEAD"), "umbrel"));
  });

  it("re-parses when the parser version changed, without pulling", async () => {
    db.update(schema.storeSources).set({ lastParsedRev: "deadbeef:umbrel:v0" }).where(eq(schema.storeSources.id, "umb")).run();
    // A new upstream commit must NOT be pulled in skipPull mode
    addFixtureApp("jellyfin");
    git(ORIGIN, "add", "-A");
    git(ORIGIN, "commit", "-q", "-m", "add jellyfin");
    const result = await syncStore("umb", { skipPull: true });
    expect(result).toEqual({ success: true, appCount: 4 });
    expect(source("umb").lastParsedRev?.endsWith(`:v${CATALOG_PARSER_VERSION}`)).toBe(true);
  });

  it("parses local-path stores (no git) every time", async () => {
    db.insert(schema.storeSources)
      .values({ id: "local", name: "Local", type: "umbrel", branch: "main", localPath: FIXTURES, enabled: true, appCount: 0 })
      .run();
    const first = await syncStore("local");
    expect(first).toEqual({ success: true, appCount: 9 });
    expect(source("local").lastParsedRev).toBeNull();
    const second = await syncStore("local");
    expect(second.unchanged).toBeUndefined();
  });
});

describe("replaceStoreCatalog", () => {
  const manifest = (id: string, extra: Partial<AppManifest> = {}): AppManifest => ({
    id,
    name: id,
    version: "1",
    tagline: "",
    description: "",
    icon: "📦",
    category: "other",
    author: "x",
    source: "umbrel",
    storeId: "local",
    composePath: `/x/${id}/docker-compose.yml`,
    ports: [],
    volumes: [],
    env: [],
    ...extra,
  });

  it("dedupes ids and replaces the store's rows only", () => {
    const before = catalogCount("umb");
    const many = Array.from({ length: 95 }, (_, i) => manifest(`app-${i}`));
    const inserted = replaceStoreCatalog("local", [...many, manifest("app-1", { name: "duplicate" })]);
    expect(inserted).toBe(95);
    expect(catalogCount("local")).toBe(95);
    expect(catalogCount("umb")).toBe(before);
    const row = db.select().from(schema.appCatalog).where(eq(schema.appCatalog.appId, "app-1")).get()!;
    expect(row.name).toBe("app-1");
  });

  it("skips only a malformed row inside a chunk", () => {
    const bad = manifest("bad", { name: undefined as unknown as string });
    const inserted = replaceStoreCatalog("local", [manifest("a"), bad, manifest("b")]);
    expect(inserted).toBe(2);
    expect(catalogCount("local")).toBe(2);
  });
});

describe("planBootSync", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  const fresh = new Date(now - 60 * 60 * 1000).toISOString();
  const rev = `abc123:umbrel:v${CATALOG_PARSER_VERSION}`;

  it("syncs stores that were never synced, are stale, empty or forced", () => {
    expect(planBootSync({ lastSyncedAt: null, lastParsedRev: null, appCount: 0, gitUrl: "x" }, now)).toBe("sync");
    expect(
      planBootSync({ lastSyncedAt: new Date(now - BOOT_SYNC_MAX_AGE_MS).toISOString(), lastParsedRev: rev, appCount: 5, gitUrl: "x" }, now),
    ).toBe("sync");
    expect(planBootSync({ lastSyncedAt: fresh, lastParsedRev: rev, appCount: 0, gitUrl: "x" }, now)).toBe("sync");
    expect(planBootSync({ lastSyncedAt: fresh, lastParsedRev: rev, appCount: 5, gitUrl: "x" }, now, true)).toBe("sync");
    expect(planBootSync({ lastSyncedAt: "garbage", lastParsedRev: rev, appCount: 5, gitUrl: "x" }, now)).toBe("sync");
  });

  it("skips fresh catalogs and re-parses ones from an older parser", () => {
    expect(planBootSync({ lastSyncedAt: fresh, lastParsedRev: rev, appCount: 5, gitUrl: "x" }, now)).toBe("skip");
    expect(planBootSync({ lastSyncedAt: fresh, lastParsedRev: null, appCount: 5, gitUrl: "x" }, now)).toBe("reparse");
    expect(planBootSync({ lastSyncedAt: fresh, lastParsedRev: "abc:umbrel:v1", appCount: 5, gitUrl: "x" }, now)).toBe("reparse");
  });
});

describe("initializeStores", () => {
  it("does not sync (or touch git) when every catalog is fresh", async () => {
    // Pre-seed the default stores as freshly synced so nothing needs the network.
    const freshRev = `abc:x:v${CATALOG_PARSER_VERSION}`;
    const now = new Date().toISOString();
    db.update(schema.storeSources).set({ lastSyncedAt: now, lastParsedRev: freshRev, appCount: 3 }).run();
    for (const [i, gitUrl] of [
      "https://github.com/IceWhaleTech/CasaOS-AppStore.git",
      "https://github.com/getumbrel/umbrel-apps.git",
      "https://github.com/bigbeartechworld/big-bear-casaos.git",
    ].entries()) {
      db.insert(schema.storeSources)
        .values({ id: `default-${i}`, name: gitUrl, type: "umbrel", gitUrl, branch: "main", enabled: true, appCount: 3, lastSyncedAt: now, lastParsedRev: freshRev })
        .run();
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const before = db.select().from(schema.storeSources).all().map((s) => s.lastSyncedAt);
    initializeStores();
    await new Promise((r) => setTimeout(r, 50));
    const after = db.select().from(schema.storeSources).all().map((s) => s.lastSyncedAt);
    expect(after).toEqual(before);
    expect(log.mock.calls.some((c) => String(c[0]).includes("skipping startup sync"))).toBe(true);
    log.mockRestore();
  });

  it("re-parses a store written by an older parser at boot (local, no pull)", async () => {
    db.update(schema.storeSources).set({ lastParsedRev: null }).where(eq(schema.storeSources.id, "local")).run();
    db.update(schema.storeSources).set({ appCount: 3 }).where(eq(schema.storeSources.id, "local")).run();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    initializeStores();
    await vi.waitFor(() => expect(catalogCount("local")).toBe(9), { timeout: 5000 });
    log.mockRestore();
  });
});
