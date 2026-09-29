/**
 * Paths that hold secrets or Talome's own state.
 *
 * Tools that read files for a caller are reachable at read tier — read-only
 * MCP tokens, locked mode, automations — so they must never hand out
 * credentials: .env files (TALOME_SECRET signs sessions and encrypts every
 * stored credential), SQLite databases and their journals, key files,
 * credential dotfiles, or the directory holding Talome's database.
 * Names are compared case-insensitively (macOS volumes usually are).
 */

import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Folder names whose contents are credentials or VCS internals. */
const CREDENTIAL_DIR_NAMES = new Set([".ssh", ".gnupg", ".aws", ".kube", ".docker", ".git", "secrets", ".secrets"]);

/** Exact file names that hold credentials. */
const SECRET_FILE_NAMES = new Set([
  ".npmrc", ".netrc", ".git-credentials", ".pgpass", ".htpasswd", ".pypirc", ".dockercfg",
  "credentials", "credentials.json", "secrets.json", "secrets.yaml", "secrets.yml", "auth.json",
]);

const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env($|\.)/, // .env, .env.local, .env.production …
  /\.env$/, // talome.env, prod.env
  /\.(db|db3|sqlite|sqlite3)(-wal|-shm|-journal)?$/, // databases and their journals
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|age)$/, // keys and key stores
  /^id_(rsa|dsa|ecdsa|ed25519)/, // SSH private keys
  /\.secrets?$/, // talome.secret …
];

/** Templates that document variables without values stay readable. */
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);

/**
 * Why `path` names a secret — a credential folder on the way, or a secret
 * file name at the end — or null. Works for absolute and relative paths.
 */
export function secretPathReason(path: string, extraDirNames: ReadonlySet<string> = new Set()): string | null {
  const segments = path.split(/[\\/]+/).filter((s) => s && s !== ".");
  for (let i = 0; i < segments.length; i++) {
    const name = segments[i].toLowerCase();
    if (CREDENTIAL_DIR_NAMES.has(name) || extraDirNames.has(name)) {
      return `"${segments[i]}" holds runtime data or credentials`;
    }
    if (i < segments.length - 1) continue;
    if (ENV_TEMPLATES.has(name)) return null;
    if (SECRET_FILE_NAMES.has(name) || SECRET_FILE_PATTERNS.some((re) => re.test(name))) {
      return `"${segments[i]}" may hold secrets`;
    }
  }
  return null;
}

/** True when `target` is `root` or inside it (both absolute). */
export function isSameOrInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Folders that hold Talome's own state: the database directory (DB, WAL, talome.secret). */
export function talomeStateDirs(): string[] {
  const dbPath = process.env.DATABASE_PATH || join(process.cwd(), "data", "talome.db");
  return [...new Set([dirname(resolve(dbPath)), join(homedir(), ".talome", "data")])];
}

/**
 * Why an absolute path may not be read for a caller, or null: a secret by
 * name, or anything inside Talome's state directories.
 */
export function protectedFileReason(absPath: string): string | null {
  const byName = secretPathReason(absPath);
  if (byName) return byName;
  const folded = absPath.toLowerCase();
  for (const dir of talomeStateDirs()) {
    if (isSameOrInside(dir.toLowerCase(), folded)) return "it is inside Talome's data directory";
  }
  return null;
}
