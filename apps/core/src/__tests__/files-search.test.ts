/**
 * Files search (GET /api/files/search): name search below a folder or in every
 * location, inside the file manager's boundary and within its limits. Real
 * temp filesystem for the route; injected disk and clock for the limits.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const tmp = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/talome-files-search-${process.pid}-${Date.now()}`.replace(/\/+/g, "/");
  process.env.DATABASE_PATH = `${dir}/db/talome.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
  return { dir, home: `${dir}/home` };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const homedir = () => tmp.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

import { mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";

mkdirSync(join(tmp.dir, "db"), { recursive: true });
const { runMigrations } = await import("../db/migrate.js");
const { db, schema } = await import("../db/index.js");
const { setSetting } = await import("../utils/settings.js");
const { TALOME_HOME, TALOME_FILES_HOME, canonicalizePath, createPathGuard, isAllowed } = await import("../utils/filesystem.js");
const { files, folderErrorResponse } = await import("../routes/files.js");
const { requirePermission } = await import("../middleware/require-permission.js");
const {
  SEARCH_LIMITS,
  SEARCH_SKIP_DIRS,
  createDiskLimiter,
  matchScore,
  queryTokens,
  searchDisk,
  searchFiles,
  searchGate,
} = await import("../utils/file-search.js");
type FileSearchDeps = import("../utils/file-search.js").FileSearchDeps;
type SearchDirent = import("../utils/file-search.js").SearchDirent;

const root = TALOME_FILES_HOME;
const outside = join(tmp.dir, "outside");

interface SearchBody {
  path: string | null;
  query: string;
  items: Array<{ name: string; path: string; isDirectory: boolean; size: number; modified: string | null }>;
  truncated: string | null;
  skipped: number;
  limits: { results: number; maxDepth: number; timeBudgetMs: number; maxEntries: number };
  elapsedMs: number;
  error?: string;
}

function search(params: Record<string, string>, init?: RequestInit) {
  return files.request(`/search?${new URLSearchParams(params).toString()}`, init);
}

async function searchJson(params: Record<string, string>) {
  const res = await search(params);
  return { status: res.status, body: (await res.json()) as SearchBody };
}

const names = (body: SearchBody) => body.items.map((item) => item.name);

function write(path: string, content = "x") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  setSetting("file_manager_drives", JSON.stringify([]));
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  rmSync(join(TALOME_HOME, "db-files"), { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterAll(() => {
  rmSync(tmp.dir, { recursive: true, force: true });
});

// ── Matching ─────────────────────────────────────────────────────────────

describe("matchScore", () => {
  it("ranks the whole name, then a prefix, then word starts, then anywhere", () => {
    const t = queryTokens("report");
    expect(matchScore("report.pdf", t)).toBe(0);
    expect(matchScore("Report", t)).toBe(0);
    expect(matchScore("reports 2025.pdf", t)).toBe(1);
    expect(matchScore("q3 report.pdf", t)).toBe(2);
    expect(matchScore("misreported.txt", t)).toBe(3);
    expect(matchScore("notes.txt", t)).toBeNull();
  });

  it("needs every word, in any order", () => {
    const t = queryTokens("  Tax   2024 ");
    expect(t).toEqual(["tax", "2024"]);
    expect(matchScore("tax return 2024.pdf", t)).toBe(1);
    expect(matchScore("2024 tax return.pdf", t)).toBe(2);
    expect(matchScore("tax2024.pdf", t)).toBe(1);
    expect(matchScore("surtax2024.pdf", t)).toBe(3);
    expect(matchScore("tax-2023.pdf", t)).toBeNull();
    expect(matchScore("anything", [])).toBeNull();
  });

  it("matches NFD names with NFC queries and the other way round", () => {
    const nfd = "Café menu.pdf";
    const nfc = "Café menu.pdf";
    expect(matchScore(nfd, queryTokens("café"))).toBe(1);
    expect(matchScore(nfc, queryTokens("café"))).toBe(1);
  });
});

// ── Route: results ───────────────────────────────────────────────────────

describe("GET /search", () => {
  it("finds names in nested folders, best match first", async () => {
    write(join(root, "Photos", "2024", "beach report.jpg"));
    write(join(root, "report.pdf"));
    write(join(root, "Docs", "report.pdf"));
    write(join(root, "Docs", "misreported.txt"));
    mkdirSync(join(root, "Reports"));
    write(join(root, "unrelated.txt"));

    const { status, body } = await searchJson({ path: root, q: "report" });
    expect(status).toBe(200);
    expect(body.path).toBe(root);
    expect(body.query).toBe("report");
    expect(body.truncated).toBeNull();
    // Whole name (shallow, then deep), prefix (folder), word start, anywhere.
    expect(body.items.map((item) => item.path.slice(root.length + 1))).toEqual([
      "report.pdf",
      "Docs/report.pdf",
      "Reports",
      "Photos/2024/beach report.jpg",
      "Docs/misreported.txt",
    ]);
    const folder = body.items.find((item) => item.name === "Reports")!;
    expect(folder.isDirectory).toBe(true);
    const file = body.items.find((item) => item.name === "report.pdf")!;
    expect(file.size).toBe(1);
    expect(typeof file.modified).toBe("string");
    expect(body.limits).toEqual({
      results: SEARCH_LIMITS.defaultResults,
      maxDepth: SEARCH_LIMITS.maxDepth,
      timeBudgetMs: SEARCH_LIMITS.timeBudgetMs,
      maxEntries: SEARCH_LIMITS.maxEntries,
    });
  });

  it("finds a name saved in NFD with an NFC query", async () => {
    write(join(root, "Café menu.pdf"));
    const { body } = await searchJson({ path: root, q: "café" });
    expect(body.items).toHaveLength(1);
  });

  it("searches every location when no path is given", async () => {
    const drive = join(tmp.dir, "drive");
    rmSync(drive, { recursive: true, force: true });
    write(join(drive, "holiday.mov"));
    write(join(root, "holiday.txt"));
    setSetting("file_manager_drives", JSON.stringify([drive]));
    const { status, body } = await searchJson({ q: "holiday" });
    expect(status).toBe(200);
    expect(body.path).toBeNull();
    expect(names(body).sort()).toEqual(["holiday.mov", "holiday.txt"]);
  });

  it("refuses a path outside the allowed locations, traversal included (403)", async () => {
    write(join(outside, "secret.txt"));
    expect((await search({ path: outside, q: "secret" })).status).toBe(403);
    expect((await search({ path: `${root}/../../outside`, q: "secret" })).status).toBe(403);
    expect((await search({ path: "/", q: "etc" })).status).toBe(403);
  });

  it("migrates the old ~/.talome path to Talome Files, and refuses Talome's own data (403)", async () => {
    write(join(root, "kept.txt"));
    mkdirSync(join(TALOME_HOME, "db-files"), { recursive: true });
    write(join(TALOME_HOME, "db-files", "kept.db"));

    const migrated = await searchJson({ path: TALOME_HOME, q: "kept" });
    expect(migrated.status).toBe(200);
    expect(migrated.body.path).toBe(TALOME_FILES_HOME);
    expect(names(migrated.body)).toEqual(["kept.txt"]);

    expect((await search({ path: join(TALOME_HOME, "db"), q: "talome" })).status).toBe(403);
    expect((await search({ path: join(TALOME_HOME, "db-files"), q: "kept" })).status).toBe(403);
  });

  it("never follows a symlink out of the boundary, and survives a loop", async () => {
    write(join(outside, "escape-target.txt"));
    mkdirSync(join(outside, "escape-dir"));
    write(join(outside, "escape-dir", "escape-inner.txt"));
    symlinkSync(join(outside, "escape-target.txt"), join(root, "escape-link.txt"));
    symlinkSync(join(outside, "escape-dir"), join(root, "escape-folder"));
    // A link back to its own folder: never walked into, so no loop.
    mkdirSync(join(root, "loop"));
    symlinkSync(join(root, "loop"), join(root, "loop", "loop-again"));
    write(join(root, "loop", "inside.txt"));
    // A link that stays inside is a normal hit (and sorts as a folder).
    mkdirSync(join(root, "real-escape-notes"));
    symlinkSync(join(root, "real-escape-notes"), join(root, "escape-shortcut"));

    const escape = await searchJson({ path: root, q: "escape" });
    expect(escape.status).toBe(200);
    expect(names(escape.body).sort()).toEqual(["escape-shortcut", "real-escape-notes"]);
    expect(escape.body.items.find((item) => item.name === "escape-shortcut")!.isDirectory).toBe(true);

    const loop = await searchJson({ path: root, q: "loop" });
    expect(names(loop.body).sort()).toEqual(["loop", "loop-again"]);
    const inside = await searchJson({ path: root, q: "inside" });
    expect(names(inside.body)).toEqual(["inside.txt"]);
  });

  it("never reveals Talome's runtime data through an enabled parent drive", async () => {
    // The drive is the home folder, which holds ~/.talome.
    mkdirSync(join(TALOME_HOME, "db-files"), { recursive: true });
    write(join(TALOME_HOME, "db-files", "vault-secrets.db"));
    write(join(root, "vault-notes.txt"));
    write(join(tmp.home, "vault-plan.txt"));
    setSetting("file_manager_drives", JSON.stringify([tmp.home]));

    // The walk never enters ~/.talome, not even to reach Talome Files inside it.
    const fromDrive = await searchJson({ path: tmp.home, q: "vault", showHidden: "true" });
    expect(fromDrive.status).toBe(200);
    expect(names(fromDrive.body)).toEqual(["vault-plan.txt"]);

    // Every location: Talome Files is its own start, and the runtime data stays out.
    const everywhere = await searchJson({ q: "vault", showHidden: "true" });
    expect(names(everywhere.body).sort()).toEqual(["vault-notes.txt", "vault-plan.txt"]);
  });

  it("leaves hidden names out unless asked, and never opens skipped folders", async () => {
    write(join(root, ".config-backup.txt"));
    write(join(root, "config.txt"));
    mkdirSync(join(root, ".hidden-dir"));
    write(join(root, ".hidden-dir", "config-inside.txt"));
    write(join(root, "app", "node_modules", "config-lib.js"));
    write(join(root, "app", ".git", "config"));

    const plain = await searchJson({ path: root, q: "config" });
    expect(names(plain.body)).toEqual(["config.txt"]);

    const hidden = await searchJson({ path: root, q: "config", showHidden: "true" });
    expect(names(hidden.body).sort()).toEqual([".config-backup.txt", "config-inside.txt", "config.txt"]);
    expect(SEARCH_SKIP_DIRS.has("node_modules")).toBe(true);

    // A skipped folder still matches by its own name.
    const modules = await searchJson({ path: root, q: "node_modules" });
    expect(names(modules.body)).toEqual(["node_modules"]);
  });

  it("answers 400 with plain copy for a bad query", async () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ path: root }, /Type something to search for/],
      [{ path: root, q: "a" }, /at least 2 characters/],
      [{ path: root, q: " a " }, /at least 2 characters/],
      [{ path: root, q: "x".repeat(201) }, /200 characters or fewer/],
      [{ path: root, q: "ok", limit: "0" }, /at least 1 result/],
      [{ path: root, q: "ok", limit: "501" }, /500 results or fewer/],
      [{ path: root, q: "ok", limit: "lots" }, /must be a number/],
      [{ path: root, q: "ok", limit: "2.5" }, /whole number/],
      [{ path: root, q: "ok", showHidden: "yes" }, /showHidden/],
    ];
    for (const [params, message] of cases) {
      const res = await search(params);
      expect(res.status, JSON.stringify(params)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
    }
  });

  it("returns at most the limit and says the list was cut", async () => {
    for (const n of [1, 2, 3, 4]) write(join(root, `photo-${n}.jpg`));
    const { body } = await searchJson({ path: root, q: "photo", limit: "3" });
    expect(body.items).toHaveLength(3);
    expect(body.truncated).toBe("results");
    expect(body.limits.results).toBe(3);
  });

  it("searches 12 levels deep and says deeper folders were left out", async () => {
    let dir = root;
    for (let depth = 1; depth <= 12; depth++) {
      dir = join(dir, `level-${depth}`);
      mkdirSync(dir);
      if (depth === 11) write(join(dir, "needle-12.txt"));
      if (depth === 12) write(join(dir, "needle-13.txt"));
    }
    const { body } = await searchJson({ path: root, q: "needle" });
    expect(names(body)).toEqual(["needle-12.txt"]);
    expect(body.truncated).toBe("depth");
  });

  it("answers 404 for a folder that's gone and 400 for a file", async () => {
    const gone = await search({ path: join(root, "gone"), q: "ab" });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { error: string }).error).toMatch(/doesn't exist/);

    write(join(root, "note.txt"));
    const file = await search({ path: join(root, "note.txt"), q: "ab" });
    expect(file.status).toBe(400);
    expect(((await file.json()) as { error: string }).error).toMatch(/file, not a folder/);
  });

  it("explains folder errors the same way /list does", async () => {
    const answer = async (code: string) => {
      const res = folderErrorResponse(Object.assign(new Error(code), { code }));
      return res ? { status: res.status, error: ((await res.json()) as { error: string }).error } : null;
    };
    expect(await answer("ENOENT")).toEqual({ status: 404, error: "This folder doesn't exist any more." });
    expect(await answer("ENOTDIR")).toEqual({ status: 400, error: "This is a file, not a folder." });
    expect(await answer("EACCES")).toEqual({ status: 403, error: "Talome doesn't have permission to read this folder." });
    expect(await answer("EPERM")).toMatchObject({ status: 403 });
    expect(await answer("EIO")).toBeNull();
  });

  it("answers 499 when the request was dropped", async () => {
    write(join(root, "dropped.txt"));
    const controller = new AbortController();
    controller.abort();
    const res = await files.request(
      new Request(`http://localhost/search?q=dropped&path=${encodeURIComponent(root)}`, { signal: controller.signal }),
    );
    expect(res.status).toBe(499);
    expect(searchGate.active).toBe(0);
  });

  it("answers 429 while the server runs its maximum of searches, and frees the slot after", async () => {
    write(join(root, "busy.txt"));
    const releases = Array.from({ length: SEARCH_LIMITS.maxConcurrentSearches }, () => searchGate.tryAcquire());
    expect(releases.every(Boolean)).toBe(true);
    try {
      const busy = await search({ path: root, q: "busy" });
      expect(busy.status).toBe(429);
      expect(busy.headers.get("Retry-After")).toBe("2");
      expect(((await busy.json()) as { error: string }).error).toMatch(/Retry in a moment/);

      releases.pop()!();
      const ok = await search({ path: root, q: "busy" });
      expect(ok.status).toBe(200);
      // The finished search gave its slot back.
      expect(searchGate.active).toBe(SEARCH_LIMITS.maxConcurrentSearches - 1);
    } finally {
      for (const release of releases) release?.();
    }
    expect(searchGate.active).toBe(0);
  });

  it("answers 503 while every disk slot waits on a drive that isn't answering", async () => {
    write(join(root, "stalled.txt"));
    let answer!: () => void;
    const drive = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const stop = new AbortController();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Calls an earlier search gave up on, still waiting on their drive.
      for (let slot = 0; slot < SEARCH_LIMITS.diskSlots; slot++) void searchDisk.run(() => drive, stop.signal);
      stop.abort();
      expect(searchDisk.running).toBe(SEARCH_LIMITS.diskSlots);
      expect(searchDisk.stalled).toBe(false);

      vi.setSystemTime(Date.now() + SEARCH_LIMITS.diskStallMs);
      expect(searchDisk.stalled).toBe(true);
      const paused = await search({ path: root, q: "stalled" });
      expect(paused.status).toBe(503);
      expect(paused.headers.get("Retry-After")).toBe("10");
      expect(((await paused.json()) as { error: string }).error).toMatch(/A drive isn't answering/);
      expect(searchGate.active).toBe(0);
    } finally {
      vi.useRealTimers();
      answer();
    }
    await vi.waitFor(() => expect(searchDisk.running).toBe(0));
    expect((await search({ path: root, q: "stalled" })).status).toBe(200);
  });

  it("is covered by the Files permission (403 for a member without it)", async () => {
    db.insert(schema.users).values([
      { id: "no-files", username: "no-files", passwordHash: "x", role: "member", permissions: JSON.stringify({ files: false }) },
      { id: "with-files", username: "with-files", passwordHash: "x", role: "member", permissions: null },
    ]).onConflictDoNothing().run();
    write(join(root, "allowed.txt"));

    const appFor = (userId: string) => {
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("sessionRole" as never, "member" as never);
        c.set("sessionUser" as never, userId as never);
        await next();
      });
      app.use("/api/files/*", requirePermission("files"));
      app.route("/api/files", files);
      return app;
    };
    const url = `/api/files/search?q=allowed&path=${encodeURIComponent(root)}`;
    expect((await appFor("no-files").request(url)).status).toBe(403);
    expect((await appFor("with-files").request(url)).status).toBe(200);
  });
});

// ── Walk limits (injected disk and clock) ────────────────────────────────

function fakeDisk(tree: Record<string, string[]>, opts: { unreadable?: string[] } = {}): Pick<FileSearchDeps, "readdir" | "stat"> {
  const dirent = (name: string, dir: boolean): SearchDirent => ({
    name,
    isDirectory: () => dir,
    isSymbolicLink: () => false,
  });
  return {
    readdir: async (path) => {
      if (opts.unreadable?.includes(path)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      const entries = tree[path];
      if (!entries) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return entries.map((name) => dirent(name, !!tree[`${path}/${name}`]));
    },
    stat: async (path) => ({ size: 1, mtime: new Date(0), isDirectory: () => !!tree[path] }),
  };
}

const openGuard: FileSearchDeps["guard"] = { isAllowed: () => true, isCanonicalAllowed: () => true };
const starts = [{ path: "/r", canonical: "/r" }];

describe("searchFiles limits", () => {
  it("stops at the time budget and says so", async () => {
    const tree: Record<string, string[]> = { "/r": ["a", "b"], "/r/a": ["match-1"], "/r/b": ["match-2"] };
    let clock = 0;
    const outcome = await searchFiles(
      { starts, query: "match", limits: { timeBudgetMs: 2500, concurrency: 1 } },
      { ...fakeDisk(tree), guard: openGuard, now: () => (clock += 1000) },
    );
    expect(outcome.truncated).toBe("time");
    expect(outcome.aborted).toBe(false);
  });

  it("stops after the entry budget and says so", async () => {
    const tree: Record<string, string[]> = { "/r": Array.from({ length: 10 }, (_, i) => `match-${i}`) };
    const outcome = await searchFiles(
      { starts, query: "match", limits: { maxEntries: 5 } },
      { ...fakeDisk(tree), guard: openGuard, now: () => 0 },
    );
    expect(outcome.truncated).toBe("entries");
    expect(outcome.scanned).toBe(5);
    expect(outcome.items).toHaveLength(5);
  });

  it("returns nothing and says aborted when the signal fires", async () => {
    const controller = new AbortController();
    const tree: Record<string, string[]> = { "/r": ["a"], "/r/a": ["match"] };
    const disk = fakeDisk(tree);
    const outcome = await searchFiles(
      { starts, query: "match", signal: controller.signal },
      {
        ...disk,
        readdir: async (path) => {
          controller.abort();
          return disk.readdir(path);
        },
        guard: openGuard,
        now: () => 0,
      },
    );
    expect(outcome.aborted).toBe(true);
    expect(outcome.items).toEqual([]);
  });

  it("counts unreadable folders and keeps going", async () => {
    const tree: Record<string, string[]> = { "/r": ["locked", "open"], "/r/locked": ["match-a"], "/r/open": ["match-b"] };
    const outcome = await searchFiles(
      { starts, query: "match" },
      { ...fakeDisk(tree, { unreadable: ["/r/locked"] }), guard: openGuard, now: () => 0 },
    );
    expect(outcome.skipped).toBe(1);
    expect(outcome.items.map((item) => item.name)).toEqual(["match-b"]);
  });

  it("never throws, even when the guard does", async () => {
    const tree: Record<string, string[]> = { "/r": ["match"] };
    const outcome = await searchFiles(
      { starts, query: "match" },
      {
        ...fakeDisk(tree),
        guard: { isAllowed: () => true, isCanonicalAllowed: () => { throw new Error("settings unavailable"); } },
        now: () => 0,
      },
    );
    expect(outcome.items).toEqual([]);
    expect(outcome.skipped).toBe(1);
  });

  it("returns at the time budget when a folder's read never answers, and frees its gate slot", async () => {
    // "/r/nfs" is a stale network mount: its readdir never settles.
    const tree: Record<string, string[]> = { "/r": ["nfs", "match-top.txt"], "/r/nfs": [] };
    const disk = fakeDisk(tree);
    const limiter = createDiskLimiter(2);
    const release = searchGate.tryAcquire()!;
    const startedAt = Date.now();
    const outcome = await searchFiles(
      { starts, query: "match", limits: { timeBudgetMs: 60, slowFolderMs: 20 } },
      {
        ...disk,
        readdir: (path) => (path === "/r/nfs" ? new Promise<never>(() => {}) : disk.readdir(path)),
        disk: limiter,
        guard: openGuard,
        now: () => Date.now(),
      },
    );
    // The route releases in `finally`, right after the walk returns.
    release();
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(outcome.truncated).toBe("time");
    expect(outcome.skipped).toBe(1);
    expect(outcome.items.map((item) => item.name)).toEqual(["match-top.txt"]);
    expect(searchGate.active).toBe(0);
    // The hung call still holds its disk slot: it's on a thread Node can't take back.
    expect(limiter.running).toBe(1);
  });

  it("returns at once when the request goes away during a read that never answers", async () => {
    const controller = new AbortController();
    const tree: Record<string, string[]> = { "/r": ["nfs"], "/r/nfs": [] };
    const disk = fakeDisk(tree);
    const pending = searchFiles(
      { starts, query: "match", signal: controller.signal, limits: { timeBudgetMs: 60_000 } },
      {
        ...disk,
        readdir: (path) => (path === "/r/nfs" ? new Promise<never>(() => {}) : disk.readdir(path)),
        guard: openGuard,
        now: () => Date.now(),
      },
    );
    setTimeout(() => controller.abort(), 20);
    const outcome = await Promise.race([
      pending,
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 1000)),
    ]);
    expect(outcome).not.toBe("pending");
    expect(outcome).toMatchObject({ aborted: true, items: [] });
  });

  it("doesn't count a folder cut short on a healthy disk as unreadable", async () => {
    const tree: Record<string, string[]> = { "/r": ["slow"], "/r/slow": ["match"] };
    const disk = fakeDisk(tree);
    const outcome = await searchFiles(
      { starts, query: "match", limits: { timeBudgetMs: 30, slowFolderMs: 5000 } },
      {
        ...disk,
        readdir: (path) => (path === "/r/slow" ? new Promise<never>(() => {}) : disk.readdir(path)),
        guard: openGuard,
        now: () => Date.now(),
      },
    );
    expect(outcome.truncated).toBe("time");
    expect(outcome.skipped).toBe(0);
  });

  it("stops reading sizes and dates at their own budget", async () => {
    const tree: Record<string, string[]> = { "/r": ["match-fast", "match-hung"] };
    const disk = fakeDisk(tree);
    const startedAt = Date.now();
    const outcome = await searchFiles(
      { starts, query: "match", limits: { statBudgetMs: 40 } },
      {
        ...disk,
        stat: (path) => (path === "/r/match-hung" ? new Promise<never>(() => {}) : disk.stat(path)),
        guard: openGuard,
        now: () => Date.now(),
      },
    );
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(outcome.truncated).toBeNull();
    expect(outcome.items).toEqual([
      { name: "match-fast", path: "/r/match-fast", isDirectory: false, size: 1, modified: new Date(0).toISOString() },
      // No stat answer: no size or date, rather than made-up ones.
      { name: "match-hung", path: "/r/match-hung", isDirectory: false, size: 0, modified: null },
    ]);
  });

  it("stats only the results it returns", async () => {
    const tree: Record<string, string[]> = { "/r": Array.from({ length: 50 }, (_, i) => `match-${i}`) };
    const disk = fakeDisk(tree);
    const stat = vi.fn(disk.stat);
    const outcome = await searchFiles(
      { starts, query: "match", limit: 7 },
      { ...disk, stat, guard: openGuard, now: () => 0 },
    );
    expect(outcome.items).toHaveLength(7);
    expect(outcome.truncated).toBe("results");
    expect(stat).toHaveBeenCalledTimes(7);
  });
});

// ── Disk limiter ─────────────────────────────────────────────────────────

describe("createDiskLimiter", () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it("runs at most its slots at once, and a task stopped while waiting never starts", async () => {
    const limiter = createDiskLimiter(1);
    const first = deferred<string>();
    const keep = new AbortController();
    const second = new AbortController();
    const started: string[] = [];

    const a = limiter.run(() => {
      started.push("a");
      return first.promise;
    }, keep.signal);
    const b = limiter.run(async () => {
      started.push("b");
      return "b";
    }, second.signal);
    expect(started).toEqual(["a"]);
    expect(limiter.running).toBe(1);

    second.abort();
    expect(await b).toEqual({ ok: false, stopped: true, ranMs: null });
    first.resolve("a");
    expect(await a).toEqual({ ok: true, value: "a" });
    await Promise.resolve();
    expect(started).toEqual(["a"]);
    expect(limiter.running).toBe(0);
  });

  it("answers when its caller stops waiting, and keeps the slot until the disk answers", async () => {
    let clock = 0;
    const limiter = createDiskLimiter(1, { now: () => clock });
    const hung = deferred<string>();
    const stop = new AbortController();
    const pending = limiter.run(() => hung.promise, stop.signal);
    clock = 1500;
    stop.abort();
    expect(await pending).toEqual({ ok: false, stopped: true, ranMs: 1500 });
    expect(limiter.running).toBe(1);

    // The next call waits for the slot the hung one still holds.
    let ran = false;
    const next = limiter.run(async () => {
      ran = true;
      return "next";
    }, new AbortController().signal);
    expect(ran).toBe(false);
    hung.resolve("late");
    expect(await next).toEqual({ ok: true, value: "next" });
    expect(ran).toBe(true);
  });

  it("reports a failed call without throwing", async () => {
    const limiter = createDiskLimiter(1);
    const signal = new AbortController().signal;
    expect(await limiter.run(() => Promise.reject(new Error("EACCES")), signal)).toEqual({ ok: false, stopped: false });
    expect(await limiter.run(() => {
      throw new Error("sync");
    }, signal)).toEqual({ ok: false, stopped: false });
    expect(limiter.running).toBe(0);
  });

  it("is stalled only when every slot has been held for the stall time", async () => {
    let clock = 0;
    const limiter = createDiskLimiter(2, { now: () => clock, stallAfterMs: 10_000 });
    const hung = deferred<void>();
    const signal = new AbortController().signal;
    void limiter.run(() => hung.promise, signal);
    clock = 20_000;
    // One slot is still free.
    expect(limiter.stalled).toBe(false);
    void limiter.run(() => hung.promise, signal);
    expect(limiter.stalled).toBe(false);
    clock = 30_000;
    expect(limiter.stalled).toBe(true);
    hung.resolve();
    await vi.waitFor(() => expect(limiter.running).toBe(0));
    expect(limiter.stalled).toBe(false);
  });
});

// ── Boundary snapshot ────────────────────────────────────────────────────

describe("createPathGuard", () => {
  it("answers exactly like isAllowed", () => {
    const drive = join(tmp.dir, "guard-drive");
    rmSync(drive, { recursive: true, force: true });
    mkdirSync(drive, { recursive: true });
    write(join(root, "a.txt"));
    write(join(outside, "b.txt"));
    symlinkSync(join(outside, "b.txt"), join(root, "out-link"));
    symlinkSync(join(root, "a.txt"), join(root, "in-link"));
    mkdirSync(join(TALOME_HOME, "db-files"), { recursive: true });

    for (const drives of [[], [drive], [tmp.home]]) {
      setSetting("file_manager_drives", JSON.stringify(drives));
      const guard = createPathGuard();
      const paths = [
        root,
        join(root, "a.txt"),
        join(root, "missing", "deeper.txt"),
        join(root, "out-link"),
        join(root, "in-link"),
        `${root}/../../outside/b.txt`,
        outside,
        drive,
        join(drive, "x"),
        TALOME_HOME,
        join(TALOME_HOME, "db-files"),
        join(TALOME_HOME, "db", "talome.db"),
        tmp.home,
        "/",
        "",
        "relative/path",
        `${root}/\0evil`,
      ];
      for (const path of paths) {
        expect(guard.isAllowed(path), `${path} with ${JSON.stringify(drives)}`).toBe(isAllowed(path));
        const canonical = canonicalizePath(path);
        if (canonical) expect(guard.isCanonicalAllowed(canonical), `canonical ${path}`).toBe(isAllowed(path));
      }
    }
    expect(realpathSync(root)).toBe(canonicalizePath(root));
  });
});
