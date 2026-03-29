import { tool } from "ai";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";
import { bulkAction, type BulkAction } from "../../stores/lifecycle.js";
import { writeAuditEntry } from "../../db/audit.js";
// Note: per-group Docker networks are deprecated — all apps share the `talome` bridge

export const listGroupsTool = tool({
  description: "List all app groups. Groups let users organize related apps (e.g. 'Media Stack', 'Home Automation') and perform bulk operations on them.",
  inputSchema: z.object({}),
  execute: async () => {
    const groups = db.select().from(schema.appGroups).all();
    return {
      success: true,
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        appIds: JSON.parse(g.appIds) as string[],
        networkName: g.networkName,
        createdAt: g.createdAt,
      })),
    };
  },
});

export const createGroupTool = tool({
  description: "Create a new app group to organize related apps together. Groups enable bulk start/stop/restart operations. All apps already share the unified 'talome' Docker network — per-group networks are no longer needed.",
  inputSchema: z.object({
    name: z.string().describe("Group name (e.g. 'Media Stack', 'Home Automation')"),
    description: z.string().optional().describe("Brief description of the group's purpose"),
    appIds: z.array(z.string()).describe("App IDs to include in the group"),
    createNetwork: z.boolean().default(false).describe("Deprecated — all apps share the 'talome' network. Ignored."),
  }),
  execute: async ({ name, description, appIds }) => {
    const id = randomUUID();

    // Per-group networks are deprecated — all apps share the unified `talome` network
    const networkName = null;

    db.insert(schema.appGroups)
      .values({
        id,
        name,
        description: description ?? "",
        appIds: JSON.stringify(appIds),
        networkName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();

    writeAuditEntry("Create app group", "modify", `${name}: ${appIds.join(", ")}`);
    return { success: true, id, name, appIds, network: "talome (shared)" };
  },
});

export const updateGroupTool = tool({
  description: "Update an app group — change its name, description, or member apps.",
  inputSchema: z.object({
    groupId: z.string().describe("The group ID to update"),
    name: z.string().optional().describe("New group name"),
    description: z.string().optional().describe("New description"),
    appIds: z.array(z.string()).optional().describe("New list of app IDs (replaces existing)"),
    addAppIds: z.array(z.string()).optional().describe("App IDs to add to the group"),
    removeAppIds: z.array(z.string()).optional().describe("App IDs to remove from the group"),
  }),
  execute: async ({ groupId, name, description, appIds, addAppIds, removeAppIds }) => {
    const group = db.select().from(schema.appGroups).where(eq(schema.appGroups.id, groupId)).get();
    if (!group) return { success: false, error: "Group not found" };

    let currentIds = JSON.parse(group.appIds) as string[];

    if (appIds) {
      currentIds = appIds;
    } else {
      if (addAppIds) {
        for (const id of addAppIds) {
          if (!currentIds.includes(id)) currentIds.push(id);
        }
      }
      if (removeAppIds) {
        currentIds = currentIds.filter((id) => !removeAppIds.includes(id));
      }
    }

    const updates: Record<string, string> = {
      appIds: JSON.stringify(currentIds),
      updatedAt: new Date().toISOString(),
    };
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;

    db.update(schema.appGroups)
      .set(updates)
      .where(eq(schema.appGroups.id, groupId))
      .run();

    writeAuditEntry("Update app group", "modify", `${group.name}: ${currentIds.join(", ")}`);
    return { success: true, groupId, appIds: currentIds };
  },
});

export const deleteGroupTool = tool({
  description: "Delete an app group. This only removes the group — it does NOT uninstall or stop the apps in it.",
  inputSchema: z.object({
    groupId: z.string().describe("The group ID to delete"),
  }),
  execute: async ({ groupId }) => {
    const group = db.select().from(schema.appGroups).where(eq(schema.appGroups.id, groupId)).get();
    if (!group) return { success: false, error: "Group not found" };

    db.delete(schema.appGroups).where(eq(schema.appGroups.id, groupId)).run();
    writeAuditEntry("Delete app group", "destructive", group.name);
    return { success: true, deletedGroup: group.name };
  },
});

export const groupActionTool = tool({
  description: "Perform an action (start, stop, restart) on all apps in a group. Executes in parallel for efficiency. Requires user approval.",
  inputSchema: z.object({
    groupId: z.string().describe("The group ID to act on"),
    action: z.enum(["start", "stop", "restart"]).describe("The action to perform"),
  }),
  execute: async ({ groupId, action }) => {
    const group = db.select().from(schema.appGroups).where(eq(schema.appGroups.id, groupId)).get();
    if (!group) return { success: false, error: "Group not found" };

    const appIds = JSON.parse(group.appIds) as string[];
    if (appIds.length === 0) return { success: true, message: "Group has no apps", results: [] };

    const results = await bulkAction(appIds, action as BulkAction);
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    writeAuditEntry(`Group ${action}`, "modify", `${group.name}: ${succeeded} succeeded, ${failed} failed`);
    return {
      success: failed === 0,
      group: group.name,
      message: `${action}: ${succeeded} succeeded, ${failed} failed`,
      results,
    };
  },
});
