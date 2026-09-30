// ── Carrying catalog compose changes into an installed app's override ────────
//
// An install writes an override compose (APP_DATA_DIR/<appId>/docker-compose.yml)
// derived from the catalog compose plus Talome's edits (port remaps, mounts,
// the talome network, …); later the user may edit it too (env, limits, image
// pins). An update must bring the catalog's new service configuration
// (environment, healthcheck, command, …) into that override without undoing
// any of those edits.
//
// Three-way merge per service key (and per environment variable) against the
// catalog compose the override was last derived from — the "base", kept next
// to the override (`.talome-catalog-base.yml`):
//   override == base            → nobody edited it: take the catalog's new value
//   override != base, catalog == base → an edit Talome/the user made: keep it
//   all three differ            → conflict: keep the override, report it
// Apps installed before the base was recorded get additive changes only
// (keys and environment variables the override does not have yet); the base
// is recorded after their next update.
//
// Never touched here: `image` (see syncOverrideImageRefs and ops/image-refs.ts),
// and the keys Talome resolves at install — ports, volumes, networks,
// network_mode, container_name, build. Services the catalog adds or removes
// are not added or removed.

import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import yaml from "js-yaml";
import { atomicWriteFileSync } from "../utils/filesystem.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("catalog-sync");

type ComposeDoc = { services?: Record<string, Record<string, unknown> | null> } & Record<string, unknown>;

/** Service keys an update never syncs from the catalog. */
const UNSYNCED_KEYS = new Set(["image", "ports", "volumes", "networks", "network_mode", "container_name", "build"]);

/** Store sources whose override is the catalog compose plus plain edits (no source-specific rewriting). */
const SYNCABLE_SOURCES = new Set(["talome", "user-created"]);

export function isConfigSyncSource(source: string | null | undefined): boolean {
  return SYNCABLE_SOURCES.has(source ?? "talome");
}

export interface ConfigChange {
  service: string;
  key: string;
  /** For environment changes: the variable */
  variable?: string;
  change: "set" | "removed";
}

export interface ConfigConflict {
  service: string;
  key: string;
  variable?: string;
  /** Why the override's value was kept */
  reason: "edited" | "no_base";
}

export interface ConfigSyncResult {
  changes: ConfigChange[];
  /** Catalog changes not applied because the override's value was edited (or no base is recorded) */
  kept: ConfigConflict[];
}

// ── Base (the catalog compose the override was derived from) ──────────────────

function basePath(overridePath: string): string {
  return join(dirname(overridePath), ".talome-catalog-base.yml");
}

function previousBasePath(overridePath: string): string {
  return join(dirname(overridePath), ".talome-catalog-base.previous.yml");
}

/** The recorded base for an override, or null (none recorded / unreadable). */
export function readCatalogBase(overridePath: string): string | null {
  try {
    const p = basePath(overridePath);
    return existsSync(p) ? readFileSync(p, "utf-8") : null;
  } catch {
    return null;
  }
}

/**
 * Record the catalog compose content an override now corresponds to.
 * `previous`: "clear" (install — no earlier base applies), "rotate" (an update
 * — the current base is kept as the previous one, for a rollback), "keep"
 * (leave any previous base alone). Never throws.
 */
export function recordCatalogBase(
  overridePath: string,
  catalogContent: string,
  opts: { previous?: "clear" | "rotate" | "keep" } = {},
): void {
  try {
    const p = basePath(overridePath);
    const mode = opts.previous ?? "clear";
    if (mode === "rotate" && existsSync(p)) {
      if (readFileSync(p, "utf-8") === catalogContent) return;
      renameSync(p, previousBasePath(overridePath));
    } else if (mode === "clear") {
      rmSync(previousBasePath(overridePath), { force: true });
    }
    atomicWriteFileSync(p, catalogContent, "utf-8");
  } catch (err) {
    log.warn(`Could not record the catalog base of ${overridePath}`, err);
  }
}

/** After a rollback: the base goes back to the one before the update (if any). Never throws. */
export function restorePreviousCatalogBase(overridePath: string): void {
  try {
    const prev = previousBasePath(overridePath);
    if (existsSync(prev)) renameSync(prev, basePath(overridePath));
  } catch (err) {
    log.warn(`Could not restore the previous catalog base of ${overridePath}`, err);
  }
}

// ── Environment helpers ─────────────────────────────────────────────────────────

type EnvMap = Map<string, string | null>;

function parseEnv(value: unknown): EnvMap | null {
  const env: EnvMap = new Map();
  if (value === undefined || value === null) return env;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string") return null;
      const eq = entry.indexOf("=");
      if (eq < 0) env.set(entry, null);
      else env.set(entry.slice(0, eq), entry.slice(eq + 1));
    }
    return env;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      env.set(k, v === null || v === undefined ? null : String(v));
    }
    return env;
  }
  return null;
}

/** Write `env` back in the override's own format (list or map). */
function formatEnv(env: EnvMap, like: unknown): unknown {
  if (Array.isArray(like)) {
    return [...env.entries()].map(([k, v]) => (v === null ? k : `${k}=${v}`));
  }
  const out: Record<string, string | null> = {};
  for (const [k, v] of env) out[k] = v;
  return out;
}

