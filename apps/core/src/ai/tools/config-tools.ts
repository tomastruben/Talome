import { tool } from "ai";
import { z } from "zod";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { resolve, join, dirname, isAbsolute, extname } from "node:path";
import { writeAuditEntry } from "../../db/audit.js";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";

const BACKUP_DIR = join(process.env.HOME || "/tmp", ".talome", "backups", "config-files");

/**
 * Reject path traversal attempts. For config file access we allow any absolute
 * path (the user's bind-mounted volumes can live anywhere on the host), but we
 * never allow ".." components.
 */
function safeConfigPath(filePath: string): string {
  if (filePath.includes("..")) {
    throw new Error(`Path "${filePath}" contains path traversal. Access denied.`);
  }
  return resolve(filePath);
}

/**
 * Given an installed app ID, return all bind-mount host paths declared in its
 * docker-compose.yml. Used to validate that the requested file lives inside one
 * of the app's mounted volumes.
 */
function getAppVolumeMounts(appId: string): string[] {
  try {
    const row = db
      .select()
      .from(schema.installedApps)
      .where(eq(schema.installedApps.appId, appId))
      .get();
    if (!row?.overrideComposePath) return [];

    const composePath = row.overrideComposePath;
    if (!existsSync(composePath)) return [];

    const content = readFileSync(composePath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    const services = parsed?.services as Record<string, Record<string, unknown>> | undefined;
    if (!services) return [];

    const mounts: string[] = [];
    for (const service of Object.values(services)) {
      const volumes = service.volumes as string[] | undefined;
      if (!Array.isArray(volumes)) continue;
      for (const v of volumes) {
        if (typeof v !== "string") continue;
        const [hostPath] = v.split(":");
        if (hostPath && isAbsolute(hostPath)) {
          mounts.push(hostPath);
        }
      }
    }
    return mounts;
  } catch {
    return [];
  }
}

/**
 * Check that the resolved file path is inside one of the app's volume mounts.
 * Falls back to allowing the path if no mounts are configured (edge case for
 * new installs not yet in the DB).
 */
function assertFileInVolume(filePath: string, mounts: string[]): void {
  if (mounts.length === 0) return; // no mounts to validate against — allow
  const resolved = resolve(filePath);
  const allowed = mounts.some((m) => resolved.startsWith(resolve(m)));
  if (!allowed) {
    throw new Error(
      `File "${filePath}" is not inside any of this app's volume mounts. Allowed roots: ${mounts.join(", ")}`
    );
  }
}

async function backupConfigFile(filePath: string, appId: string): Promise<void> {
  await mkdir(BACKUP_DIR, { recursive: true });
  const content = await readFile(filePath, "utf-8");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = filePath.replace(/\//g, "_");
  await writeFile(join(BACKUP_DIR, `${appId}${safeName}-${ts}.bak`), content, "utf-8");
}

// ── read_app_config_file ──────────────────────────────────────────────────────

export const readAppConfigFileTool = tool({
  description:
    "Read a config file from an installed app's bind-mounted volume. Use this to inspect configuration files like Home Assistant's configuration.yaml, qBittorrent's settings.conf, Pi-hole's custom.list, etc. The filePath must be an absolute host path inside one of the app's volume mounts.",
  inputSchema: z.object({
    appId: z.string().describe("The app ID of the installed app (e.g. 'homeassistant', 'qbittorrent')"),
    filePath: z
      .string()
      .describe("Absolute path to the config file on the host (e.g. /opt/homeassistant/configuration.yaml)"),
  }),
  execute: async ({ appId, filePath }) => {
    try {
      const safe = safeConfigPath(filePath);
      const mounts = getAppVolumeMounts(appId);
      assertFileInVolume(safe, mounts);

      if (!existsSync(safe)) {
        return {
          success: false,
          error: `File not found: ${safe}`,
          hint: `Check that the app is installed and the path is correct. Volume mounts for ${appId}: ${mounts.join(", ") || "none found"}`,
        };
      }

      const content = await readFile(safe, "utf-8");
      return { success: true, appId, filePath: safe, content, size: content.length };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        hint: `Make sure the path is inside one of ${appId}'s volume mounts.`,
      };
    }
  },
});

// ── write_app_config_file ─────────────────────────────────────────────────────

export const writeAppConfigFileTool = tool({
  description:
    "Write a config file to an installed app's bind-mounted volume, backing up the original first. Use this to modify configuration files that the app reads on startup (e.g. Home Assistant configuration.yaml, Pi-hole custom DNS lists). Always read the file first with read_app_config_file before writing.",
  inputSchema: z.object({
    appId: z.string().describe("The app ID of the installed app"),
    filePath: z.string().describe("Absolute path to the config file on the host"),
    content: z.string().describe("The new file content to write"),
  }),
  execute: async ({ appId, filePath, content }) => {
    try {
      const safe = safeConfigPath(filePath);
      const mounts = getAppVolumeMounts(appId);
      assertFileInVolume(safe, mounts);

      // Backup the existing file if it exists
      if (existsSync(safe)) {
        await backupConfigFile(safe, appId);
      }

      // Ensure parent directory exists
      await mkdir(dirname(safe), { recursive: true });
      await writeFile(safe, content, "utf-8");

      writeAuditEntry(`AI: write_app_config_file(${appId})`, "modify", filePath);

      return {
        success: true,
        appId,
        filePath: safe,
        bytesWritten: content.length,
        message: `Config file updated. Restart ${appId} for the changes to take effect.`,
      };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        hint: `Make sure the path is inside one of ${appId}'s volume mounts.`,
      };
    }
  },
});

