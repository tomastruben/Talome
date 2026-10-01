/**
 * Name search for the file manager (`GET /api/files/search`).
 *
 * A breadth-first walk from one folder (or every location) that matches
 * names, never contents. It stays inside the file manager's boundary: each
 * entry is checked against a `PathGuard` snapshot, symlinks are never
 * followed into, and a symlink that matches is kept only when it resolves
 * inside an allowed location. The walk is bounded by depth, entries looked
 * at and a time budget, and says which bound cut it short.
 *
 * Every disk call is bounded too. A folder on a drive that stops answering (a
 * stale network mount, a disconnected disk) can't hold the walk: each read
 * and stat is waited for only until the walk's deadline or the request going
 * away, and the walk returns then. The calls themselves can't be cancelled,
 * so they go through a server-wide `DiskLimiter` that keeps searches to a
 * share of Node's file-system threads, even while some of them hang.
 *
 * Pure apart from its injected dependencies (disk, clock, guard), so the
 * limits can be tested without a large tree or a slow disk. It never throws:
 * an unreadable folder is counted in `skipped` and the walk goes on.
 */
import { join } from "node:path";
import type { PathGuard } from "./filesystem.js";

export const SEARCH_LIMITS = {
  /** Results returned when the request doesn't ask for a number. */
  defaultResults: 200,
  /** Most results one request may ask for. */
  maxResults: 500,
  /** Folders deeper than this below the start aren't opened. */
  maxDepth: 12,
  /** The walk stops after this long and returns what it found. */
  timeBudgetMs: 4000,
  /**
   * Sizes and dates of the results are read for at most this long after the
   * walk; results still waiting come back without them.
   */
  statBudgetMs: 1000,
  /**
   * A folder whose read was still waiting on the disk this long when the walk
   * stopped counts as one that couldn't be read (`skipped`).
   */
  slowFolderMs: 1000,
  /** The walk stops after looking at this many entries. */
  maxEntries: 100_000,
  /** Disk calls one search has waiting at the same time. */
  concurrency: 2,
  /**
   * Disk calls all searches together may have running, counting the ones a
   * search stopped waiting for. Node runs file-system calls on 4 threads by
   * default, shared with file streaming and uploads; search keeps 2 free.
   */
  diskSlots: 2,
  /**
   * When every disk slot has been held this long, a drive isn't answering:
   * new searches answer 503 instead of waiting for nothing.
   */
  diskStallMs: 10_000,
  /** Searches the server runs at once; more answer 429. */
  maxConcurrentSearches: 4,
} as const;

export type SearchLimits = { -readonly [K in keyof typeof SEARCH_LIMITS]: number };

/**
 * Folders the walk never opens: version-control and package internals, and
 * the housekeeping folders operating systems and NAS software leave on
 * drives. They can still match by name; they are just not searched inside.
 */
export const SEARCH_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "@eaDir",
  "#recycle",
  ".Trashes",
  ".Spotlight-V100",
  ".fseventsd",
  ".TemporaryItems",
  ".DocumentRevisions-V100",
  "$RECYCLE.BIN",
  "System Volume Information",
  "lost+found",
]);

/** Why a result may be incomplete. */
export type SearchTruncation = "results" | "time" | "entries" | "depth";

export interface SearchStart {
  /** The path as the file manager shows it (results are built from it). */
  path: string;
  /** The same folder, canonicalized (realpath), for boundary checks. */
  canonical: string;
}

export interface SearchHit {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: string | null;
}

export interface SearchOutcome {
  items: SearchHit[];
  /** Null when every folder in reach was searched and every match fits. */
  truncated: SearchTruncation | null;
  /**
   * Folders that couldn't be read (permissions, a drive going away), or whose
   * drive still hadn't answered after `slowFolderMs` when the walk stopped.
   */
  skipped: number;
  /** The request went away before the walk finished. */
  aborted: boolean;
  /** Entries looked at. */
  scanned: number;
}

