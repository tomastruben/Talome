/**
 * Umbrel 2.0 manifest support — pure install-time mapping.
 *
 * Umbrel 2.0 manifests can declare `folderAccess`, `environment`, `storage`,
 * `implements`, `torOnly`, `requiresHttps`, `backupIgnore` and GPU permissions.
 * This module turns those declarations (plus the user's install choices) into a
 * concrete plan and applies it to a docker-compose document.
 *
 * Everything here is pure: no DB, no filesystem, no Docker. The impure glue that
 * feeds real settings/installed apps in lives in `umbrel-v2-install.ts`.
 *
 * Field semantics follow the Umbrel manifest documentation; the implementation
 * is Talome's own.
 */
import { posix } from "node:path";
import { z } from "zod";

// ── Manifest field schemas (shared with the Umbrel adapter) ──────────────────

export const UMBREL_NOTE_MAX_LENGTH = 300;
export const ENV_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

function truncateNote(note: string): string | undefined {
  const trimmed = note.trim();
  if (!trimmed) return undefined;
  return trimmed.length > UMBREL_NOTE_MAX_LENGTH
    ? `${trimmed.slice(0, UMBREL_NOTE_MAX_LENGTH - 1).trimEnd()}…`
    : trimmed;
}

const noteSchema = z
  .string()
  .transform(truncateNote)
  .optional();

/** YAML parses unquoted `1000` / `true` as non-strings — coerce scalars to strings. */
export function scalarToString(value: unknown): unknown {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : value;
}

export const UmbrelFolderAccessMountSchema = z.object({
  service: z.string().trim().min(1).optional(),
  targetPath: z.string().trim().min(1),
  readOnly: z.boolean().optional(),
});

export const UmbrelFolderAccessSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  note: noteSchema,
  mounts: z.array(UmbrelFolderAccessMountSchema).min(1),
});

export const UmbrelEnvironmentInputSchema = z.object({
  name: z.string().trim().regex(ENV_NAME_REGEX, "invalid environment variable name"),
  services: z.array(z.string().trim().min(1)).min(1),
  default: z.preprocess(
    (value) => (value === null || value === undefined ? undefined : String(value)),
    z.string().optional(),
  ),
  options: z
    .array(z.preprocess(scalarToString, z.string().min(1)))
    .min(1)
    .refine((options) => new Set(options).size === options.length, {
      message: "environment options must be unique",
    })
    .optional(),
  note: noteSchema,
});

export const UmbrelStorageSchema = z.object({ dataRoot: z.literal("data") }).strict();

export type UmbrelFolderAccess = z.infer<typeof UmbrelFolderAccessSchema>;
export type UmbrelEnvironmentInput = z.infer<typeof UmbrelEnvironmentInputSchema>;

/**
 * Umbrel 2.0 metadata persisted per catalog row (app_catalog.umbrel_meta).
 * Only fields Talome's base AppManifest doesn't already carry live here.
 */
export interface UmbrelV2Meta {
  manifestVersion?: string;
  disabled?: boolean;
  submitter?: string;
  submission?: string;
  path?: string;
  deterministicPassword?: boolean;
  optimizedForUmbrelHome?: boolean;
  torOnly?: boolean;
  requiresHttps?: boolean;
  nativeTlsHostnameSuffixes?: string[];
  installSize?: number;
  widgets?: unknown[];
  defaultShell?: string;
  implements?: string[];
  backupIgnore?: string[];
  storage?: { dataRoot: "data" };
  folderAccess?: UmbrelFolderAccess[];
  environment?: UmbrelEnvironmentInput[];
  /** Raw Umbrel permissions (e.g. ["GPU", "STORAGE_DOWNLOADS"]). */
  permissions?: string[];
  /** Raw declared dependencies (app ids or interfaces implemented by other apps). */
  dependencies?: string[];
  /** Manifest fields unknown to Talome, preserved verbatim for forward compatibility. */
  unknownFields?: Record<string, unknown>;
  /** Non-fatal parse warnings (invalid optional fields that were dropped). */
  warnings?: string[];
}

// ── Install options (user choices) ───────────────────────────────────────────

export const UmbrelInstallOptionsSchema = z.object({
  /** folderAccess id → absolute host folder */
  folders: z.record(z.string(), z.string().min(1)).optional(),
  /** manifest environment name → value */
  environment: z.record(z.string(), z.string()).optional(),
  /** Host folder for the app's data root (only honoured when the manifest declares storage.dataRoot) */
  dataRoot: z.string().min(1).optional(),
  /** declared dependency → installed provider app id */
  dependencies: z.record(z.string(), z.string().min(1)).optional(),
});

