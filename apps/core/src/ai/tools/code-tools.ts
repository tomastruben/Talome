import { tool } from "ai";
import { z } from "zod";
import { readFile, readdir, stat, copyFile, realpath } from "node:fs/promises";
import { resolve, relative, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAuditEntry } from "../../db/audit.js";
import { redactValue } from "../../approval/redact.js";
import { isSameOrInside, secretPathReason } from "../../utils/secret-paths.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT =
  process.env.TALOME_ROOT || resolve(THIS_DIR, "..", "..", "..", "..", "..");

const BACKUP_DIR = join(
  process.env.HOME || "/tmp",
  ".talome",
  "backups",
);

// ── Secret paths ─────────────────────────────────────────────────────────────
// read_file and list_directory are read tier: read-only MCP tokens, locked
// mode and automations reach them. The workspace also holds runtime state that
// is not source code — apps/core/.env (TALOME_SECRET, which signs sessions and
// encrypts every stored credential), the SQLite database under data/, keys —
// so those paths are refused and never listed (utils/secret-paths.ts).

/** Workspace folders that hold runtime state rather than source code. */
const RUNTIME_DIR_NAMES: ReadonlySet<string> = new Set(["data", ".talome"]);

/** Why `relPath` (relative to the workspace) may not be read or listed, or null when it may. */
export function deniedCodePathReason(relPath: string): string | null {
  return secretPathReason(relPath, RUNTIME_DIR_NAMES);
}

const isInside = isSameOrInside;

function safePath(userPath: string): string {
  const resolved = resolve(REPO_ROOT, userPath);
  if (!isInside(REPO_ROOT, resolved)) {
    throw new Error(
      `Path "${userPath}" resolves outside the Talome workspace. Access denied.`,
    );
  }
  const reason = deniedCodePathReason(relative(REPO_ROOT, resolved));
  if (reason) throw new Error(`Access denied: ${reason}. Only source files can be read.`);
  return resolved;
}

/**
 * safePath plus a check of the file's real location: a symlink inside the
 * workspace must not lead out of it, or onto a denied path under another name.
 */
async function safeRealPath(userPath: string): Promise<string> {
  const abs = safePath(userPath);
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    return abs; // does not exist — the caller's read reports it
  }
  const root = await realpath(REPO_ROOT).catch(() => REPO_ROOT);
  if (!isInside(root, real)) {
    throw new Error(`Path "${userPath}" resolves outside the Talome workspace. Access denied.`);
  }
  const reason = deniedCodePathReason(relative(root, real));
  if (reason) throw new Error(`Access denied: ${reason}. Only source files can be read.`);
  return abs;
}

// ── read_file ────────────────────────────────────────────────────────────────

export const readFileTool = tool({
  description:
    "Read a source file from the Talome codebase. Returns contents with line numbers. Path is relative to the repo root. Secret and runtime files (.env*, databases, data/, keys, .git) are refused.",
  inputSchema: z.object({
    path: z.string().describe("File path relative to repo root (e.g. apps/core/src/ai/agent.ts)"),
  }),
  execute: async ({ path: userPath }) => {
    try {
      const abs = await safeRealPath(userPath);
      // Defense in depth: a known secret value copied into a source file is masked.
      const content = redactValue(await readFile(abs, "utf-8")) as string;
      const lines = content.split("\n");
      const numbered = lines
        .map((line, i) => `${String(i + 1).padStart(4)}| ${line}`)
        .join("\n");
      return { path: userPath, lines: lines.length, content: numbered };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
});

// ── list_directory ───────────────────────────────────────────────────────────

export const listDirectoryTool = tool({
  description:
    "List files and directories in the Talome codebase. Path is relative to the repo root. Ignores node_modules, .git, and dist by default.",
  inputSchema: z.object({
    path: z.string().default(".").describe("Directory path relative to repo root"),
    recursive: z.boolean().default(false).describe("List recursively (max 3 levels)"),
    maxDepth: z.number().default(3).describe("Max depth for recursive listing"),
  }),
  execute: async ({ path: userPath, recursive, maxDepth }) => {
    const IGNORE = new Set(["node_modules", ".git", "dist", ".next", ".turbo", ".cache"]);

    async function listDir(dir: string, depth: number): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const results: string[] = [];
      for (const entry of entries) {
        if (IGNORE.has(entry.name)) continue;
        const rel = relative(REPO_ROOT, join(dir, entry.name));
        if (deniedCodePathReason(rel)) continue;
        if (entry.isDirectory()) {
          results.push(`${rel}/`);
          if (recursive && depth < maxDepth) {
            results.push(...(await listDir(join(dir, entry.name), depth + 1)));
          }
        } else {
          results.push(rel);
        }
      }
      return results.sort();
    }

    try {
      const abs = await safeRealPath(userPath);
      const s = await stat(abs);
      if (!s.isDirectory()) {
        return { error: `${userPath} is not a directory` };
      }
      const entries = await listDir(abs, 0);
      return { path: userPath, entries, count: entries.length };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
});

// ── rollback_file ────────────────────────────────────────────────────────────

export const rollbackFileTool = tool({
  description:
    "Restore a file to its most recent backup. Use this to undo a write_file or edit_file operation.",
  inputSchema: z.object({
    path: z.string().describe("File path relative to repo root to restore"),
  }),
  execute: async ({ path: userPath }) => {
    try {
      // The real path too: restoring through a symlink must not write outside the workspace.
      const abs = await safeRealPath(userPath);
      const prefix = relative(REPO_ROOT, abs).replace(/\//g, "__");

      let files: string[];
      try {
        files = await readdir(BACKUP_DIR);
      } catch {
        return { error: "No backups directory found." };
      }

      const matching = files
        .filter((f) => f.startsWith(prefix + ".") && f.endsWith(".bak"))
        .sort()
        .reverse();

      if (matching.length === 0) {
        return { error: `No backups found for ${userPath}` };
      }

      const latestBackup = join(BACKUP_DIR, matching[0]);
      await copyFile(latestBackup, abs);
      writeAuditEntry("AI: rollback_file", "modify", userPath);
      return {
        path: userPath,
        restoredFrom: matching[0],
        availableBackups: matching.length,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
});