// ── Merge ───────────────────────────────────────────────────────────────────────

function loadCompose(content: string): ComposeDoc | null {
  const doc = yaml.load(content);
  return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as ComposeDoc) : null;
}

function mergeEnvironment(
  service: string,
  svc: Record<string, unknown>,
  baseVal: unknown,
  catVal: unknown,
  hasBase: boolean,
  result: ConfigSyncResult,
): void {
  const ov = parseEnv(svc.environment);
  const cat = parseEnv(catVal);
  const base = hasBase ? parseEnv(baseVal) : null;
  if (!ov || !cat || (hasBase && !base)) return; // Unusual shapes: leave alone
  let changed = false;
  const names = new Set([...cat.keys(), ...(base ? base.keys() : [])]);
  for (const name of names) {
    const inOv = ov.has(name);
    const inCat = cat.has(name);
    const ovV = ov.get(name);
    const catV = cat.get(name);
    if (inOv === inCat && ovV === catV) continue;
    if (!base) {
      // No base: only add variables the override does not have yet.
      if (!inOv && inCat) {
        ov.set(name, catV ?? null);
        result.changes.push({ service, key: "environment", variable: name, change: "set" });
        changed = true;
      } else if (inCat) {
        result.kept.push({ service, key: "environment", variable: name, reason: "no_base" });
      }
      continue;
    }
    const inBase = base.has(name);
    const baseV = base.get(name);
    const untouched = inOv === inBase && ovV === baseV;
    const catalogChanged = !(inCat === inBase && catV === baseV);
    if (!catalogChanged) continue; // Only the override changed: an edit to keep
    if (!untouched) {
      result.kept.push({ service, key: "environment", variable: name, reason: "edited" });
      continue;
    }
    if (inCat) {
      ov.set(name, catV ?? null);
      result.changes.push({ service, key: "environment", variable: name, change: "set" });
    } else {
      ov.delete(name);
      result.changes.push({ service, key: "environment", variable: name, change: "removed" });
    }
    changed = true;
  }
  if (changed) svc.environment = formatEnv(ov, svc.environment ?? catVal);
}

/**
 * Compute the override compose with the catalog's service-configuration
 * changes applied (see the header). Pure: returns the new document (the input
 * is mutated) and what changed. `baseContent` null = no base recorded.
 */
export function mergeCatalogConfig(
  override: ComposeDoc,
  catalogContent: string,
  baseContent: string | null,
): ConfigSyncResult {
  const result: ConfigSyncResult = { changes: [], kept: [] };
  const catalog = loadCompose(catalogContent);
  const base = baseContent !== null ? loadCompose(baseContent) : null;
  const hasBase = base !== null;
  const ovServices = override.services;
  const catServices = catalog?.services;
  if (!ovServices || !catServices) return result;

  for (const [service, svc] of Object.entries(ovServices)) {
    const catSvc = catServices[service];
    if (!svc || !catSvc || typeof svc !== "object" || typeof catSvc !== "object") continue;
    const baseSvc = (base?.services?.[service] ?? null) as Record<string, unknown> | null;
    // A service the base did not have (added to the override later) has no three-way history.
    const serviceHasBase = hasBase && baseSvc !== null && typeof baseSvc === "object";
    const keys = new Set([...Object.keys(catSvc), ...(serviceHasBase ? Object.keys(baseSvc!) : [])]);
    for (const key of keys) {
      if (UNSYNCED_KEYS.has(key)) continue;
      const catVal = catSvc[key];
      const baseVal = serviceHasBase ? baseSvc![key] : undefined;
      if (key === "environment") {
        mergeEnvironment(service, svc, baseVal, catVal, serviceHasBase, result);
        continue;
      }
      const ovVal = svc[key];
      if (isDeepStrictEqual(ovVal, catVal)) continue;
      if (!serviceHasBase) {
        if (ovVal === undefined && catVal !== undefined) {
          svc[key] = catVal;
          result.changes.push({ service, key, change: "set" });
        } else {
          result.kept.push({ service, key, reason: "no_base" });
        }
        continue;
      }
      if (isDeepStrictEqual(catVal, baseVal)) continue; // Only the override changed: keep the edit
      if (!isDeepStrictEqual(ovVal, baseVal)) {
        result.kept.push({ service, key, reason: "edited" });
        continue;
      }
      if (catVal === undefined) {
        delete svc[key];
        result.changes.push({ service, key, change: "removed" });
      } else {
        svc[key] = catVal;
        result.changes.push({ service, key, change: "set" });
      }
    }
  }
  return result;
}

/** One sentence for results/notifications about catalog changes that were not applied ("" when none). */
export function describeKeptConfig(kept: ConfigConflict[]): string {
  if (kept.length === 0) return "";
  const items = kept.slice(0, 8).map((k) => `${k.service}.${k.key}${k.variable ? `.${k.variable}` : ""}`);
  const more = kept.length > items.length ? ` and ${kept.length - items.length} more` : "";
  return `Catalog changes to ${items.join(", ")}${more} were not applied because the app's compose has its own value there.`;
}
