import { tool } from "ai";
import { z } from "zod";
import { readdir, stat, readFile, unlink, mkdir, rename, rm } from "node:fs/promises";
import { join, resolve, basename, dirname, extname } from "node:path";
import { existsSync } from "node:fs";
import { writeAuditEntry } from "../../db/audit.js";
import {
  TALOME_HOME,
  getAllowedRoots,
  isAllowed,
  sanitizePath,
} from "../../utils/filesystem.js";

function assertAllowed(absPath: string): void {
  if (!isAllowed(absPath)) {
    throw new Error(
      `Access denied: "${absPath}" is outside allowed directories. Allowed roots: ${getAllowedRoots().join(", ")}`,
    );
  }
}

// ── browse_files ──────────────────────────────────────────────────────────────

export const browseFilesTool = tool({
  description: `Browse files and directories on the user's drives. Returns directory listings scoped to allowed roots (Talome home + enabled external drives).

When called without a path, returns the list of allowed root directories so the user can choose where to browse.

Use this to help users find files, explore directory structures, or check what's on their drives.`,
  inputSchema: z.object({
    path: z
      .string()
      .optional()
      .describe("Absolute path to list. Omit to see available root directories."),
    showHidden: z
      .boolean()
      .default(false)
      .describe("Include hidden files (starting with .)"),
    recursive: z
      .boolean()
      .default(false)
      .describe("List recursively (max 2 levels deep, max 200 entries)"),
  }),
  execute: async ({ path, showHidden, recursive }) => {
    try {
      // No path → return available roots
      if (!path) {
        const roots = getAllowedRoots();
        const rootInfo = await Promise.all(
          roots.map(async (root) => {
            try {
              const s = await stat(root);
              return { path: root, label: basename(root), exists: true, isDirectory: true, modified: s.mtime.toISOString() };
            } catch {
              return { path: root, label: basename(root), exists: false, isDirectory: true };
            }
          }),
        );
        return { roots: rootInfo, count: rootInfo.length, hint: "Call browse_files with a path to explore a root." };
      }

      const abs = resolve(path);
      assertAllowed(abs);

      const s = await stat(abs);
      if (!s.isDirectory()) {
        return { error: `"${path}" is not a directory. Use read_user_file to read file contents.` };
      }

      const MAX_ENTRIES = 200;
      const MAX_DEPTH = 2;

      async function listDir(dir: string, depth: number): Promise<Array<{ name: string; path: string; isDirectory: boolean; size: number; modified: string }>> {
        const entries = await readdir(dir, { withFileTypes: true });
        const results: Array<{ name: string; path: string; isDirectory: boolean; size: number; modified: string }> = [];

        for (const entry of entries) {
          if (results.length >= MAX_ENTRIES) break;
          if (!showHidden && entry.name.startsWith(".")) continue;

          const fullPath = join(dir, entry.name);
          try {
            const s = await stat(fullPath);
            results.push({
              name: entry.name,
              path: fullPath,
              isDirectory: entry.isDirectory(),
              size: s.size,
              modified: s.mtime.toISOString(),
            });

            if (recursive && entry.isDirectory() && depth < MAX_DEPTH && results.length < MAX_ENTRIES) {
              const children = await listDir(fullPath, depth + 1);
              results.push(...children.slice(0, MAX_ENTRIES - results.length));
            }
          } catch { /* skip inaccessible entries */ }
        }
        return results;
      }

      const items = await listDir(abs, 0);
      // Sort: directories first, then alphabetically
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const parent = dirname(abs);
      const hasParent = isAllowed(parent) && parent !== abs;

      return {
        path: abs,
        parent: hasParent ? parent : null,
        items,
        count: items.length,
        truncated: items.length >= MAX_ENTRIES,
      };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── read_user_file ────────────────────────────────────────────────────────────

export const readUserFileTool = tool({
  description: `Read a file from the user's drives. Returns the file contents as text. Scoped to allowed roots (Talome home + enabled external drives).

For binary files (images, videos, etc.), returns metadata instead of contents. Max 5MB for text files.`,
  inputSchema: z.object({
    path: z.string().describe("Absolute path to the file to read"),
    maxLines: z.number().default(500).describe("Maximum number of lines to return (default 500)"),
    offset: z.number().default(0).describe("Line offset to start reading from (0-based)"),
  }),
  execute: async ({ path, maxLines, offset }) => {
    try {
      const abs = resolve(path);
      assertAllowed(abs);

      const s = await stat(abs);
      if (s.isDirectory()) {
        return { error: `"${path}" is a directory. Use browse_files to list directory contents.` };
      }

      const BINARY_EXTENSIONS = new Set([
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
        ".mp4", ".mkv", ".avi", ".mov", ".webm", ".flv",
        ".mp3", ".flac", ".ogg", ".wav", ".aac", ".m4a", ".m4b",
        ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
        ".pdf", ".doc", ".docx", ".xls", ".xlsx",
        ".exe", ".dll", ".so", ".dylib", ".bin",
        ".sqlite", ".db", ".sqlite3",
      ]);

      const ext = extname(abs).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) {
        return {
          path: abs,
          binary: true,
          extension: ext,
          sizeBytes: s.size,
          modified: s.mtime.toISOString(),
          hint: "This is a binary file. Contents cannot be displayed as text.",
        };
      }

      const MAX_SIZE = 5 * 1024 * 1024; // 5MB
      if (s.size > MAX_SIZE) {
        return {
          error: `File is too large (${(s.size / 1024 / 1024).toFixed(1)}MB). Maximum is 5MB.`,
          sizeBytes: s.size,
        };
      }

      const content = await readFile(abs, "utf-8");
      const lines = content.split("\n");
      const sliced = lines.slice(offset, offset + maxLines);
      const numbered = sliced
        .map((line, i) => `${String(offset + i + 1).padStart(4)}| ${line}`)
        .join("\n");

      return {
        path: abs,
        totalLines: lines.length,
        offset,
        linesReturned: sliced.length,
        content: numbered,
        truncated: offset + maxLines < lines.length,
      };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── delete_file ───────────────────────────────────────────────────────────────

export const deleteFileTool = tool({
  description: `Delete a file or directory from the user's drives. Scoped to allowed roots.

IMPORTANT: This is a destructive operation. Always confirm with the user before deleting. Cannot delete root directories.`,
  inputSchema: z.object({
    path: z.string().describe("Absolute path to the file or directory to delete"),
    recursive: z.boolean().default(false).describe("Required for non-empty directories"),
    confirmed: z.boolean().describe("Must be true — ask user to confirm before calling"),
  }),
  execute: async ({ path, recursive, confirmed }) => {
    if (!confirmed) {
      return { error: "This is a destructive action. Ask the user to confirm, then call again with confirmed: true." };
    }
    try {
      const abs = resolve(path);
      assertAllowed(abs);

      // Prevent deleting root directories
      const roots = getAllowedRoots();
      if (roots.includes(abs)) {
        return { error: "Cannot delete a root directory." };
      }

      const s = await stat(abs);

      if (s.isDirectory()) {
        if (recursive) {
          await rm(abs, { recursive: true, force: true });
        } else {
          // Try rmdir (will fail if not empty)
          const entries = await readdir(abs);
          if (entries.length > 0) {
            return {
              error: `Directory "${path}" is not empty (${entries.length} items). Set recursive=true to delete with contents.`,
            };
          }
          await rm(abs);
        }
      } else {
        await unlink(abs);
      }

      writeAuditEntry("AI: delete_file", "destructive", path);

      return {
        success: true,
        path: abs,
        type: s.isDirectory() ? "directory" : "file",
        message: `Deleted ${s.isDirectory() ? "directory" : "file"}: ${basename(abs)}`,
      };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── rename_file ───────────────────────────────────────────────────────────────

export const renameFileTool = tool({
  description: `Rename or move a file/directory within allowed roots.

Both the source and destination must be within allowed roots. The new name must not contain path separators.`,
  inputSchema: z.object({
    path: z.string().describe("Absolute path to the file or directory to rename"),
    newName: z.string().describe("New file/directory name (not a full path)"),
  }),
  execute: async ({ path, newName }) => {
    try {
      if (newName.includes("/") || newName.includes("\\")) {
        return { error: "newName must be a file name, not a path. No path separators allowed." };
      }

      const abs = resolve(path);
      assertAllowed(abs);

      if (!existsSync(abs)) {
        return { error: `File not found: ${path}` };
      }

      const newPath = join(dirname(abs), newName);
      assertAllowed(newPath);

      if (existsSync(newPath)) {
        return { error: `Target already exists: ${newPath}` };
      }

      await rename(abs, newPath);
      writeAuditEntry("AI: rename_file", "modify", `${path} → ${newName}`);

      return {
        success: true,
        oldPath: abs,
        newPath,
        message: `Renamed "${basename(abs)}" to "${newName}"`,
      };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── create_directory ──────────────────────────────────────────────────────────

export const createDirectoryTool = tool({
  description: `Create a new directory on the user's drives. Creates parent directories as needed. Scoped to allowed roots.`,
  inputSchema: z.object({
    path: z.string().describe("Absolute path for the new directory"),
  }),
  execute: async ({ path }) => {
    try {
      const abs = resolve(path);
      assertAllowed(abs);

      if (existsSync(abs)) {
        const s = await stat(abs);
        if (s.isDirectory()) {
          return { success: true, path: abs, message: "Directory already exists.", alreadyExisted: true };
        }
        return { error: `A file already exists at "${path}".` };
      }

      await mkdir(abs, { recursive: true });
      writeAuditEntry("AI: create_directory", "modify", path);

      return {
        success: true,
        path: abs,
        message: `Created directory: ${abs}`,
        alreadyExisted: false,
      };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── get_file_info ─────────────────────────────────────────────────────────────

export const getFileInfoTool = tool({
  description: `Get detailed metadata about a file or directory: size, type, modification time, permissions. Scoped to allowed roots.`,
  inputSchema: z.object({
    path: z.string().describe("Absolute path to the file or directory"),
  }),
  execute: async ({ path }) => {
    try {
      const abs = resolve(path);
      assertAllowed(abs);

      const s = await stat(abs);
      const ext = extname(abs).toLowerCase();

      const info: Record<string, unknown> = {
        path: abs,
        name: basename(abs),
        isDirectory: s.isDirectory(),
        isFile: s.isFile(),
        isSymlink: s.isSymbolicLink(),
        sizeBytes: s.size,
        sizeHuman: formatSize(s.size),
        modified: s.mtime.toISOString(),
        created: s.birthtime.toISOString(),
        accessed: s.atime.toISOString(),
        permissions: (s.mode & 0o777).toString(8),
      };

      if (s.isFile()) {
        info.extension = ext || "(none)";
      }

      if (s.isDirectory()) {
        try {
          const entries = await readdir(abs);
          info.childCount = entries.length;
        } catch {
          info.childCount = null;
        }
      }

      return info;
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
});

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
