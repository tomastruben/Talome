import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { isSecretSettingKey, decryptSetting, encryptSetting } from "./crypto.js";

/**
 * Read a single setting from the database, decrypting secret values automatically.
 */
export function getSetting(key: string): string | undefined {
  try {
    const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    if (!row?.value) return undefined;
    return isSecretSettingKey(key) ? decryptSetting(row.value) : row.value;
  } catch {
    return undefined;
  }
}

/**
 * Write a setting to the database (upsert), encrypting secret values automatically.
 */
export function setSetting(key: string, value: string): void {
  try {
    const storedValue = isSecretSettingKey(key) ? encryptSetting(value) : value;
    db.insert(schema.settings)
      .values({ key, value: storedValue })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: storedValue } })
      .run();
  } catch {
    // Best-effort — settings writes should not crash callers
  }
}
