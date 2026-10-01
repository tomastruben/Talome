/**
 * Pure helpers for the file manager (app/dashboard/files), kept here so they
 * can be tested without rendering the page.
 */
import {
  Database01Icon,
  FileAttachmentIcon,
  FileMusicIcon,
  FileVideoIcon,
  Folder01Icon,
  Image01Icon,
  Settings01Icon,
  SourceCodeCircleIcon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";

/** Text previews (code, markdown, logs…) load at most this much. */
export const TEXT_PREVIEW_LIMIT_BYTES = 5 * 1024 * 1024;

/**
 * A name that doesn't collide with `existing` (case-insensitively, as most
 * disks compare names): "New Folder", then "New Folder 2", "New Folder 3"…
 * "New" used to reuse "New Folder" and silently do nothing the second time.
 */
export function uniqueName(base: string, existing: Iterable<string>): string {
  const taken = new Set<string>();
  for (const name of existing) taken.add(name.toLocaleLowerCase());
  if (!taken.has(base.toLocaleLowerCase())) return base;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/**
 * Whether two folder paths name the same folder as far as the URL goes:
 * ignores trailing slashes and repeated separators ("/a/b/" and "/a//b").
 * The list route returns a normalized path, so the page's requested path
 * must be compared this way, never byte for byte.
 */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
  return norm(a) === norm(b);
}

/**
 * Whether the list data on screen belongs to the folder requested now.
 * SWR's keepPreviousData keeps another key's data on screen while the new key
 * loads; `hasDataForKey` says whether SWR's cache holds data for the current
 * key itself (so it's this folder's, maybe older). Otherwise the server's
 * normalized path must match the requested one.
 */
export function listDataIsFor(
  data: { path?: string } | null | undefined,
  requestedPath: string | null,
  hasDataForKey: boolean,
): boolean {
  if (!data) return false;
  if (hasDataForKey) return true;
  return requestedPath !== null && samePath(data.path, requestedPath);
}

/** The last segment of a path, for copy ("Couldn't open Movies"). */
export function folderName(path: string | null | undefined, fallback = "this folder"): string {
  if (!path) return fallback;
  return path.split("/").filter(Boolean).pop() || fallback;
}

/**
 * Error copy for a folder that failed to load (spec §5.5: what failed, why,
 * and the fix), from the list endpoint's HTTP status.
 */
export function folderErrorCopy(status: number | null, path: string | null): { title: string; description: string } {
  const name = folderName(path);
  switch (status) {
    case 403:
      return {
        title: `Talome can't open ${name}`,
        description: "Talome doesn't have permission to read this folder. Choose another location, or enable its drive for the file manager.",
      };
    case 404:
      return {
        title: `${name} isn't there any more`,
        description: "It may have been moved, renamed or deleted, or its drive was disconnected.",
      };
    case 400:
      return {
        title: `Couldn't open ${name}`,
        description: "This path is a file, not a folder.",
      };
    default:
      return {
        title: `Couldn't open ${name}`,
        description: "Check that the Talome server is reachable, then retry.",
      };
  }
}

/** True for a text preview that is over the Quick Look limit. */
export function isOverTextPreviewLimit(size: number | null | undefined): boolean {
  return typeof size === "number" && size >= TEXT_PREVIEW_LIMIT_BYTES;
}

/**
 * Whether a window-level Quick Look shortcut (arrow keys) should act: not
 * when something inside already handled the key (the video player seeks with
 * the arrows and calls preventDefault), and not while typing in a field.
 */
export function shouldHandleQuickLookKey(event: Pick<KeyboardEvent, "defaultPrevented" | "target">): boolean {
  if (event.defaultPrevented) return false;
  const target = event.target as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!target || typeof target !== "object") return true;
  const tag = typeof target.tagName === "string" ? target.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "textarea" || tag === "select") return false;
  return !target.isContentEditable;
}

// ── File types ───────────────────────────────────────────────────────────

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: string | null;
}

export function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export const CODE_EXTS = new Set(["js", "ts", "tsx", "jsx", "py", "go", "rs", "sh", "bash", "zsh", "sql", "dockerfile"]);
export const CONFIG_EXTS = new Set(["json", "yml", "yaml", "toml", "ini", "conf", "cfg", "env", "xml", "csv"]);
export const TEXT_EXTS = new Set(["txt", "md", "log", "html", "css"]);
export const MEDIA_AUDIO = new Set(["mp3", "flac", "ogg", "wav", "aac", "m4a", "m4b"]);
export const MEDIA_VIDEO = new Set(["mp4", "mkv", "avi", "mov", "webm"]);
export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"]);
export const DB_EXTS = new Set(["db", "sqlite", "sqlite3"]);

export function isTextPreviewable(name: string): boolean {
  const e = ext(name);
  return CODE_EXTS.has(e) || CONFIG_EXTS.has(e) || TEXT_EXTS.has(e) || name.startsWith(".");
}

