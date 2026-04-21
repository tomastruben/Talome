/**
 * Parse the likely container format from a release title string.
 *
 * Release titles from indexers follow Scene naming conventions, embedding
 * format hints like `.mkv`, `.mp4`, `x264`, `REMUX`, etc.
 */
export function parseContainerFormat(
  title: string
): "mp4" | "mkv" | "avi" | null {
  const t = title.toLowerCase();

  // Explicit extension or token matches (highest confidence)
  if (/\.mp4\b/.test(t) || /\bmp4\b/.test(t)) return "mp4";
  if (/\.m4v\b/.test(t) || /\bm4v\b/.test(t)) return "mp4";
  if (/\.mkv\b/.test(t) || /\bmkv\b/.test(t)) return "mkv";
  if (/\.avi\b/.test(t) || /\bavi\b/.test(t)) return "avi";

  // Inference from encoding context — REMUX is almost always MKV
  if (/\bremux\b/.test(t)) return "mkv";

  return null;
}