export type UmbrelInstallOptions = z.infer<typeof UmbrelInstallOptionsSchema>;

// ── Install context ──────────────────────────────────────────────────────────

export interface UmbrelV2Paths {
  /** Host directory Talome uses as APP_DATA_DIR for this app. */
  appDataDir: string;
  /** Parent of every app's data dir (maps `${UMBREL_ROOT}/app-data/<id>`). */
  appDataParent: string;
  mediaRoot?: string;
  downloadsRoot?: string;
  booksRoot?: string;
}

export interface UmbrelInstalledProvider {
  appId: string;
  implements?: string[];
}

export interface UmbrelV2Context {
  appId: string;
  paths: UmbrelV2Paths;
  installedApps: UmbrelInstalledProvider[];
  /** True when /dev/dri exists on the host. */
  hasDri: boolean;
}

// ── Plan types ───────────────────────────────────────────────────────────────

export interface UmbrelFolderSlot {
  id: string;
  name: string;
  note?: string;
  mounts: { service: string; targetPath: string; readOnly: boolean }[];
  /** Default host folder (from the compose file or Talome's configured media paths). */
  defaultSource: string;
  /** Effective host folder (user choice or default). */
  source: string;
  userSelected: boolean;
}

export interface UmbrelEnvironmentPlan {
  name: string;
  services: string[];
  default?: string;
  options?: string[];
  note?: string;
  /** Value that will be applied at runtime, if any. */
  value?: string;
  /** Where the value came from. `none` = compose file keeps its own value. */
  origin: "user" | "default" | "none";
}

export interface UmbrelDependencyResolution {
  dependency: string;
  provider: string | null;
  viaImplements: boolean;
}

export interface UmbrelV2Plan {
  supported: boolean;
  unsupportedReason?: string;
  /** Problems that must stop the install (invalid choices, unsupported app). */
  blockers: string[];
  warnings: string[];
  folders: UmbrelFolderSlot[];
  environment: UmbrelEnvironmentPlan[];
  /** Per-service environment additions for the compose file. */
  serviceEnv: Record<string, Record<string, string>>;
  /** Values that must also be available for `${VAR}` interpolation. */
  interpolationEnv: Record<string, string>;
  gpu: { requested: boolean; devices: string[] };
  requiresHttps: boolean;
  dataRoot: { declared: boolean; hostPath: string | null };
  dependencies: UmbrelDependencyResolution[];
  missingDependencies: string[];
  backupIgnore: string[];
  paths: UmbrelV2Paths;
  /** Host directories Talome should create before `docker compose up`. */
  ensureDirs: string[];
}

// ── Compose helpers ──────────────────────────────────────────────────────────

type ComposeDoc = Record<string, unknown>;
type ComposeService = Record<string, unknown>;

export const UMBREL_PROXY_SERVICE = "app_proxy";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getServices(compose: ComposeDoc | null | undefined): Record<string, ComposeService> {
  const services = compose?.services;
  if (!isRecord(services)) return {};
  const out: Record<string, ComposeService> = {};
  for (const [name, svc] of Object.entries(services)) {
    if (isRecord(svc)) out[name] = svc;
  }
  return out;
}

/** Services a user can configure (everything except Umbrel's app_proxy sidecar). */
export function getConfigurableServiceNames(compose: ComposeDoc | null | undefined): string[] {
  return Object.keys(getServices(compose)).filter((name) => name !== UMBREL_PROXY_SERVICE);
}

