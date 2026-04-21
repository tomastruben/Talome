import { tool } from "ai";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, like, or, and } from "drizzle-orm";
import {
  installApp,
  uninstallApp,
  startApp,
  stopApp,
  restartApp,
  updateApp,
  rollbackUpdate,
  resolveDependencies,
  bulkAction,
  bulkUpdate,
} from "../../stores/lifecycle.js";
import { addStore, syncStore } from "../../stores/sync.js";
import { getCatalogApp } from "../../stores/compose-exec.js";
import { writeAuditEntry } from "../../db/audit.js";
import { checkForUpdates } from "../../stores/update-checker.js";
import os from "node:os";

const dockerArch = os.arch() === "arm64" ? "arm64" : "amd64";

function isArchCompatible(row: { architectures: string | null }): boolean {
  if (!row.architectures) return true;
  try {
    const archs: string[] = JSON.parse(row.architectures);
    return archs.length === 0 || archs.includes(dockerArch);
  } catch {
    return true;
  }
}

export const listAppsTool = tool({
  description: "List available apps in the catalog. Can search by name or filter by category.",
  inputSchema: z.object({
    search: z.string().optional().describe("Search term to filter by name or description"),
    category: z.string().optional().describe("Filter by category (e.g. media, ai, networking)"),
    installedOnly: z.boolean().optional().describe("If true, only show installed apps"),
  }),
  execute: async ({ search, category, installedOnly }) => {
    let rows;

    if (installedOnly) {
      const installed = db.select().from(schema.installedApps).all();
      const results = [];
      for (const inst of installed) {
        const app = db
          .select()
          .from(schema.appCatalog)
          .where(
            and(
              eq(schema.appCatalog.appId, inst.appId),
              eq(schema.appCatalog.storeSourceId, inst.storeSourceId),
            ),
          )
          .get();
        if (app) {
          results.push({
            id: app.appId,
            name: app.name,
            category: app.category,
            description: app.tagline || app.description,
            source: app.source,
            status: inst.status,
          });
        }
      }
      return results;
    }

    const conditions: any[] = [];

    if (search) {
      const term = `%${search}%`;
      conditions.push(
        or(
          like(schema.appCatalog.name, term),
          like(schema.appCatalog.tagline, term),
          like(schema.appCatalog.description, term),
        ),
      );
    }

    if (category) {
      conditions.push(eq(schema.appCatalog.category, category));
    }

    if (conditions.length > 0) {
      rows = db
        .select()
        .from(schema.appCatalog)
        .where(and(...conditions))
        .limit(100)
        .all();
    } else {
      rows = db.select().from(schema.appCatalog).limit(100).all();
    }

    const compatible = rows.filter(isArchCompatible).slice(0, 30);

    return compatible.map((r) => ({
      id: r.appId,
      storeId: r.storeSourceId,
      name: r.name,
      category: r.category,
      description: r.tagline || r.description,
      source: r.source,
    }));
  },
});

export const searchAppsTool = tool({
  description: "Search across all app stores for apps matching a query. Returns name, category, source.",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
  }),
  execute: async ({ query }) => {
    const term = `%${query}%`;
    const rows = db
      .select()
      .from(schema.appCatalog)
      .where(
        or(
          like(schema.appCatalog.name, term),
          like(schema.appCatalog.tagline, term),
          like(schema.appCatalog.description, term),
          like(schema.appCatalog.category, term),
        ),
      )
      .limit(50)
      .all();

    const compatible = rows.filter(isArchCompatible).slice(0, 20);

    return compatible.map((r) => ({
      id: r.appId,
      storeId: r.storeSourceId,
      name: r.name,
      category: r.category,
      tagline: r.tagline,
      description: r.description,
      source: r.source,
      version: r.version,
      website: r.website || undefined,
      installNotes: r.installNotes || undefined,
    }));
  },
});

