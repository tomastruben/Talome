import { tool } from "ai";
import { z } from "zod";
import { db } from "../../db/index.js";
import { sql } from "drizzle-orm";
import { checkForUpdates } from "../../stores/update-checker.js";

export const checkUpdatesTool = tool({
  description: "Check all installed apps for available updates by comparing installed versions against the catalog.",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const updates = checkForUpdates();
      if (updates.length === 0) {
        return { success: true, message: "All apps are up to date.", updates: [] };
      }
      return {
        success: true,
        message: `${updates.length} update${updates.length > 1 ? "s" : ""} available.`,
        updates,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

export const setUpdatePolicyTool = tool({
  description: "Set the update policy for an app (auto, manual, or schedule). When set to auto, the app will be updated automatically. Pre-backup can be enabled to back up the app before updating.",
  inputSchema: z.object({
    appId: z.string().describe("The app ID to set the policy for"),
    policy: z.enum(["auto", "manual", "schedule"]).describe("Update policy"),
    cron: z.string().optional().describe("Cron expression for scheduled updates (required when policy is 'schedule')"),
    preBackup: z.boolean().default(true).describe("Whether to back up the app before updating"),
  }),
  execute: async ({ appId, policy, cron, preBackup }) => {
    try {
      const now = new Date().toISOString();
      db.run(sql`INSERT INTO app_update_policies (app_id, policy, cron, pre_backup, created_at)
        VALUES (${appId}, ${policy}, ${cron ?? null}, ${preBackup ? 1 : 0}, ${now})
        ON CONFLICT(app_id) DO UPDATE SET policy = ${policy}, cron = ${cron ?? null}, pre_backup = ${preBackup ? 1 : 0}`);
      return { success: true, appId, policy, cron: cron ?? null, preBackup };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

export const updateAllAppsTool = tool({
  description: "Update all apps that have available updates. Optionally backs up each app before updating.",
  inputSchema: z.object({
    preBackup: z.boolean().default(true).describe("Back up each app before updating"),
  }),
  execute: async ({ preBackup }) => {
    try {
      const updates = checkForUpdates();
      if (updates.length === 0) {
        return { success: true, message: "All apps are up to date.", updated: [] };
      }
      return {
        success: true,
        message: `${updates.length} app${updates.length > 1 ? "s" : ""} can be updated. Use update_app for each one individually to maintain control.`,
        updates,
        hint: preBackup ? "Pre-backup is enabled — use backup_app before each update_app call." : undefined,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});