/** Split a short-syntax volume `src:target[:mode]`, ignoring colons inside `${…}`. */
export function splitVolumeSpec(spec: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < spec.length; i++) {
    const ch = spec[i];
    if (ch === "$" && spec[i + 1] === "{") {
      depth++;
      current += "${";
      i++;
      continue;
    }
    if (ch === "}" && depth > 0) depth--;
    if (ch === ":" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function normalizeTarget(target: string): string {
  const normalized = posix.normalize(target.trim());
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

interface ParsedMount {
  source: string | null;
  target: string;
  readOnly: boolean;
}

function parseVolume(volume: unknown): ParsedMount | null {
  if (typeof volume === "string") {
    const parts = splitVolumeSpec(volume);
    if (parts.length < 2) return { source: null, target: normalizeTarget(parts[0]), readOnly: false };
    const modes = (parts[2] ?? "").split(",").map((m) => m.trim());
    return { source: parts[0], target: normalizeTarget(parts[1]), readOnly: modes.includes("ro") };
  }
  if (isRecord(volume) && typeof volume.target === "string") {
    return {
      source: typeof volume.source === "string" ? volume.source : null,
      target: normalizeTarget(volume.target),
      readOnly: volume.read_only === true,
    };
  }
  return null;
}

function withMount(volume: unknown, source: string, readOnly: boolean): unknown {
  if (typeof volume === "string") {
    const parts = splitVolumeSpec(volume);
    const modes = (parts[2] ?? "")
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m && m !== "ro" && m !== "rw");
    if (readOnly) modes.unshift("ro");
    return [source, parts[1], ...(modes.length ? [modes.join(",")] : [])].join(":");
  }
  if (isRecord(volume)) {
    const next: Record<string, unknown> = { ...volume, source };
    if (readOnly) next.read_only = true;
    else delete next.read_only;
    return next;
  }
  return volume;
}

// ── ${UMBREL_ROOT} path mapping ──────────────────────────────────────────────

const UMBREL_ROOT_PREFIX = /^(?:\$\{UMBREL_ROOT\}|\$UMBREL_ROOT(?![A-Za-z0-9_]))/;

export type UmbrelRootKind = "downloads" | "home" | "app-data" | "other";

export interface UmbrelRootMapping {
  hostPath: string;
  kind: UmbrelRootKind;
  /** True when Talome had no configured folder and used an app-data fallback. */
  fallback: boolean;
}

/** Clamp a relative sub-path so it can never escape its base via `..`. */
function safeSubPath(rel: string): string {
  const normalized = posix.normalize(`/${rel}`);
  return normalized === "/" ? "" : normalized.slice(1);
}

function joinBase(base: string, sub: string): string {
  const cleanBase = base.length > 1 ? base.replace(/\/+$/, "") : base;
  return sub ? posix.join(cleanBase, sub) : cleanBase;
}

/**
 * Map an Umbrel host path (`${UMBREL_ROOT}/…`) onto Talome's folders.
 * Returns null when the source does not reference UMBREL_ROOT.
 */
export function mapUmbrelRootSource(source: string, paths: UmbrelV2Paths): UmbrelRootMapping | null {
  if (!UMBREL_ROOT_PREFIX.test(source)) return null;
  const rest = safeSubPath(source.replace(UMBREL_ROOT_PREFIX, ""));

  const downloads = rest.match(/^(?:data\/storage\/downloads|home\/Downloads)(?:\/(.*))?$/);
  if (downloads) {
    const sub = safeSubPath(downloads[1] ?? "");
    return paths.downloadsRoot
      ? { hostPath: joinBase(paths.downloadsRoot, sub), kind: "downloads", fallback: false }
      : { hostPath: joinBase(posix.join(paths.appDataDir, "downloads"), sub), kind: "downloads", fallback: true };
  }

  const home = rest.match(/^(?:home|data\/storage)(?:\/(.*))?$/);
  if (home) {
    const sub = safeSubPath(home[1] ?? "");
    return paths.mediaRoot
      ? { hostPath: joinBase(paths.mediaRoot, sub), kind: "home", fallback: false }
      : { hostPath: joinBase(posix.join(paths.appDataDir, "home"), sub), kind: "home", fallback: true };
  }

  const appData = rest.match(/^app-data\/([^/]+)(?:\/(.*))?$/);
  if (appData) {
    return {
      hostPath: joinBase(posix.join(paths.appDataParent, appData[1]), safeSubPath(appData[2] ?? "")),
      kind: "app-data",
      fallback: false,
    };
  }

  return { hostPath: joinBase(posix.join(paths.appDataDir, "umbrel-root"), rest), kind: "other", fallback: true };
}

// ── Host folder validation ───────────────────────────────────────────────────

const FORBIDDEN_HOST_PATHS = [
  "/", "/etc", "/proc", "/sys", "/dev", "/boot", "/root", "/bin", "/sbin",
  "/usr", "/lib", "/lib64", "/var/run", "/run", "/private/etc", "/System",
];

/** Validate a user-chosen host folder. Returns an error message or null. */
export function validateHostFolder(path: string): string | null {
  if (!path.startsWith("/")) return `"${path}" must be an absolute path`;
  if (path.includes("\0")) return "path contains a NUL byte";
  if (path.split("/").includes("..")) return `"${path}" must not contain ".."`;
  const normalized = normalizeTarget(path);
  if (FORBIDDEN_HOST_PATHS.includes(normalized)) return `"${path}" is a protected system folder`;
  if (normalized.endsWith("docker.sock")) return `"${path}" cannot be mounted`;
  return null;
}

// ── Folder defaults ──────────────────────────────────────────────────────────

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "folder";
}

function heuristicFolderDefault(
  folder: UmbrelFolderAccess,
  paths: UmbrelV2Paths,
): { path: string; configured: boolean } {
  const text = `${folder.id} ${folder.name} ${folder.mounts.map((m) => m.targetPath).join(" ")}`.toLowerCase();
  const fallback = posix.join(paths.appDataDir, "folders", sanitizeSegment(folder.id));
  if (/download|torrent/.test(text)) {
    return paths.downloadsRoot ? { path: paths.downloadsRoot, configured: true } : { path: fallback, configured: false };
  }
  if (/book|comic|manga/.test(text)) {
    const root = paths.booksRoot ?? paths.mediaRoot;
    return root ? { path: root, configured: true } : { path: fallback, configured: false };
  }
  if (/media|movie|film|tv|show|series|music|audio|photo|picture|image|video|librar|podcast|original|gallery/.test(text)) {
    return paths.mediaRoot ? { path: paths.mediaRoot, configured: true } : { path: fallback, configured: false };
  }
  return { path: fallback, configured: false };
}

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface UmbrelDependencyResult {
  resolutions: UmbrelDependencyResolution[];
  missing: string[];
  blockers: string[];
  warnings: string[];
}

/**
 * Resolve declared dependencies against installed apps. A dependency is met by
 * an installed app with the same id, or by one whose manifest `implements` it.
 * Explicit selections (dependency → provider) are validated.
 */
export function resolveUmbrelDependencies(
  dependencies: string[] | undefined,
  installed: UmbrelInstalledProvider[],
  selections: Record<string, string> = {},
): UmbrelDependencyResult {
  const result: UmbrelDependencyResult = { resolutions: [], missing: [], blockers: [], warnings: [] };
  const byId = new Map(installed.map((app) => [app.appId, app]));

  for (const dependency of [...new Set(dependencies ?? [])]) {
    const selected = selections[dependency];
    if (selected) {
      const provider = byId.get(selected);
      if (!provider) {
        result.blockers.push(`Dependency provider "${selected}" selected for "${dependency}" is not installed.`);
      } else if (selected !== dependency && !provider.implements?.includes(dependency)) {
        result.blockers.push(`"${selected}" does not implement "${dependency}".`);
      } else {
        result.resolutions.push({ dependency, provider: selected, viaImplements: selected !== dependency });
      }
      continue;
    }

    if (byId.has(dependency)) {
      result.resolutions.push({ dependency, provider: dependency, viaImplements: false });
      continue;
    }

    const alternatives = installed
      .filter((app) => app.implements?.includes(dependency))
      .map((app) => app.appId)
      .sort();
    if (alternatives.length > 0) {
      result.resolutions.push({ dependency, provider: alternatives[0], viaImplements: true });
      if (alternatives.length > 1) {
        result.warnings.push(
          `Several installed apps provide "${dependency}" (${alternatives.join(", ")}); using "${alternatives[0]}".`,
        );
      }
      continue;
    }

    result.resolutions.push({ dependency, provider: null, viaImplements: false });
    result.missing.push(dependency);
  }

  for (const key of Object.keys(selections)) {
    if (!(dependencies ?? []).includes(key)) {
      result.warnings.push(`Ignoring dependency selection for "${key}" — the app does not declare it.`);
    }
  }

  return result;
}

// ── backupIgnore ─────────────────────────────────────────────────────────────

/**
 * Normalise backupIgnore patterns: relative to the app data directory, never
 * absolute and never escaping it. Invalid entries are dropped.
 */
export function normalizeBackupIgnore(patterns: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of patterns ?? []) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim().replace(/^\.\//, "");
    if (!trimmed || trimmed.startsWith("/") || trimmed.split("/").includes("..")) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

// ── Compose interpolation helpers ────────────────────────────────────────────

const INTERPOLATION_REGEX = /\$\{([A-Za-z_][A-Za-z0-9_]*)((?::?[-?+])[^}]*)?\}/g;

/**
 * Braced variables a compose document interpolates without a fallback value —
 * the same ones Talome's install pre-validation refuses to leave unset.
 * `${VAR:-default}`, `${VAR+alt}` and `$$` escapes are not reported; bare
 * `$VAR` only produces a compose warning, so it is not reported either.
 */
export function findRequiredComposeVars(compose: unknown): string[] {
  const raw = JSON.stringify(compose ?? {}).replace(/\$\$/g, "");
  const vars = new Set<string>();
  let m: RegExpExecArray | null;
  INTERPOLATION_REGEX.lastIndex = 0;
  while ((m = INTERPOLATION_REGEX.exec(raw)) !== null) {
    const name = m[1];
    const modifier = m[2] ?? "";
    if (modifier.startsWith("-") || modifier.startsWith(":-") || modifier.startsWith("+") || modifier.startsWith(":+")) continue;
    vars.add(name);
  }
  return [...vars];
}

/** Variables Talome provides for every Umbrel app (see compose-exec buildEnv / generateUmbrelPlatformEnv). */
export function isTalomeProvidedUmbrelVar(name: string): boolean {
  return (
    [
      "APP_DATA_DIR", "APP_ID", "AppID", "PUID", "PGID", "TZ",
      "APP_PASSWORD", "APP_SEED", "DEVICE_DOMAIN_NAME", "DEVICE_HOSTNAME", "APP_DOMAIN",
    ].includes(name) ||
    /^APP_.*_KEY$/.test(name) ||
    /^APP_.*_SECRET$/.test(name)
  );
}

// ── Planning ─────────────────────────────────────────────────────────────────

export const GPU_UNAVAILABLE_WARNING =
  "This app requests GPU access but /dev/dri was not found; it will run without GPU acceleration.";

/**
 * Build the install plan for an Umbrel app from its (possibly absent) v2
 * metadata, its compose document and the user's install options.
 */
export function planUmbrelV2Install(
  meta: UmbrelV2Meta | null | undefined,
  compose: ComposeDoc | null | undefined,
  options: UmbrelInstallOptions | null | undefined,
  ctx: UmbrelV2Context,
): UmbrelV2Plan {
  const m: UmbrelV2Meta = meta ?? {};
  const opts: UmbrelInstallOptions = options ?? {};
  const services = getServices(compose);
  const serviceNames = getConfigurableServiceNames(compose);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const ensureDirs = new Set<string>();

  const plan: UmbrelV2Plan = {
    supported: true,
    blockers,
    warnings,
    folders: [],
    environment: [],
    serviceEnv: {},
    interpolationEnv: {},
    gpu: { requested: false, devices: [] },
    requiresHttps: m.requiresHttps === true,
    dataRoot: { declared: m.storage?.dataRoot === "data", hostPath: null },
    dependencies: [],
    missingDependencies: [],
    backupIgnore: normalizeBackupIgnore(m.backupIgnore),
    paths: ctx.paths,
    ensureDirs: [],
  };

  // torOnly — Talome has no Tor integration
  if (m.torOnly === true) {
    plan.supported = false;
    plan.unsupportedReason =
      "This app is Tor-only (torOnly: true). Talome does not run a Tor hidden service, so the app would be unreachable.";
    blockers.push(plan.unsupportedReason);
  }

  if (m.disabled === true) {
    warnings.push("The app store has marked this app as disabled; it may be deprecated or broken.");
  }

  if (plan.requiresHttps) {
    warnings.push("This app requires HTTPS; Talome's reverse proxy must serve it over TLS.");
  }

  // ── folderAccess ───────────────────────────────────────────────────────
  const composeMounts = new Map<string, ParsedMount>();
  for (const [name, svc] of Object.entries(services)) {
    if (!Array.isArray(svc.volumes)) continue;
    for (const volume of svc.volumes) {
      const parsed = parseVolume(volume);
      if (parsed) composeMounts.set(`${name}\u0000${parsed.target}`, parsed);
    }
  }

  const seenSlots = new Set<string>();
  const seenMountKeys = new Set<string>();
  for (const folder of m.folderAccess ?? []) {
    if (seenSlots.has(folder.id)) {
      warnings.push(`Duplicate folderAccess id "${folder.id}" ignored.`);
      continue;
    }
    const mounts: UmbrelFolderSlot["mounts"] = [];
    let invalid: string | null = null;
    for (const declared of folder.mounts) {
      const service = declared.service ?? (serviceNames.length === 1 ? serviceNames[0] : "");
      if (!serviceNames.includes(service)) {
        invalid = declared.service
          ? `service "${declared.service}" does not exist`
          : "mount has no service and the app has several services";
        break;
      }
      if (!declared.targetPath.startsWith("/")) {
        invalid = `target "${declared.targetPath}" is not absolute`;
        break;
      }
      const targetPath = normalizeTarget(declared.targetPath);
      const key = `${service}\u0000${targetPath}`;
      if (seenMountKeys.has(key) || mounts.some((mt) => mt.service === service && mt.targetPath === targetPath)) {
        invalid = `target "${targetPath}" is mounted twice`;
        break;
      }
      const existing = composeMounts.get(key);
      mounts.push({ service, targetPath, readOnly: declared.readOnly ?? existing?.readOnly ?? false });
    }
    if (invalid) {
      warnings.push(`Folder "${folder.name}" skipped: ${invalid}.`);
      continue;
    }
    seenSlots.add(folder.id);
    for (const mt of mounts) seenMountKeys.add(`${mt.service}\u0000${mt.targetPath}`);

    // Default: the compose file's own mount source (mapped when it is an
    // Umbrel path), else Talome's configured media/download folders.
    let defaultSource: string | null = null;
    let defaultConfigured = true;
    const composeSources = mounts
      .map((mt) => composeMounts.get(`${mt.service}\u0000${mt.targetPath}`)?.source ?? null)
      .filter((s): s is string => !!s);
    if (composeSources.length === mounts.length && composeSources.every((s) => s === composeSources[0])) {
      const mapped = mapUmbrelRootSource(composeSources[0], ctx.paths);
      defaultSource = mapped ? mapped.hostPath : composeSources[0];
      if (mapped?.fallback) defaultConfigured = false;
    }
    if (!defaultSource) {
      const heuristic = heuristicFolderDefault(folder, ctx.paths);
      defaultSource = heuristic.path;
      defaultConfigured = heuristic.configured;
    }

    const chosen = opts.folders?.[folder.id];
    let source = defaultSource;
    let userSelected = false;
    if (chosen !== undefined) {
      const error = validateHostFolder(chosen);
      if (error) {
        blockers.push(`Folder "${folder.name}": ${error}.`);
      } else {
        source = normalizeTarget(chosen);
        userSelected = true;
      }
    } else if (!defaultConfigured) {
      warnings.push(
        `Folder "${folder.name}" defaults to ${defaultSource} — choose a folder at install time to use your own files.`,
      );
      ensureDirs.add(defaultSource);
    }

    plan.folders.push({
      id: folder.id,
      name: folder.name,
      ...(folder.note ? { note: folder.note } : {}),
      mounts,
      defaultSource,
      source,
      userSelected,
    });
  }
  for (const id of Object.keys(opts.folders ?? {})) {
    if (!seenSlots.has(id)) warnings.push(`Ignoring folder selection "${id}" — the app does not declare it.`);
  }

  // ── environment ────────────────────────────────────────────────────────
  const requiredVars = new Set(findRequiredComposeVars(compose));
  const seenEnv = new Set<string>();
  for (const input of m.environment ?? []) {
    if (seenEnv.has(input.name)) {
      warnings.push(`Duplicate environment variable "${input.name}" ignored.`);
      continue;
    }
    const envServices = [...new Set(input.services)];
    const unknown = envServices.filter((s) => !serviceNames.includes(s));
    if (unknown.length > 0) {
      warnings.push(`Environment variable "${input.name}" skipped: unknown service(s) ${unknown.join(", ")}.`);
      continue;
    }
    seenEnv.add(input.name);

    if (input.default !== undefined && input.options && !input.options.includes(input.default)) {
      warnings.push(`Default for "${input.name}" is not one of its allowed options.`);
    }

    const entry: UmbrelEnvironmentPlan = {
      name: input.name,
      services: envServices,
      ...(input.default !== undefined ? { default: input.default } : {}),
      ...(input.options ? { options: input.options } : {}),
      ...(input.note ? { note: input.note } : {}),
      origin: "none",
    };

    const userValue = opts.environment?.[input.name];
    if (userValue !== undefined) {
      if (input.options && !input.options.includes(userValue)) {
        blockers.push(
          `"${userValue}" is not an allowed value for ${input.name} (allowed: ${input.options.join(", ")}).`,
        );
      } else {
        entry.value = userValue;
        entry.origin = "user";
      }
    } else if (input.default !== undefined && requiredVars.has(input.name)) {
      // Defaults are placeholders — only applied when the compose file would
      // otherwise interpolate an unset variable.
      entry.value = input.default;
      entry.origin = "default";
    }

    if (entry.value !== undefined) {
      for (const service of envServices) {
        plan.serviceEnv[service] = { ...(plan.serviceEnv[service] ?? {}), [input.name]: entry.value };
      }
      plan.interpolationEnv[input.name] = entry.value;
    }
    plan.environment.push(entry);
  }
  for (const name of Object.keys(opts.environment ?? {})) {
    if (!seenEnv.has(name)) warnings.push(`Ignoring environment choice "${name}" — the app does not expose it.`);
  }

  // ── GPU ────────────────────────────────────────────────────────────────
  const gpuRequested = (m.permissions ?? []).some((p) => p.toUpperCase() === "GPU");
  if (gpuRequested) {
    plan.gpu.requested = true;
    if (ctx.hasDri) {
      plan.gpu.devices = ["/dev/dri:/dev/dri"];
    } else {
      warnings.push(GPU_UNAVAILABLE_WARNING);
    }
  }

  // ── storage.dataRoot ───────────────────────────────────────────────────
  if (opts.dataRoot !== undefined) {
    if (!plan.dataRoot.declared) {
      warnings.push("Ignoring data folder choice — this app does not declare a movable data root.");
    } else {
      const error = validateHostFolder(opts.dataRoot);
      if (error) blockers.push(`Data folder: ${error}.`);
      else {
        plan.dataRoot.hostPath = normalizeTarget(opts.dataRoot);
        ensureDirs.add(plan.dataRoot.hostPath);
      }
    }
  }

  // ── dependencies / implements ──────────────────────────────────────────
  const deps = resolveUmbrelDependencies(m.dependencies, ctx.installedApps, opts.dependencies);
  plan.dependencies = deps.resolutions;
  plan.missingDependencies = deps.missing;
  blockers.push(...deps.blockers);
  warnings.push(...deps.warnings);

  // ── ${UMBREL_ROOT} sources — create fallback folders ───────────────────
  for (const [name, svc] of Object.entries(services)) {
    if (name === UMBREL_PROXY_SERVICE || !Array.isArray(svc.volumes)) continue;
    for (const volume of svc.volumes) {
      const parsed = parseVolume(volume);
      if (!parsed?.source) continue;
      const mapped = mapUmbrelRootSource(parsed.source, ctx.paths);
      if (!mapped) continue;
      if (mapped.fallback) ensureDirs.add(mapped.hostPath);
      if (mapped.kind === "other") {
        warnings.push(`Umbrel path ${parsed.source} has no Talome equivalent; using ${mapped.hostPath}.`);
      }
    }
  }

  plan.ensureDirs = [...ensureDirs];
  return plan;
}

// ── Applying ─────────────────────────────────────────────────────────────────

const APP_DATA_DATA_PREFIX = /^(?:\$\{APP_DATA_DIR\}|\$APP_DATA_DIR(?![A-Za-z0-9_]))\/data(?=\/|$)/;

function rewriteSource(source: string, plan: UmbrelV2Plan): string {
  const mapped = mapUmbrelRootSource(source, plan.paths);
  if (mapped) return mapped.hostPath;
  if (plan.dataRoot.hostPath && APP_DATA_DATA_PREFIX.test(source)) {
    const sub = safeSubPath(source.replace(APP_DATA_DATA_PREFIX, ""));
    return joinBase(plan.dataRoot.hostPath, sub);
  }
  return source;
}

function setServiceEnv(svc: ComposeService, values: Record<string, string>): void {
  const env = svc.environment;
  if (Array.isArray(env)) {
    const next = env.filter((entry) => {
      if (typeof entry !== "string") return true;
      const key = entry.split("=")[0];
      return !(key in values);
    });
    for (const [key, value] of Object.entries(values)) next.push(`${key}=${value}`);
    svc.environment = next;
    return;
  }
  svc.environment = { ...(isRecord(env) ? env : {}), ...values };
}

/**
 * Apply a plan to a compose document. Returns a new document; the input is not
 * mutated. `changed` is false when the plan had nothing to apply.
 */
export function applyUmbrelV2Plan(
  compose: ComposeDoc,
  plan: UmbrelV2Plan,
): { compose: ComposeDoc; changed: boolean } {
  const doc = structuredClone(compose) as ComposeDoc;
  const services = getServices(doc);
  const before = JSON.stringify(doc);

  const mountsByService = new Map<string, { target: string; source: string; readOnly: boolean }[]>();
  for (const folder of plan.folders) {
    for (const mount of folder.mounts) {
      const list = mountsByService.get(mount.service) ?? [];
      list.push({ target: mount.targetPath, source: folder.source, readOnly: mount.readOnly });
      mountsByService.set(mount.service, list);
    }
  }

  for (const [name, svc] of Object.entries(services)) {
    if (name === UMBREL_PROXY_SERVICE) continue;

    // Volumes: map Umbrel paths, redirect the data root, apply folder choices.
    const folderMounts = mountsByService.get(name) ?? [];
    const applied = new Set<string>();
    if (Array.isArray(svc.volumes) || folderMounts.length > 0) {
      const volumes = Array.isArray(svc.volumes) ? svc.volumes : [];
      const next = volumes.map((volume) => {
        const parsed = parseVolume(volume);
        if (!parsed) return volume;
        const folder = folderMounts.find((fm) => fm.target === parsed.target);
        if (folder) {
          applied.add(folder.target);
          return withMount(volume, folder.source, folder.readOnly);
        }
        if (!parsed.source) return volume;
        const rewritten = rewriteSource(parsed.source, plan);
        return rewritten === parsed.source ? volume : withMount(volume, rewritten, parsed.readOnly);
      });
      for (const fm of folderMounts) {
        if (!applied.has(fm.target)) next.push(`${fm.source}:${fm.target}${fm.readOnly ? ":ro" : ""}`);
      }
      if (next.length > 0) svc.volumes = next;
    }

    const env = plan.serviceEnv[name];
    if (env && Object.keys(env).length > 0) setServiceEnv(svc, env);

    if (plan.gpu.devices.length > 0) {
      const devices = Array.isArray(svc.devices) ? [...svc.devices] : [];
      for (const device of plan.gpu.devices) {
        const hostSide = device.split(":")[0];
        if (!devices.some((d) => typeof d === "string" && d.split(":")[0] === hostSide)) devices.push(device);
      }
      svc.devices = devices;
    }
  }

  return { compose: doc, changed: JSON.stringify(doc) !== before };
}

// ── Compose validation (structural, no Docker) ───────────────────────────────

/**
 * Structural validation of a transformed compose document. Returns a list of
 * problems (empty = valid). `isProvided` decides whether an interpolated
 * variable will be available at `docker compose up` time.
 */
export function validateTransformedCompose(
  compose: unknown,
  isProvided: (name: string) => boolean = isTalomeProvidedUmbrelVar,
): string[] {
  const issues: string[] = [];
  if (!isRecord(compose)) return ["compose is not a mapping"];
  const services = getServices(compose);
  const names = Object.keys(services);
  if (names.length === 0) return ["compose has no services"];
  if (names.includes(UMBREL_PROXY_SERVICE)) issues.push("app_proxy sidecar still present");

  const namedVolumes = isRecord(compose.volumes) ? Object.keys(compose.volumes) : [];

  for (const [name, svc] of Object.entries(services)) {
    if (typeof svc.image !== "string" && svc.build === undefined) issues.push(`service "${name}" has no image or build`);
    if (svc.volumes !== undefined && !Array.isArray(svc.volumes)) issues.push(`service "${name}" volumes is not a list`);
    for (const volume of Array.isArray(svc.volumes) ? svc.volumes : []) {
      const parsed = parseVolume(volume);
      if (!parsed) {
        issues.push(`service "${name}" has an unreadable volume entry`);
        continue;
      }
      if (!parsed.target.startsWith("/")) issues.push(`service "${name}" volume target "${parsed.target}" is not absolute`);
      const src = parsed.source;
      if (src === null) continue;
      if (UMBREL_ROOT_PREFIX.test(src)) issues.push(`service "${name}" still references UMBREL_ROOT`);
      else if (!src.startsWith("/") && !src.startsWith("$") && !src.startsWith(".") && !src.startsWith("~") && !namedVolumes.includes(src)) {
        issues.push(`service "${name}" uses undeclared named volume "${src}"`);
      }
    }
    if (svc.devices !== undefined && !Array.isArray(svc.devices)) issues.push(`service "${name}" devices is not a list`);
  }

  const missing = findRequiredComposeVars(compose).filter((v) => !isProvided(v));
  if (missing.length > 0) issues.push(`unresolved variables: ${missing.sort().join(", ")}`);
  return issues;
}

/**
 * Minimal Umbrel → Talome compose preparation used by the compatibility suite
 * and report: drops the app_proxy sidecar and its depends_on edges (the full
 * install path does this in compose-pipeline's sanitizeUmbrelCompose).
 */
export function stripUmbrelProxy(compose: ComposeDoc): ComposeDoc {
  const doc = structuredClone(compose) as ComposeDoc;
  const services = isRecord(doc.services) ? (doc.services as Record<string, unknown>) : null;
  if (!services) return doc;
  delete services[UMBREL_PROXY_SERVICE];
  for (const svc of Object.values(services)) {
    if (!isRecord(svc)) continue;
    const deps = svc.depends_on;
    if (Array.isArray(deps)) {
      const next = deps.filter((d) => d !== UMBREL_PROXY_SERVICE);
      if (next.length > 0) svc.depends_on = next;
      else delete svc.depends_on;
    } else if (isRecord(deps) && UMBREL_PROXY_SERVICE in deps) {
      delete deps[UMBREL_PROXY_SERVICE];
      if (Object.keys(deps).length === 0) delete svc.depends_on;
    }
  }
  delete doc.version;
  return doc;
}
