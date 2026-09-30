import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TalomeAppSpecSchema } from "../app-specs/schema.js";
import { getStoredAppSpec } from "../app-specs/service.js";

/** Resolve the exact next native revision before its private artifact is hashed and rendered. */
export function preparePublicationContract(scaffoldPath: string, appId: string, fallback?: unknown) {
  const path = join(scaffoldPath, "talome-app.json");
  const value = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
  if (!value) return undefined;
  const spec = TalomeAppSpecSchema.parse(value);
  if (spec.appId !== appId) throw new Error(`AppSpec appId must be ${appId}.`);
  const stored = getStoredAppSpec("user-apps", appId, { includeInactive: true });
  spec.revision = stored ? Math.max(spec.revision, stored.revision + 1) : spec.revision;
  writeFileSync(path, JSON.stringify(spec, null, 2), { mode: 0o600 });
  return spec;
}
