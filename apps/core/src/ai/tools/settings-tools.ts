import { tool } from "ai";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, desc } from "drizzle-orm";
import { getActiveDomainNames, getAllDomains } from "../tool-registry.js";
import { isSecretSettingKey, encryptSetting, decryptSetting } from "../../utils/crypto.js";

function maskIfSecret(key: string, value: string): string {
  if (isSecretSettingKey(key) && value.length > 4) {
    return value.slice(0, 4) + "****";
  }
  return value;
}

export const getSettingsTool = tool({
  description: `Read Talome settings. Returns all settings when no key is provided, or a specific value when key is given.

After calling: Present key-value pairs concisely. Mask any values that look like API keys or tokens (show first 4 chars only).`,
  inputSchema: z.object({
    key: z
      .string()
      .optional()
      .describe("Specific setting key to read, or omit for all settings"),
  }),
  execute: async ({ key }) => {
    if (key) {
      const row = db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, key))
        .get();
      if (!row) return { found: false, key, summary: `Setting "${key}" not found.` };
      const masked = maskIfSecret(key, isSecretSettingKey(key) ? decryptSetting(row.value) : row.value);
      return { found: true, key, value: masked, summary: `${key} = ${masked}` };
    }
    const rows = db.select().from(schema.settings).all();
    return {
      settings: rows.map((r) => ({
        key: r.key,
        value: maskIfSecret(r.key, isSecretSettingKey(r.key) ? decryptSetting(r.value) : r.value),
      })),
      count: rows.length,
      summary: `${rows.length} settings configured.`,
    };
  },
});

export const setSettingTool = tool({
  description: `Create or update a Talome setting. Used to configure app integrations (e.g. sonarr_url, radarr_api_key). Requires user confirmation.

After calling: Confirm the setting was saved. If this enables a new app domain (e.g. setting sonarr_url enables Arr tools), mention that the new tools are now available.`,
  inputSchema: z.object({
    key: z.string().describe("Setting key (e.g. sonarr_url, jellyfin_api_key)"),
    value: z.string().describe("Setting value"),
  }),
  execute: async ({ key, value }) => {
    // Read current value before write
    const existing = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, key))
      .get();
    const previousValue = existing?.value ?? null;

    // Encrypt secret values before storing
    const storedValue = isSecretSettingKey(key) ? encryptSetting(value) : value;

    // Perform the upsert
    db.insert(schema.settings)
      .values({ key, value: storedValue })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: storedValue } })
      .run();

    // Record history if value actually changed
    if (previousValue !== null && previousValue !== storedValue) {
      db.insert(schema.settingsHistory)
        .values({
          key,
          previousValue,
          newValue: storedValue,
          changedBy: "ai",
        })
        .run();
    }

    return {
      key,
      previousValue: previousValue ? maskIfSecret(key, isSecretSettingKey(key) ? decryptSetting(previousValue) : previousValue) : null,
      newValue: maskIfSecret(key, value),
      summary: previousValue
        ? `Setting "${key}" updated.`
        : `Setting "${key}" created.`,
      status: "ok",
    };
  },
});

export const revertSettingTool = tool({
  description: `Revert a Talome setting to its previous value. Reads the most recent change from settings history and restores the old value. Use this when a setting change needs to be undone.

After calling: Confirm which setting was reverted and what it was changed back to.`,
  inputSchema: z.object({
    key: z.string().describe("Setting key to revert"),
  }),
  execute: async ({ key }) => {
    const latest = db
      .select()
      .from(schema.settingsHistory)
      .where(eq(schema.settingsHistory.key, key))
      .orderBy(desc(schema.settingsHistory.id))
      .limit(1)
      .get();

    if (!latest) {
      return { key, status: "error", summary: `No history found for "${key}".` };
    }

    const restoreValue = latest.previousValue ?? "";

    // Restore previous value
    db.insert(schema.settings)
      .values({ key, value: restoreValue })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: restoreValue } })
      .run();

    // Record the revert itself in history
    db.insert(schema.settingsHistory)
      .values({
        key,
        previousValue: latest.newValue,
        newValue: restoreValue,
        changedBy: "ai-revert",
      })
      .run();

    return {
      key,
      previousValue: maskIfSecret(key, latest.newValue),
      restoredValue: maskIfSecret(key, restoreValue),
      status: "ok",
      summary: `Setting "${key}" reverted to "${maskIfSecret(key, restoreValue)}".`,
    };
  },
});

export const listConfiguredAppsTool = tool({
  description: `Show which app integrations are currently active based on configured settings. Returns active domain names and their settings keys.

After calling: Present as a concise list. Highlight which domains are active and which are not yet configured. Offer to help configure missing ones.`,
  inputSchema: z.object({}),
  execute: async () => {
    const activeDomains = getActiveDomainNames();
    const allDomains = getAllDomains();

    const domains = allDomains.map((d) => ({
      name: d.name,
      active: activeDomains.has(d.name),
      settingsKeys: d.settingsKeys,
      toolCount: Object.keys(d.tools).length,
    }));

    const active = domains.filter((d) => d.active);
    const inactive = domains.filter((d) => !d.active && d.settingsKeys.length > 0);

    return {
      domains,
      summary: `${active.length} active domain(s), ${inactive.length} unconfigured.`,
      activeDomains: active.map((d) => d.name),
      unconfiguredDomains: inactive.map((d) => ({
        name: d.name,
        needsAnyOf: d.settingsKeys,
      })),
    };
  },
});