export function isImagePreviewable(name: string): boolean {
  return IMAGE_EXTS.has(ext(name));
}

export function isPDF(name: string): boolean {
  return ext(name) === "pdf";
}

export function isMarkdownFile(name: string): boolean {
  const e = ext(name);
  return e === "md" || e === "mdx";
}

export function isSvgFile(name: string): boolean {
  return ext(name) === "svg";
}

/** True if the file needs the /api/files/read text fetch. */
export function needsTextFetch(name: string): boolean {
  return isTextPreviewable(name) || isMarkdownFile(name) || isSvgFile(name);
}

export function isAudioPreviewable(name: string): boolean {
  return MEDIA_AUDIO.has(ext(name));
}

export function isVideoPreviewable(name: string): boolean {
  return MEDIA_VIDEO.has(ext(name));
}

export function isMediaPreviewable(name: string): boolean {
  return isAudioPreviewable(name) || isVideoPreviewable(name);
}

/** True if this file type can be previewed (for click handling). */
export function isPreviewable(name: string): boolean {
  return isTextPreviewable(name) || isImagePreviewable(name) || isMediaPreviewable(name) || isPDF(name);
}

/** Type icons are muted: the glyph says the type, colour is not a signal here. */
export function fileIcon(item: Pick<FileItem, "name" | "isDirectory">): { icon: IconSvgElement; color: string } {
  if (item.isDirectory) return { icon: Folder01Icon, color: "text-muted-foreground" };
  const e = ext(item.name);
  const color = "text-dim-foreground";
  if (CODE_EXTS.has(e)) return { icon: SourceCodeCircleIcon, color };
  if (CONFIG_EXTS.has(e)) return { icon: Settings01Icon, color };
  if (IMAGE_EXTS.has(e)) return { icon: Image01Icon, color };
  if (MEDIA_AUDIO.has(e)) return { icon: FileMusicIcon, color };
  if (MEDIA_VIDEO.has(e)) return { icon: FileVideoIcon, color };
  if (DB_EXTS.has(e)) return { icon: Database01Icon, color };
  return { icon: FileAttachmentIcon, color };
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

// ── Search ───────────────────────────────────────────────────────────────
//
// The same matching as the server's name search (core utils/file-search.ts),
// so filtering a folder and searching below it agree on what matches.

/**
 * Names compare in NFC and lower case, so "Café" typed on one keyboard finds
 * "café" saved by macOS in NFD.
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
export function matchScore(name: string, query: string | readonly string[]): number | null {
  const tokens = typeof query === "string" ? queryTokens(query) : query;
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

/** Whether a name has every word of the query. An empty query matches everything. */
export function matchesQuery(name: string, query: string): boolean {
  const tokens = queryTokens(query);
  return tokens.length === 0 || matchScore(name, tokens) !== null;
}

/** The items whose names match, in the order they came (the server's sort). */
export function filterByQuery<T extends { name: string }>(items: readonly T[], query: string): T[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [...items];
  return items.filter((item) => matchScore(item.name, tokens) !== null);
}

/** Lower-cases code point by code point, remembering where each folded unit came from. */
function foldWithMap(value: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let index = 0;
  for (const char of value) {
    const lower = char.toLowerCase();
    for (let k = 0; k < lower.length; k++) map.push(index);
    folded += lower;
    index += char.length;
  }
  map.push(value.length);
  return { folded, map };
}

/**
 * The parts of a name that match the query, as [start, end) ranges into
 * `name.normalize("NFC")` (render that string; it looks the same). Each word
 * marks its first occurrence, preferring the start of a word; overlapping
 * ranges merge.
 */
export function highlightRanges(name: string, query: string): Array<[number, number]> {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const source = name.normalize("NFC");
  const { folded, map } = foldWithMap(source);
  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    let index = -1;
    for (let from = 0; ; ) {
      const hit = folded.indexOf(token, from);
      if (hit < 0) break;
      if (index < 0) index = hit;
      if (hit === 0 || !WORD_CHAR.test(folded[hit - 1])) {
        index = hit;
        break;
      }
      from = hit + 1;
    }
    if (index < 0) continue;
    let end = index + token.length;
    // Never cut through a character that folded to more than one unit.
    while (end < folded.length && map[end] === map[end - 1]) end += 1;
    ranges.push([map[index], end >= folded.length ? source.length : map[end]]);
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

export interface PathSegment {
  name: string;
  path: string;
}

/**
 * A folder's path as people read it, starting at the location it lives in
 * ("Talome Files / Photos / 2025"): built from the location's label, never
 * from the server's host path (for example /Users/<name>/.talome/files), and
 * stable when an external drive's mount path changes. A folder outside every
 * known location shows only its own name.
 */
export function displaySegments(
  path: string | null | undefined,
  roots: ReadonlyArray<{ path: string; label: string }>,
): PathSegment[] {
  if (!path) return [];
  const root = roots
    .filter((candidate) => path === candidate.path || path.startsWith(`${candidate.path.replace(/\/+$/, "")}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!root) {
    return [{ name: path.split("/").filter(Boolean).pop() || "Files", path }];
  }
  const segments: PathSegment[] = [{ name: root.label, path: root.path }];
  let accumulated = root.path.replace(/\/+$/, "");
  for (const part of path.slice(root.path.length).split("/").filter(Boolean)) {
    accumulated += `/${part}`;
    segments.push({ name: part, path: accumulated });
  }
  return segments;
}

/** The folder a path is in ("/a/b/c.txt" → "/a/b"). */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

// ── Search responses and copy ────────────────────────────────────────────

export type SearchTruncation = "results" | "time" | "entries" | "depth";

/** GET /api/files/search */
export interface FileSearchResponse {
  /** The folder searched, or null for every location */
  path: string | null;
  query: string;
  items: FileItem[];
  truncated: SearchTruncation | null;
  /** Folders that couldn't be read */
  skipped: number;
  limits: { results: number; maxDepth: number; timeBudgetMs: number; maxEntries: number };
  elapsedMs: number;
}

/** Search needs this many characters before it asks the server. */
export const SEARCH_MIN_CHARS = 2;

const numberFormat = new Intl.NumberFormat();
const plural = new Intl.PluralRules();

/** "1 item", "12 items", "1,204 results". */
export function countNoun(count: number, one: string, other: string): string {
  return `${numberFormat.format(count)} ${plural.select(count) === "one" ? one : other}`;
}

/** The status bar's count for the view on screen. */
export function filesCountLabel(view:
  | { kind: "folder"; total: number }
  | { kind: "filtered"; shown: number; total: number }
  | { kind: "searching" }
  | { kind: "results"; count: number; truncated: SearchTruncation | null }
  | { kind: "roots" },
): string {
  switch (view.kind) {
    case "folder":
      return countNoun(view.total, "item", "items");
    case "filtered":
      return `${numberFormat.format(view.shown)} of ${countNoun(view.total, "item", "items")}`;
    case "searching":
      return "Searching…";
    case "results":
      return view.truncated === "results"
        ? `First ${countNoun(view.count, "result", "results")}`
        : countNoun(view.count, "result", "results");
    case "roots":
      return "All locations";
  }
}

/**
 * Why a search's results may be incomplete, in one line, from the limits
 * the server reported. Null when nothing was left out.
 */
export function searchTruncationNote(response: Pick<FileSearchResponse, "truncated" | "skipped" | "limits" | "items">): string | null {
  const parts: string[] = [];
  switch (response.truncated) {
    case "results":
      parts.push(`Showing the first ${countNoun(response.items.length, "result", "results")}. Add words to narrow the search.`);
      break;
    case "time": {
      const seconds = Math.round(response.limits.timeBudgetMs / 1000);
      parts.push(`Search stopped after ${countNoun(seconds, "second", "seconds")}, so some folders weren't searched. Search a smaller folder to see everything.`);
      break;
    }
    case "entries":
      parts.push(`Search stopped after checking ${countNoun(response.limits.maxEntries, "item", "items")}. Search a smaller folder to see everything.`);
      break;
    case "depth":
      parts.push(`Folders more than ${numberFormat.format(response.limits.maxDepth)} levels deep weren't searched.`);
      break;
    default:
      break;
  }
  if (response.skipped > 0) {
    parts.push(`${countNoun(response.skipped, "folder", "folders")} couldn't be read.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Error copy for a failed search (what failed, why, the fix), from its HTTP
 * status. A 404 names a missing folder only when the server said so (code
 * ENOENT); any other 404 means this server has no search route yet. A 503
 * with the server's own message is a drive that isn't answering; without one
 * it came from something in between, so it reads as the server unreachable.
 */
export function searchErrorCopy(
  status: number | null,
  serverMessage: string | null,
  location: string,
  code: string | null = "ENOENT",
): { title: string; description: string } {
  if (status === 404 && code !== "ENOENT") {
    return {
      title: "Search isn't available on this server",
      description: "This Talome server is older than the dashboard. Update Talome, then retry.",
    };
  }
  if (status === 503 && serverMessage) {
    return { title: `Couldn't search ${location}`, description: serverMessage };
  }
  switch (status) {
    case 403:
      return {
        title: `Talome can't search ${location}`,
        description: "Talome doesn't have permission to read this folder. Choose another location, or enable its drive for the file manager.",
      };
    case 404:
      return {
        title: `${location} isn't there any more`,
        description: "It may have been moved, renamed or deleted, or its drive was disconnected.",
      };
    case 429:
      return {
        title: "Too many searches at once",
        description: "Other searches are still running on this server. Retry in a moment.",
      };
    case 400:
      return {
        title: "Couldn't search for that",
        description: serverMessage ?? "Change the search and try again.",
      };
    default:
      return {
        title: `Couldn't search ${location}`,
        description: "Check that the Talome server is reachable, then retry.",
      };
  }
}