export const checkDependenciesTool = tool({
  description: "Check if an app's dependencies are satisfied before installing. Returns missing and installed dependencies.",
  inputSchema: z.object({
    appId: z.string().describe("App ID to check dependencies for"),
    storeId: z.string().describe("Store source ID"),
  }),
  execute: async ({ appId, storeId }) => {
    const result = resolveDependencies(appId, storeId);
    return {
      ...result,
      message: result.satisfied
        ? "All dependencies are satisfied."
        : `Missing: ${result.missing.map((d) => d.name).join(", ")}. Install them first.`,
    };
  },
});

export const installAppTool = tool({
  description: `Install an app from the catalog. Automatically checks dependencies, resolves port conflicts, and for Umbrel apps auto-generates platform variables. For media apps, provide volumeMounts to map media volumes to host paths at install time (e.g. { 'media': '/Volumes/Media/Movies' }). Check search_apps results for volumes with mediaVolume=true to know which volumes need user paths.

After install, known apps (Sonarr, Radarr, Readarr, Prowlarr) are auto-configured: API key extracted from config.xml, settings saved (activating tool domains), and related apps wired (Prowlarr indexer sync, qBittorrent download client). Check the autoConfig field in the response to see what was done — do NOT repeat those steps manually.

All apps are placed on the shared 'talome' Docker network so they can reach each other by container name (e.g. http://sonarr:8989).`,
  inputSchema: z.object({
    appId: z.string().describe("App ID from the catalog"),
    storeId: z.string().describe("Store source ID the app belongs to"),
    env: z.record(z.string(), z.string()).optional().describe("Environment variable overrides."),
    volumeMounts: z.record(z.string(), z.string()).optional().describe("Volume name → host path mapping for media volumes (e.g. { 'media': '/Volumes/Media/Movies', 'downloads': '/DATA/Downloads' }). Only needed for volumes with mediaVolume=true."),
  }),
  execute: async ({ appId, storeId, env, volumeMounts }) => {
    const result = await installApp(appId, storeId, env || {}, volumeMounts || {});
    if (result.success) {
      writeAuditEntry("Installed app", "modify", `${appId} from store ${storeId}`);

      // Enrich response with app documentation so the AI can guide the user
      const catalogApp = getCatalogApp(appId, storeId);
      if (catalogApp) {
        const appContext: Record<string, string> = {};
        if (catalogApp.description) appContext.description = catalogApp.description;
        if (catalogApp.installNotes) appContext.installNotes = catalogApp.installNotes;
        if (catalogApp.releaseNotes) appContext.releaseNotes = catalogApp.releaseNotes;
        if (catalogApp.website) appContext.website = catalogApp.website;
        if (catalogApp.support) appContext.support = catalogApp.support;
        if (Object.keys(appContext).length > 0) {
          return {
            ...result,
            appDocumentation: appContext,
            guidance: `App "${catalogApp.name}" installed successfully. Read the appDocumentation field for details about this app — use it to guide the user through initial setup, explain what the app does, and suggest next configuration steps.`,
          };
        }
      }
    } else {
      writeAuditEntry("Install failed", "modify", `${appId}: ${result.error}`);
    }
    return result;
  },
});

export const uninstallAppTool = tool({
  description: "Uninstall an app and remove its containers. This is a DESTRUCTIVE action requiring explicit CONFIRM from user.",
  inputSchema: z.object({
    appId: z.string().describe("App ID to uninstall"),
    confirmed: z.boolean().describe("Must be true — ask user to confirm before calling"),
  }),
  execute: async ({ appId, confirmed }) => {
    if (!confirmed) {
      return { error: "This is a destructive action. Ask the user to confirm, then call again with confirmed: true." };
    }
    const result = await uninstallApp(appId);
    if (result.success) {
      writeAuditEntry("Uninstalled app", "destructive", appId);
    } else {
      writeAuditEntry("Uninstall failed", "destructive", `${appId}: ${result.error}`);
    }
    return result;
  },
});

