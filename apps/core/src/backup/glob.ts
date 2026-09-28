/**
 * Exclude patterns for app backups (gitignore-like subset).
 *
 *   *        any characters except "/"
 *   ?        one character except "/"
 *   [a-z]    character class ("[!x]" negates)
 *   **       any number of path segments
 *   /foo     anchored at the root being matched
 *   foo/     directories only (and therefore everything under them)
 *   foo      no slash → matches that name at any depth
 *
 * Patterns are matched against a path relative to the volume root AND,
 * when the file lives under the app's base directory, relative to that
 * directory — so Umbrel-style `backupIgnore` entries such as
 * "data/cache/*" (relative to APP_DATA_DIR) work unchanged.
 */

interface CompiledPattern {
  source: string;
  re: RegExp;
  dirOnly: boolean;
}

function escapeRegExp(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

export function globToRegExp(pattern: string): { re: RegExp; dirOnly: boolean } | null {
  let p = pattern.trim();
  if (!p || p.startsWith("#") || p.startsWith("!")) return null;
  p = p.replace(/^\.\//, "");
  let dirOnly = false;
  if (p.endsWith("/")) {
    dirOnly = true;
    p = p.replace(/\/+$/, "");
  }
  let anchored = false;
  if (p.startsWith("/")) {
    anchored = true;
    p = p.replace(/^\/+/, "");
  }
  if (!p) return null;
  if (!anchored && !p.includes("/")) p = `**/${p}`;

  let out = "";
  let i = 0;
  while (i < p.length) {
    const ch = p[i];
    if (ch === "*") {
      if (p[i + 1] === "*") {
        const atStart = i === 0 || p[i - 1] === "/";
        const followedBySlash = p[i + 2] === "/";
        const atEnd = i + 2 === p.length;
        if (atStart && followedBySlash) {
          out += "(?:.*/)?";
          i += 3;
          continue;
        }
        if (atStart && atEnd) {
          out += ".*";
          i += 2;
          continue;
        }
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i++;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    if (ch === "[") {
      const close = p.indexOf("]", i + 2);
      if (close !== -1) {
        let body = p.slice(i + 1, close);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        body = body.replace(/\\/g, "\\\\");
        out += `[${body}]`;
        i = close + 1;
        continue;
      }
    }
    out += escapeRegExp(ch);
    i++;
  }
  try {
    return { re: new RegExp(`^${out}$`), dirOnly };
  } catch {
    return null;
  }
}

export interface ExcludeMatcher {
  (relPath: string, isDir: boolean, appRelPath?: string | null): boolean;
  patterns: string[];
}

/** Compile a list of patterns into a matcher. Invalid patterns are ignored. */
export function compileExcludePatterns(patterns: string[]): ExcludeMatcher {
  const compiled: CompiledPattern[] = [];
  for (const source of patterns) {
    const c = globToRegExp(source);
    if (c) compiled.push({ source, ...c });
  }
  const matcher = ((relPath: string, isDir: boolean, appRelPath?: string | null) => {
    if (compiled.length === 0) return false;
    for (const c of compiled) {
      if (c.dirOnly && !isDir) continue;
      if (c.re.test(relPath)) return true;
      if (appRelPath && c.re.test(appRelPath)) return true;
    }
    return false;
  }) as ExcludeMatcher;
  matcher.patterns = compiled.map((c) => c.source);
  return matcher;
}