export interface SearchDirent {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface SearchStat {
  size: number;
  mtime: Date;
  isDirectory(): boolean;
}

export interface FileSearchDeps {
  readdir(path: string): Promise<SearchDirent[]>;
  /** Follows symlinks, like `fs.stat`. */
  stat(path: string): Promise<SearchStat>;
  now(): number;
  guard: Pick<PathGuard, "isAllowed" | "isCanonicalAllowed">;
  /** Shares disk calls with other searches; unlimited when left out. */
  disk?: DiskLimiter;
}

export interface FileSearchOptions {
  starts: SearchStart[];
  query: string;
  limit?: number;
  showHidden?: boolean;
  signal?: AbortSignal;
  /** Overrides for tests. */
  limits?: Partial<SearchLimits>;
}

// ── Matching ─────────────────────────────────────────────────────────────

/**
 * Names compare in NFC and lower case, so "Café" typed on one keyboard finds
 * "café" saved by macOS in NFD. Plain `toLowerCase`, not the locale's, so
 * the result doesn't depend on the server's language.
 */
export function normalizeForMatch(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

/** The query's words. Every word must appear in a name, in any order. */
export function queryTokens(query: string): string[] {
  return normalizeForMatch(query).split(/\s+/).filter(Boolean);
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

function startsAtWordBoundary(name: string, token: string): boolean {
  let from = 0;
  while (from <= name.length) {
    const index = name.indexOf(token, from);
    if (index < 0) return false;
    if (index === 0 || !WORD_CHAR.test(name[index - 1])) return true;
    from = index + 1;
  }
  return false;
}

/**
 * How well a name matches (lower is better), or null when it doesn't:
 * 0 the whole name (with or without its extension), 1 the name starts with
 * the first word, 2 every word starts a word in the name, 3 anywhere.
 */
export function matchScore(name: string, tokens: readonly string[]): number | null {
  if (tokens.length === 0) return null;
  const normalized = normalizeForMatch(name);
  for (const token of tokens) {
    if (!normalized.includes(token)) return null;
  }
  const whole = tokens.join(" ");
  const dot = normalized.lastIndexOf(".");
  const stem = dot > 0 ? normalized.slice(0, dot) : normalized;
  if (normalized === whole || stem === whole) return 0;
  if (normalized.startsWith(tokens[0])) return 1;
  if (tokens.every((token) => startsAtWordBoundary(normalized, token))) return 2;
  return 3;
}

// ── Concurrency gate ─────────────────────────────────────────────────────

export interface SearchGate {
  readonly active: number;
  /** A release function, or null when the gate is full. */
  tryAcquire(): (() => void) | null;
}

export function createSearchGate(max: number = SEARCH_LIMITS.maxConcurrentSearches): SearchGate {
  let active = 0;
  return {
    get active() {
      return active;
    },
    tryAcquire() {
      if (active >= max) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
  };
}

/** The server-wide gate the search route uses. */
export const searchGate = createSearchGate();

// ── Disk calls ───────────────────────────────────────────────────────────

/**
 * A disk call's outcome. `stopped` when the caller stopped waiting (its
 * deadline passed or the request went away) before the disk answered;
 * `ranMs` is how long the call had been running then, or null when it was
 * still waiting for a slot and never started.
 */
export type DiskResult<T> =
  | { ok: true; value: T }
  | { ok: false; stopped: false }
  | { ok: false; stopped: true; ranMs: number | null };

export interface DiskLimiter {
  /** Calls holding a slot, including ones their caller stopped waiting for. */
  readonly running: number;
  /** Every slot has been held for `stallAfterMs` or longer: a drive isn't answering. */
  readonly stalled: boolean;
  /**
   * Runs `task` once a slot is free and answers as soon as it settles or
   * `stop` fires, whichever is first. A task stopped while waiting never
   * starts; one stopped while running keeps its slot until the disk answers,
   * because Node can't cancel a file-system call already on its thread.
   */
  run<T>(task: () => Promise<T>, stop: AbortSignal): Promise<DiskResult<T>>;
}

export function createDiskLimiter(
  slots: number = SEARCH_LIMITS.diskSlots,
  options: { stallAfterMs?: number; now?: () => number } = {},
): DiskLimiter {
  const stallAfterMs = options.stallAfterMs ?? SEARCH_LIMITS.diskStallMs;
  const now = options.now ?? (() => Date.now());
  /** Start times of the calls holding a slot. */
  const runningSince = new Set<{ at: number }>();
  const waiting: Array<() => void> = [];

  const pump = () => {
    while (runningSince.size < slots && waiting.length > 0) waiting.shift()!();
  };

  return {
    get running() {
      return runningSince.size;
    },
    get stalled() {
      if (runningSince.size < slots) return false;
      const at = now();
      for (const call of runningSince) {
        if (at - call.at < stallAfterMs) return false;
      }
      return true;
    },
    run<T>(task: () => Promise<T>, stop: AbortSignal): Promise<DiskResult<T>> {
      if (stop.aborted) return Promise.resolve({ ok: false, stopped: true, ranMs: null });
      return new Promise((resolve) => {
        let call: { at: number } | null = null;
        let settled = false;
        const finish = (result: DiskResult<T>) => {
          if (settled) return;
          settled = true;
          stop.removeEventListener("abort", onStop);
          resolve(result);
        };
        const start = () => {
          const running = { at: now() };
          call = running;
          runningSince.add(running);
          // The slot frees before the caller hears back, so a caller that
          // awaits the answer sees it free.
          const settle = (result: DiskResult<T>) => {
            runningSince.delete(running);
            pump();
            finish(result);
          };
          let pending: Promise<T>;
          try {
            pending = task();
          } catch {
            pending = Promise.reject(new Error("disk call failed"));
          }
          pending.then(
            (value) => settle({ ok: true, value }),
            () => settle({ ok: false, stopped: false }),
          );
        };
        function onStop() {
          if (!call) {
            const index = waiting.indexOf(start);
            if (index >= 0) waiting.splice(index, 1);
          }
          finish({ ok: false, stopped: true, ranMs: call ? now() - call.at : null });
        }
        stop.addEventListener("abort", onStop, { once: true });
        waiting.push(start);
        pump();
      });
    },
  };
}

/** The server-wide disk limiter the search route uses. */
export const searchDisk = createDiskLimiter();

// ── Walk ─────────────────────────────────────────────────────────────────

interface Folder {
  path: string;
  canonical: string;
  depth: number;
}

interface Match {
  name: string;
  path: string;
  depth: number;
  score: number;
  /** Null for a symlink: the stat that follows it decides. */
  isDirectory: boolean | null;
}

function compareMatches(a: Match, b: Match): number {
  if (a.score !== b.score) return a.score - b.score;
  if (a.depth !== b.depth) return a.depth - b.depth;
  const aDir = a.isDirectory === true;
  const bDir = b.isDirectory === true;
  if (aDir !== bDir) return aDir ? -1 : 1;
  return a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
}

async function forEachLimited<T>(items: readonly T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}

export async function searchFiles(options: FileSearchOptions, deps: FileSearchDeps): Promise<SearchOutcome> {
  const limits: SearchLimits = { ...SEARCH_LIMITS, ...options.limits };
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? limits.defaultResults), limits.maxResults));
  const tokens = queryTokens(options.query);
  const showHidden = options.showHidden === true;
  const signal = options.signal;
  const disk = deps.disk ?? createDiskLimiter(Number.POSITIVE_INFINITY, { now: deps.now });
  const started = deps.now();

  const matches: Match[] = [];
  let skipped = 0;
  let scanned = 0;
  let aborted = false;
  let stoppedBy: "time" | "entries" | null = null;
  let depthLimited = false;

  if (tokens.length === 0) {
    return { items: [], truncated: null, skipped, aborted: false, scanned };
  }
  if (signal?.aborted) {
    return { items: [], truncated: null, skipped, aborted: true, scanned };
  }

  // Disk calls are waited for only while their phase runs: the walk until its
  // time budget, the stats until theirs, both until the request goes away.
  const walkPhase = new AbortController();
  const statPhase = new AbortController();
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  // Cleared when the search returns, so they never outlive it.
  const after = (ms: number, run: () => void) => {
    timers.push(setTimeout(run, Math.max(0, ms)));
  };
  const onAbort = () => {
    aborted = true;
    walkPhase.abort();
    statPhase.abort();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const shouldStop = (): boolean => {
    if (aborted || stoppedBy) return true;
    if (signal?.aborted) {
      onAbort();
      return true;
    }
    if (deps.now() - started >= limits.timeBudgetMs) {
      stoppedBy = "time";
      walkPhase.abort();
      return true;
    }
    return false;
  };

  const readFolder = async (folder: Folder, next: Folder[]) => {
    if (shouldStop()) return;
    const read = await disk.run(() => deps.readdir(folder.path), walkPhase.signal);
    if (!read.ok) {
      // Unreadable, or the disk still hadn't answered when the walk stopped.
      if (!read.stopped || (read.ranMs !== null && read.ranMs >= limits.slowFolderMs)) skipped += 1;
      return;
    }
    if (shouldStop()) return;
    const entries = read.value;
    try {
      for (const entry of entries) {
        if (scanned >= limits.maxEntries) {
          stoppedBy ??= "entries";
          return;
        }
        scanned += 1;
        const name = entry.name;
        if (!showHidden && name.startsWith(".")) continue;
        const path = join(folder.path, name);
        const canonical = join(folder.canonical, name);

        if (entry.isSymbolicLink()) {
          // Never walked into (no loops, no escapes). A match is kept only
          // when the link resolves inside an allowed location.
          const score = matchScore(name, tokens);
          if (score !== null && deps.guard.isAllowed(canonical)) {
            matches.push({ name, path, depth: folder.depth + 1, score, isDirectory: null });
          }
          continue;
        }

        if (!deps.guard.isCanonicalAllowed(canonical)) continue;
        const isDirectory = entry.isDirectory();
        const score = matchScore(name, tokens);
        if (score !== null) matches.push({ name, path, depth: folder.depth + 1, score, isDirectory });
        if (isDirectory && !SEARCH_SKIP_DIRS.has(name)) {
          if (folder.depth + 1 < limits.maxDepth) {
            next.push({ path, canonical, depth: folder.depth + 1 });
          } else {
            depthLimited = true;
          }
        }
      }
    } catch {
      // A guard that couldn't decide: leave this folder out rather than guess.
      skipped += 1;
    }
  };

  try {
    after(limits.timeBudgetMs - (deps.now() - started), () => {
      if (aborted || walkPhase.signal.aborted) return;
      stoppedBy ??= "time";
      walkPhase.abort();
    });

    let level: Folder[] = options.starts.map((start) => ({ path: start.path, canonical: start.canonical, depth: 0 }));
    while (level.length > 0 && !shouldStop()) {
      const next: Folder[] = [];
      await forEachLimited(level, limits.concurrency, (folder) => readFolder(folder, next));
      level = next;
    }

    if (aborted) return { items: [], truncated: null, skipped, aborted, scanned };

    matches.sort(compareMatches);
    const kept = matches.slice(0, limit);
    const items: SearchHit[] = new Array(kept.length);

    // Only the matches that are returned are stat'ed, within their own budget:
    // a result whose stat didn't answer in time comes back without size and date.
    after(limits.statBudgetMs, () => statPhase.abort());
    await forEachLimited(kept.map((match, index) => ({ match, index })), limits.concurrency, async ({ match, index }) => {
      const info = await disk.run(() => deps.stat(match.path), statPhase.signal);
      items[index] = info.ok
        ? {
            name: match.name,
            path: match.path,
            isDirectory: match.isDirectory ?? info.value.isDirectory(),
            size: info.value.size,
            modified: info.value.mtime.toISOString(),
          }
        : { name: match.name, path: match.path, isDirectory: match.isDirectory === true, size: 0, modified: null };
    });
    if (aborted) return { items: [], truncated: null, skipped, aborted, scanned };

    // Symlinks to folders sort as folders once their stat is known.
    if (kept.some((match) => match.isDirectory === null)) {
      const order = new Map(items.map((item, index) => [item, kept[index]]));
      items.sort((a, b) => compareMatches(
        { ...order.get(a)!, isDirectory: a.isDirectory },
        { ...order.get(b)!, isDirectory: b.isDirectory },
      ));
    }

    const truncated: SearchTruncation | null = stoppedBy
      ?? (matches.length > limit ? "results" : depthLimited ? "depth" : null);
    return { items, truncated, skipped, aborted, scanned };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