// ── list_app_config_files ────────────────────────────────────────────────────

const CONFIG_EXTENSIONS = new Set([
  ".yml", ".yaml", ".json", ".toml", ".ini", ".conf", ".cfg",
  ".xml", ".env", ".properties", ".list", ".txt",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "__pycache__", "cache", "Cache",
  "logs", "log", "tmp", "temp",
]);

async function scanConfigFiles(
  dirPath: string,
  depth: number,
  maxDepth: number,
  results: Array<{ path: string; name: string; sizeBytes: number }>,
  maxFiles: number,
): Promise<void> {
  if (depth > maxDepth || results.length >= maxFiles) return;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          await scanConfigFiles(fullPath, depth + 1, maxDepth, results, maxFiles);
        }
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (CONFIG_EXTENSIONS.has(ext)) {
          try {
            const st = await stat(fullPath);
            // Skip files larger than 10MB — likely not config
            if (st.size < 10 * 1024 * 1024) {
              results.push({ path: fullPath, name: entry.name, sizeBytes: st.size });
            }
          } catch {}
        }
      }
    }
  } catch {}
}

export const listAppConfigFilesTool = tool({
  description: `Scan an installed app's bind-mounted volumes for config files (YAML, JSON, TOML, INI, XML, .env, .conf, etc.). Returns a list of discovered config files with their paths and sizes.

Use this to find what config files an app has before reading or editing them.

After calling: Present the found files grouped by type. Suggest which ones are likely the main config files based on common naming patterns.`,
  inputSchema: z.object({
    appId: z.string().describe("The app ID to scan for config files"),
    maxDepth: z.number().default(3).describe("Maximum directory depth to scan"),
  }),
  execute: async ({ appId, maxDepth }) => {
    const mounts = getAppVolumeMounts(appId);
    if (mounts.length === 0) {
      // Try to get compose path and find volumes from compose dir
      const row = db
        .select()
        .from(schema.installedApps)
        .where(eq(schema.installedApps.appId, appId))
        .get();

      if (!row?.overrideComposePath) {
        return {
          success: false,
          error: `App '${appId}' not found or has no volume mounts.`,
          hint: "Check if the app is installed with list_apps.",
        };
      }

      // Scan the compose directory itself as a fallback
      const composeDir = dirname(row.overrideComposePath);
      const results: Array<{ path: string; name: string; sizeBytes: number }> = [];
      await scanConfigFiles(composeDir, 0, maxDepth, results, 100);

      return {
        success: true,
        appId,
        volumeMounts: [],
        scanRoot: composeDir,
        files: results,
        count: results.length,
        summary: `Found ${results.length} config file(s) in compose directory.`,
      };
    }

    const allFiles: Array<{ path: string; name: string; sizeBytes: number; volume: string }> = [];
    for (const mount of mounts) {
      const files: Array<{ path: string; name: string; sizeBytes: number }> = [];
      await scanConfigFiles(mount, 0, maxDepth, files, 100);
      for (const f of files) {
        allFiles.push({ ...f, volume: mount });
      }
    }

    return {
      success: true,
      appId,
      volumeMounts: mounts,
      files: allFiles,
      count: allFiles.length,
      summary: `Found ${allFiles.length} config file(s) across ${mounts.length} volume(s).`,
    };
  },
});

export { safeConfigPath, getAppVolumeMounts };
