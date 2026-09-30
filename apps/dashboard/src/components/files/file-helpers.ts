/**
 * Pure helpers for the file manager (app/dashboard/files), kept here so they
 * can be tested without rendering the page.
 */

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