export const startAppTool = tool({
  description: "Start an installed app's containers.",
  inputSchema: z.object({
    appId: z.string().describe("App ID to start"),
  }),
  execute: async ({ appId }) => {
    const result = await startApp(appId);
    if (result.success) writeAuditEntry("Started app", "modify", appId);
    return result;
  },
});

export const stopAppTool = tool({
  description: "Stop an installed app's containers.",
  inputSchema: z.object({
    appId: z.string().describe("App ID to stop"),
  }),
  execute: async ({ appId }) => {
    const result = await stopApp(appId);
    if (result.success) writeAuditEntry("Stopped app", "modify", appId);
    return result;
  },
});

export const restartAppTool = tool({
  description: "Restart an installed app's containers.",
  inputSchema: z.object({
    appId: z.string().describe("App ID to restart"),
  }),
  execute: async ({ appId }) => {
    const result = await restartApp(appId);
    if (result.success) writeAuditEntry("Restarted app", "modify", appId);
    return result;
  },
});

export const updateAppTool = tool({
  description: "Update an installed app by pulling the latest image and recreating containers.",
  inputSchema: z.object({
    appId: z.string().describe("App ID to update"),
  }),
  execute: async ({ appId }) => {
    const result = await updateApp(appId);
    if (result.success) writeAuditEntry("Updated app", "modify", appId);
    return result;
  },
});

export const addStoreTool = tool({
  description: "Add a new app store source by its Git URL. Supports CasaOS, Umbrel, and Talome-native store formats. Auto-detects the format.",
  inputSchema: z.object({
    name: z.string().describe("Display name for the store"),
    gitUrl: z.string().describe("Git repository URL for the store"),
  }),
  execute: async ({ name, gitUrl }) => {
    const result = await addStore(name, gitUrl);
    if (result.success) {
      writeAuditEntry("Added store", "modify", `${name}: ${gitUrl}`);
    }
    return result;
  },
});

// ── Bulk operations ───────────────────────────────────────────────────────

export const bulkAppActionTool = tool({
  description: "Perform an action on multiple apps at once: start, stop, or restart. Returns per-app results. Requires user approval before execution.",
  inputSchema: z.object({
    appIds: z.array(z.string()).describe("List of app IDs to operate on"),
    action: z.enum(["start", "stop", "restart"]).describe("Action to perform on all apps"),
  }),
  execute: async ({ appIds, action }) => {
    const results = await bulkAction(appIds, action);
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    writeAuditEntry(`Bulk ${action}`, "modify", `${succeeded} succeeded, ${failed} failed: ${appIds.join(", ")}`);
    return {
      success: failed === 0,
      message: `${action}: ${succeeded} succeeded, ${failed} failed`,
      results,
    };
  },
});

export const bulkUpdateAppsTool = tool({
  description: "Update multiple apps sequentially. Checks for available updates first. Returns per-app results. Requires user approval before execution.",
  inputSchema: z.object({
    appIds: z.array(z.string()).optional().describe("Specific app IDs to update. If omitted, updates all apps with available updates."),
  }),
  execute: async ({ appIds }) => {
    let targetIds = appIds;
    if (!targetIds || targetIds.length === 0) {
      const updates = checkForUpdates();
      targetIds = updates.map((u) => u.appId);
      if (targetIds.length === 0) {
        return { success: true, message: "All apps are up to date.", results: [] };
      }
    }
    const results = await bulkUpdate(targetIds);
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    writeAuditEntry("Bulk update", "modify", `${succeeded} succeeded, ${failed} failed: ${targetIds.join(", ")}`);
    return {
      success: failed === 0,
      message: `Updated: ${succeeded} succeeded, ${failed} failed`,
      results,
    };
  },
});

export const rollbackUpdateTool = tool({
  description: "Roll back an app to its previous version after an update. Restores the compose file and version from the most recent update snapshot. Requires user approval.",
  inputSchema: z.object({
    appId: z.string().describe("The app ID to roll back"),
  }),
  execute: async ({ appId }) => {
    writeAuditEntry("Rollback update", "destructive", appId);
    const result = await rollbackUpdate(appId);
    return result;
  },
});
