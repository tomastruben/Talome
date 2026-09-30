/**
 * Per-install generated secrets for Talome-store apps.
 *
 * A manifest env entry can ask Talome to generate its value instead of making
 * the installer (or the AI) invent one:
 *
 *   {"key": "DB_PASSWORD", "secret": true, "generate": "alnum32"}
 *
 * The value is generated with `crypto.randomBytes` when the install env does
 * not provide it, and persisted like any user env value (installed_apps
 * envConfig + the per-app .env). A reinstall reuses the value left in the
 * app's .env by the previous install: data kept under app-data (e.g. a
 * Postgres cluster) was initialised with that secret and ignores a new one.
 * Deleting the app's data folder removes the .env too, so a clean install
 * gets a fresh secret.
 *
 * The manifest.json is read from next to the catalog compose file, so no
 * catalog schema change is needed. Stores without a manifest.json (Umbrel,
 * CasaOS) are unaffected.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createLogger } from "../utils/logger.js";
import { APP_DATA_DIR } from "./compose-exec.js";

const log = createLogger("generated-env");

export const GENERATED_ENV_KINDS = ["alnum32", "hex64"] as const;
export type GeneratedEnvKind = (typeof GENERATED_ENV_KINDS)[number];

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ManifestEnvSchema = z.object({
  env: z
    .array(
      z
        .object({
          key: z.string().regex(ENV_KEY),
          generate: z.enum(GENERATED_ENV_KINDS).optional(),
        })
        .passthrough(),
    )
    .optional(),
}).passthrough();

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Uniform alphanumeric string (rejection sampling, no modulo bias). */
function randomAlnum(length: number): string {
  const limit = 256 - (256 % ALNUM.length);
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += ALNUM[byte % ALNUM.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export function generateEnvValue(kind: GeneratedEnvKind): string {
  switch (kind) {
    case "alnum32":
      return randomAlnum(32);
    case "hex64":
      return randomBytes(32).toString("hex");
  }
}

/** Env keys the app's manifest.json asks Talome to generate. Empty when none/unreadable. */
export function readGeneratedEnvSpecs(composePath: string): Array<{ key: string; kind: GeneratedEnvKind }> {
  const manifestPath = join(dirname(composePath), "manifest.json");
  if (!existsSync(manifestPath)) return [];
  try {
    const parsed = ManifestEnvSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf-8")));
    if (!parsed.success) return [];
    return (parsed.data.env ?? []).flatMap((e) => (e.generate ? [{ key: e.key, kind: e.generate }] : []));
  } catch (err: unknown) {
    log.warn(`reading ${manifestPath}`, err);
    return [];
  }
}

/** Values left in the app's .env by a previous install (kept by uninstall). */
function readPreviousDotEnv(appId: string): Record<string, string> {
  const path = join(APP_DATA_DIR, appId, ".env");
  if (!existsSync(path)) return {};
  try {
    const values: Record<string, string> = {};
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (ENV_KEY.test(key)) values[key] = line.slice(eq + 1);
    }
    return values;
  } catch {
    return {};
  }
}

export interface GeneratedEnvResult {
  env: Record<string, string>;
  /** Keys that got a new random value */
  generated: string[];
  /** Keys that reuse the value of a previous install of this app */
  reused: string[];
}

/**
 * Fill every manifest-declared generated secret the install env leaves empty.
 * Explicit install env values always win. Never throws.
 */
export function fillGeneratedInstallEnv(
  appId: string,
  composePath: string,
  envOverrides: Record<string, string>,
): GeneratedEnvResult {
  try {
    return fillSpecs(appId, readGeneratedEnvSpecs(composePath), envOverrides);
  } catch (err: unknown) {
    log.warn(`generating install env for ${appId}`, err);
    return { env: envOverrides, generated: [], reused: [] };
  }
}

/** Fill `specs` the env leaves empty: a previous install's value, else a new random one. */
function fillSpecs(
  appId: string,
  specs: Array<{ key: string; kind: GeneratedEnvKind }>,
  envOverrides: Record<string, string>,
): GeneratedEnvResult {
  const result: GeneratedEnvResult = { env: envOverrides, generated: [], reused: [] };
  const missing = specs.filter((s) => !envOverrides[s.key]);
  if (missing.length === 0) return result;
  const previous = readPreviousDotEnv(appId);
  const env = { ...envOverrides };
  for (const { key, kind } of missing) {
    const prior = previous[key];
    if (prior) {
      env[key] = prior;
      result.reused.push(key);
    } else {
      env[key] = generateEnvValue(kind);
      result.generated.push(key);
    }
  }
  result.env = env;
  return result;
}

/** Variables a compose text interpolates (`${VAR…}` / `$VAR`; `$$` is a literal dollar). */
function referencedVariables(composeText: string): Set<string> {
  const names = new Set<string>();
  const text = composeText.replace(/\$\$/g, "");
  for (const m of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
  return names;
}

/**
 * An update whose compose starts referencing a manifest-declared generated
 * secret (e.g. a new `JWT_SECRET: ${JWT_SECRET}` merged from the catalog):
 * fill it like an install would, or compose interpolates it as an empty
 * string. Only secrets the running compose did not reference yet are filled —
 * an older install that runs without one keeps running as it is (its data may
 * have been initialised without it). Explicit env values always win. Never throws.
 */
export function fillGeneratedUpdateEnv(
  appId: string,
  catalogComposePath: string,
  envOverrides: Record<string, string>,
  currentCompose: string,
  nextCompose: string,
): GeneratedEnvResult {
  const result: GeneratedEnvResult = { env: envOverrides, generated: [], reused: [] };
  try {
    const before = referencedVariables(currentCompose);
    const after = referencedVariables(nextCompose);
    const specs = readGeneratedEnvSpecs(catalogComposePath).filter((s) => after.has(s.key) && !before.has(s.key));
    return fillSpecs(appId, specs, envOverrides);
  } catch (err: unknown) {
    log.warn(`generating update env for ${appId}`, err);
    return result;
  }
}
