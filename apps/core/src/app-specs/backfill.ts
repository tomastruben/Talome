import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "../utils/filesystem.js";
import { createDefaultAppSpec, TalomeAppSpecSchema } from "./schema.js";
import { getStoredAppSpec, saveAppSpec } from "./service.js";

interface UserAppRegistry {
  apps?: unknown;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Add a safe default native surface to active legacy user creations. */
export function backfillUserAppSpecs(): number {
  const root = join(homedir(), ".talome", "user-apps");
  const registryPath = join(root, "registry.json");
  if (!existsSync(registryPath)) return 0;

  let registry: UserAppRegistry;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8")) as UserAppRegistry;
  } catch {
    return 0;
  }
  if (!Array.isArray(registry.apps)) return 0;

  let count = 0;
  for (const value of registry.apps) {
    if (typeof value !== "string" || !value) continue;
    if (getStoredAppSpec("user-apps", value, { includeInactive: true })) continue;
    const appRoot = join(root, "apps", value);
    const manifest = readJson(join(appRoot, "manifest.json"));
    if (!manifest) continue;
    const creator = readJson(join(appRoot, "creator.json"));
    const blueprint = creator?.blueprint && typeof creator.blueprint === "object"
      ? creator.blueprint as Record<string, unknown>
      : null;
    const existingSpec = TalomeAppSpecSchema.safeParse(blueprint?.appSpec);
    const name = typeof manifest.name === "string" ? manifest.name : value;
    const description = typeof manifest.description === "string" && manifest.description
      ? manifest.description
      : `${name}, managed by Talome.`;
    const icon = typeof manifest.icon === "string" ? manifest.icon : undefined;
    const spec = existingSpec.success
      ? TalomeAppSpecSchema.parse({ ...existingSpec.data, appId: value, name, description, icon })
      : createDefaultAppSpec({ appId: value, name, description, icon });

    saveAppSpec({ storeId: "user-apps", spec, status: "approved" });
    atomicWriteFileSync(join(appRoot, "talome-app.json"), JSON.stringify(spec, null, 2));
    count += 1;
  }
  return count;
}
