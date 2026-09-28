import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Install-time choices for store apps (Umbrel 2.0 folderAccess, environment,
 * data root, dependency providers) and the resolved plan, so later operations
 * (updates, backups, proxy) can honour them. Created by
 * db/migrations/store-compat.ts.
 */
export const appInstallOptions = sqliteTable("app_install_options", {
  appId: text("app_id").primaryKey(),
  storeSourceId: text("store_source_id").notNull(),
  /** User choices as submitted (UmbrelInstallOptions JSON) */
  options: text("options").notNull().default("{}"),
  /** Resolved plan summary (mounts, env, devices, requiresHttps, backupIgnore, warnings) JSON */
  plan: text("plan").notNull().default("{}"),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});
