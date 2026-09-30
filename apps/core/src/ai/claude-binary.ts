import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface ClaudeBinaryLookup {
  /** PATH to search; defaults to process.env.PATH. */
  path?: string;
  /** Home directory for the native installer location; defaults to os.homedir(). */
  home?: string;
  /** Executable probe; defaults to fs.accessSync with X_OK. */
  isExecutable?: (candidate: string) => boolean;
}

const FALLBACK_LOCATIONS = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];

let cached: string | null = null;

function defaultIsExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the `claude` CLI executable for direct spawns from the core.
 *
 * The supervisor is started by launchd (or systemd) with a fixed PATH that
 * omits the native installer's `~/.local/bin`, so a bare "claude" fails with
 * ENOENT from the core even though it works in the user's login shell. PATH is
 * searched first, then the well-known install locations. When nothing is
 * found the bare name is returned so callers keep their existing
 * "not found" handling, and the miss is not cached so a later install is
 * picked up without a restart.
 */
export function resolveClaudeBinary(lookup: ClaudeBinaryLookup = {}): string {
  const usingDefaults = lookup.path === undefined && lookup.home === undefined && lookup.isExecutable === undefined;
  if (usingDefaults && cached) return cached;

  const path = lookup.path ?? process.env.PATH ?? "";
  const home = lookup.home ?? homedir();
  const isExecutable = lookup.isExecutable ?? defaultIsExecutable;

  const candidates = [
    ...path.split(delimiter).filter(Boolean).map((dir) => join(dir, "claude")),
    join(home, ".local", "bin", "claude"),
    ...FALLBACK_LOCATIONS,
  ];

  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      if (usingDefaults) cached = candidate;
      return candidate;
    }
  }
  return "claude";
}
