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
import { homedir } from "node:os";
import { posix } from "node:path";
import { z } from "zod";

// ── Manifest field schemas (shared with the Umbrel adapter) ──────────────────

export const UMBREL_NOTE_MAX_LENGTH = 300;
export const ENV_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Notes are shown in the install UI — keep them short (ellipsis past the limit). */
function clampNote(note: string): string | undefined {
  const text = note.trim();
  if (text.length === 0) return undefined;
  if (text.length <= UMBREL_NOTE_MAX_LENGTH) return text;
  const words = text.slice(0, UMBREL_NOTE_MAX_LENGTH - 1).replace(/\s+$/, "");
  return `${words}\u2026`;
}

const noteSchema = z
  .string()
  .transform(clampNote)
  .optional();

/** Manifest YAML may carry unquoted numbers/booleans where strings are meant. */
export function scalarToString(value: unknown): unknown {
  switch (typeof value) {
    case "number":
    case "boolean":
      return `${value}`;
    default:
      return value;
  }
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
    .refine((options) => !options.some((opt, i) => options.indexOf(opt) !== i), {
      message: "duplicate value in options list",
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
  /** Host trees user choices may not point into (Talome's home, the store cache…). */
  protectedTrees?: string[];
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
  /**
   * True when the default is one of the user's shared roots (media/downloads)
   * suggested by keyword: it is mounted read-only until the user picks it.
   */
  sharedDefault?: boolean;
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
  /** `services` = the services that get the devices (databases/caches are left out). */
  gpu: { requested: boolean; devices: string[]; services: string[] };
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

/** Names of the app's own services — Umbrel's app_proxy sidecar is not one of them. */
export function listAppServices(compose: ComposeDoc | null | undefined): string[] {
  const names: string[] = [];
  for (const name of Object.keys(getServices(compose))) {
    if (name !== UMBREL_PROXY_SERVICE) names.push(name);
  }
  return names;
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

/**
 * Replace a volume's host source. Anonymous volumes (`- /library`) keep their
 * target, and long-syntax entries become `type: bind` when the new source is a
 * host path (docker rejects a host path on a `type: volume` entry).
 */
function withMount(volume: unknown, source: string, readOnly: boolean): unknown {
  if (typeof volume === "string") {
    const parts = splitVolumeSpec(volume);
    const target = parts.length < 2 ? parts[0] : parts[1];
    const modeList = parts.length < 3 ? [] : parts[2].split(",");
    const modes = modeList.map((m) => m.trim()).filter((m) => m && m !== "ro" && m !== "rw");
    if (readOnly) modes.unshift("ro");
    return [source, target, ...(modes.length ? [modes.join(",")] : [])].join(":");
  }
  if (isRecord(volume)) {
    const next: Record<string, unknown> = { ...volume, source };
    if (source.startsWith("/") || source.startsWith("$")) {
      next.type = "bind";
      delete next.volume;
    }
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

/** System folders an app may never be given — neither the folder itself nor anything below it. */
const PROTECTED_HOST_TREES = [
  "/etc", "/proc", "/sys", "/dev", "/boot", "/root", "/bin", "/sbin", "/usr", "/lib", "/lib32",
  "/lib64", "/libx32", "/var/run", "/run", "/var/lib/docker", "/var/lib/containerd", "/snap",
  "/private/etc", "/private/var/run", "/private/var/root", "/private/var/db", "/System", "/Library",
  "/Applications", "/cores",
];

/** Credential/config folders that must never be handed to an app, wherever they live. */
const PROTECTED_SEGMENTS = new Set([".ssh", ".gnupg", ".aws", ".kube", ".docker", ".talome"]);

/** Folders whose children are user homes (`/home/<user>`, `/Users/<user>`). */
const HOME_PARENTS = ["/home", "/users", "/var/home"];
/** Children of HOME_PARENTS that are shared folders, not a user's home. */
const SHARED_HOME_CHILDREN = new Set(["/users/shared"]);

function isSameOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

/**
 * A user's whole home folder, or anything above one. Homes hold credentials
 * and dotfiles (.ssh, .talome, shell history…) that no app may be handed;
 * a folder inside a home (~/Movies) is fine. `folded` is lower-case.
 */
function isHomeOrAbove(folded: string): boolean {
  let home = "";
  try {
    home = normalizeTarget(homedir()).toLowerCase();
  } catch {
    home = "";
  }
  if (home.startsWith("/") && home !== "/" && isSameOrUnder(home, folded)) return true;
  if (SHARED_HOME_CHILDREN.has(folded)) return false;
  return HOME_PARENTS.some((parent) => folded === parent || posix.dirname(folded) === parent);
}

export interface HostFolderPolicy {
  /** Extra trees to protect (Talome's own data directory, the store cache…). */
  protectedTrees?: string[];
  /** Trees that stay allowed even when inside a protected tree (the app's own data dir). */
  allowedTrees?: string[];
}

/** The policy user choices for an app are checked against: its own data dir stays allowed. */
export function hostFolderPolicyFor(paths: UmbrelV2Paths): HostFolderPolicy {
  return { protectedTrees: paths.protectedTrees, allowedTrees: [paths.appDataDir] };
}

/** Validate a user-chosen host folder. Returns an error message or null. */
export function validateHostFolder(path: string, policy: HostFolderPolicy = {}): string | null {
  if (!path.startsWith("/")) return `"${path}" must be an absolute path`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return "path contains control characters";
  // ":" and "," change how docker parses a short-syntax volume spec.
  if (/[:,]/.test(path)) return `"${path}" must not contain ":" or ","`;
  if (path.split("/").includes("..")) return `"${path}" must not contain ".."`;
  const normalized = normalizeTarget(path);
  if (normalized === "/") return `"${path}" is a protected system folder`;
  if (/(^|\/)docker\.sock$/.test(normalized)) return `"${path}" cannot be mounted`;
  const allowed = (policy.allowedTrees ?? [])
    .filter((root) => root.startsWith("/"))
    .some((root) => isSameOrUnder(normalized, normalizeTarget(root)));
  if (allowed) return null;
  // Compare case-insensitively: macOS volumes usually are (/home/u/.SSH is
  // ~/.ssh there), and refusing a differently-cased twin costs nothing elsewhere.
  const folded = normalized.toLowerCase();
  if (folded.split("/").some((segment) => PROTECTED_SEGMENTS.has(segment))) {
    return `"${path}" is a protected folder`;
  }
  const extra = (policy.protectedTrees ?? []).filter((root) => root.startsWith("/")).map(normalizeTarget);
  const roots = [...PROTECTED_HOST_TREES, ...extra].map((root) => root.toLowerCase());
  if (roots.some((root) => isSameOrUnder(folded, root))) {
    return `"${path}" is a protected system folder`;
  }
  // A folder above a protected tree hands the app that tree too (/var holds
  // /var/lib/docker, Talome's home holds its database and secrets).
  if (roots.some((root) => isSameOrUnder(root, folded))) {
    return `"${path}" contains a protected folder`;
  }
  if (isHomeOrAbove(folded)) {
    return `"${path}" is a home folder, which holds protected credentials — choose a folder inside it`;
  }
  return null;
}

// ── Folder defaults ──────────────────────────────────────────────────────────

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "folder";
}

/**
 * Suggested host folder for a slot the compose file does not mount. A
 * `configured` suggestion points at one of the user's shared roots, so the
 * planner only ever grants it read-only until the user picks it explicitly.
 */
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

export const REQUIRES_HTTPS_WARNING =
  "This app requires HTTPS. Open it through Talome's reverse proxy (its route is served over TLS); plain http://host:port access may not work.";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function mountKey(service: string, target: string): string {
  return `${service}\u0000${target}`;
}

/**
 * Resolve a folderAccess slot's declared mounts to concrete service/target
 * pairs. A mount without a service applies to the app's only service. Returns
 * an error when the slot cannot be mounted as declared.
 */
function resolveSlotMounts(
  folder: UmbrelFolderAccess,
  serviceNames: string[],
  composeMounts: Map<string, ParsedMount>,
  claimed: Set<string>,
): { mounts: UmbrelFolderSlot["mounts"] } | { error: string } {
  const mounts: UmbrelFolderSlot["mounts"] = [];
  const own = new Set<string>();
  for (const declared of folder.mounts) {
    let service = declared.service;
    if (!service) {
      if (serviceNames.length !== 1) return { error: "mount has no service and the app has several services" };
      service = serviceNames[0];
    }
    if (!serviceNames.includes(service)) return { error: `service "${service}" does not exist` };
    if (!declared.targetPath.startsWith("/")) return { error: `target "${declared.targetPath}" is not absolute` };
    const targetPath = normalizeTarget(declared.targetPath);
    const key = mountKey(service, targetPath);
    if (claimed.has(key) || own.has(key)) return { error: `target "${targetPath}" is mounted twice` };
    own.add(key);
    // Manifest readOnly wins; otherwise keep whatever the compose mount says.
    const readOnly = declared.readOnly !== undefined ? declared.readOnly : composeMounts.get(key)?.readOnly === true;
    mounts.push({ service, targetPath, readOnly });
  }
  return { mounts };
}

const APP_DATA_DATA_PREFIX = /^(?:\$\{APP_DATA_DIR\}|\$APP_DATA_DIR(?![A-Za-z0-9_]))\/data(?=\/|$)/;

/** Move a `${APP_DATA_DIR}/data…` source under the user's chosen data root. */
function redirectDataRoot(source: string, dataRootHost: string | null): string {
  if (!dataRootHost || !APP_DATA_DATA_PREFIX.test(source)) return source;
  return joinBase(dataRootHost, safeSubPath(source.replace(APP_DATA_DATA_PREFIX, "")));
}

/** Database/cache images never need the GPU — keep /dev/dri away from them. */
const NON_GPU_IMAGE = /(^|[/_-])(postgres|postgresql|pgvecto-rs|mariadb|mysql|mongo|redis|valkey|memcached|keydb|dragonfly|clickhouse|elasticsearch|opensearch)([:@/_-]|$)/i;

function pickGpuServices(services: Record<string, ComposeService>, serviceNames: string[]): string[] {
  const picked = serviceNames.filter((name) => {
    const image = services[name]?.image;
    return !(typeof image === "string" && NON_GPU_IMAGE.test(image));
  });
  return picked.length > 0 ? picked : serviceNames;
}

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
  const serviceNames = listAppServices(compose);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const ensureDirs = new Set<string>();
  const folderPolicy = hostFolderPolicyFor(ctx.paths);

  const plan: UmbrelV2Plan = {
    supported: true,
    blockers,
    warnings,
    folders: [],
    environment: [],
    serviceEnv: {},
    interpolationEnv: {},
    gpu: { requested: false, devices: [], services: [] },
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
    warnings.push(REQUIRES_HTTPS_WARNING);
  }

  // ── storage.dataRoot (first: folder defaults under the data root follow it) ──
  if (opts.dataRoot !== undefined) {
    if (!plan.dataRoot.declared) {
      warnings.push("Ignoring data folder choice — this app does not declare a movable data root.");
    } else {
      const error = validateHostFolder(opts.dataRoot, folderPolicy);
      if (error) blockers.push(`Data folder: ${error}.`);
      else {
        plan.dataRoot.hostPath = normalizeTarget(opts.dataRoot);
        ensureDirs.add(plan.dataRoot.hostPath);
      }
    }
  }

  // ── folderAccess ───────────────────────────────────────────────────────
  const composeMounts = new Map<string, ParsedMount>();
  for (const [name, svc] of Object.entries(services)) {
    if (!Array.isArray(svc.volumes)) continue;
    for (const volume of svc.volumes) {
      const parsed = parseVolume(volume);
      if (parsed) composeMounts.set(mountKey(name, parsed.target), parsed);
    }
  }

  const claimedMounts = new Set<string>();
  const slotIds = new Set<string>();
  for (const folder of m.folderAccess ?? []) {
    if (slotIds.has(folder.id)) {
      warnings.push(`Duplicate folderAccess id "${folder.id}" ignored.`);
      continue;
    }
    const resolved = resolveSlotMounts(folder, serviceNames, composeMounts, claimedMounts);
    if ("error" in resolved) {
      warnings.push(`Folder "${folder.name}" skipped: ${resolved.error}.`);
      continue;
    }
    const mounts = resolved.mounts;
    slotIds.add(folder.id);
    for (const mt of mounts) claimedMounts.add(mountKey(mt.service, mt.targetPath));

    // Default: the compose file's own mount source when every mount of the
    // slot agrees on one (mapped from Umbrel paths and moved with the data
    // root), else a suggestion based on Talome's configured folders.
    const composeSources = new Set(
      mounts.map((mt) => composeMounts.get(mountKey(mt.service, mt.targetPath))?.source ?? ""),
    );
    const [onlySource] = [...composeSources];
    let defaultSource: string;
    let defaultIsFallback = false;
    let sharedDefault = false;
    if (composeSources.size === 1 && onlySource) {
      const mapped = mapUmbrelRootSource(onlySource, ctx.paths);
      defaultSource = mapped ? mapped.hostPath : redirectDataRoot(onlySource, plan.dataRoot.hostPath);
      defaultIsFallback = mapped?.fallback === true;
    } else {
      const suggestion = heuristicFolderDefault(folder, ctx.paths);
      defaultSource = suggestion.path;
      defaultIsFallback = !suggestion.configured;
      sharedDefault = suggestion.configured;
    }

    const chosen = opts.folders?.[folder.id];
    let source = defaultSource;
    let userSelected = false;
    if (chosen !== undefined) {
      const error = validateHostFolder(chosen, folderPolicy);
      if (error) {
        blockers.push(`Folder "${folder.name}": ${error}.`);
      } else {
        source = normalizeTarget(chosen);
        userSelected = true;
      }
    } else if (sharedDefault) {
      // Never hand a whole shared library to an app with write access unasked.
      for (const mt of mounts) mt.readOnly = true;
      warnings.push(
        `Folder "${folder.name}" is mounted read-only from ${defaultSource}. Choose a folder at install time to give the app write access.`,
      );
    } else if (defaultIsFallback) {
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
      ...(sharedDefault && !userSelected ? { sharedDefault: true } : {}),
    });
  }
  for (const id of Object.keys(opts.folders ?? {})) {
    if (!slotIds.has(id)) warnings.push(`Ignoring folder selection "${id}" — the app does not declare it.`);
  }

  // ── environment ────────────────────────────────────────────────────────
  const requiredVars = new Set(findRequiredComposeVars(compose));
  const envNames = new Set<string>();
  for (const input of m.environment ?? []) {
    if (envNames.has(input.name)) {
      warnings.push(`Duplicate environment variable "${input.name}" ignored.`);
      continue;
    }
    const envServices = [...new Set(input.services)];
    const unknown = envServices.filter((s) => !serviceNames.includes(s));
    if (unknown.length > 0) {
      warnings.push(`Environment variable "${input.name}" skipped: unknown service(s) ${unknown.join(", ")}.`);
      continue;
    }
    envNames.add(input.name);

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
      } else if (CONTROL_CHARS.test(userValue)) {
        blockers.push(`The value for ${input.name} must not contain line breaks or control characters.`);
      } else {
        // An explicit choice is set on the listed services (overriding the
        // compose file's own value) and is also available for interpolation.
        entry.value = userValue;
        entry.origin = "user";
        for (const service of envServices) {
          plan.serviceEnv[service] = { ...(plan.serviceEnv[service] ?? {}), [input.name]: userValue };
        }
        plan.interpolationEnv[input.name] = userValue;
      }
    } else if (input.default !== undefined && requiredVars.has(input.name)) {
      // Defaults only fill a `${NAME}` the compose file would otherwise leave
      // unset. They go through interpolation — never baked into the compose —
      // so the install `env` parameter or a later .env edit still wins.
      entry.value = input.default;
      entry.origin = "default";
      plan.interpolationEnv[input.name] = input.default;
    }
    plan.environment.push(entry);
  }
  for (const name of Object.keys(opts.environment ?? {})) {
    if (!envNames.has(name)) warnings.push(`Ignoring environment choice "${name}" — the app does not expose it.`);
  }

  // ── GPU ────────────────────────────────────────────────────────────────
  const gpuRequested = (m.permissions ?? []).some((p) => p.toUpperCase() === "GPU");
  if (gpuRequested) {
    plan.gpu.requested = true;
    if (ctx.hasDri) {
      plan.gpu.devices = ["/dev/dri:/dev/dri"];
      plan.gpu.services = pickGpuServices(services, serviceNames);
    } else {
      warnings.push(GPU_UNAVAILABLE_WARNING);
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

function rewriteSource(source: string, plan: UmbrelV2Plan): string {
  const mapped = mapUmbrelRootSource(source, plan.paths);
  return mapped ? mapped.hostPath : redirectDataRoot(source, plan.dataRoot.hostPath);
}

/**
 * Compose interpolates `$` in every string of the file — escape literal values
 * so `pa$word` stays intact and `${TALOME_SECRET}` is never expanded from
 * Talome's own process environment.
 */
export function escapeComposeLiteral(value: string): string {
  return value.replace(/\$/g, () => "$$");
}

function setServiceEnv(svc: ComposeService, values: Record<string, string>): void {
  const escaped = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, escapeComposeLiteral(value)]));
  const env = svc.environment;
  if (Array.isArray(env)) {
    const next = env.filter((entry) => {
      if (typeof entry !== "string") return true;
      const key = entry.split("=")[0];
      return !(key in escaped);
    });
    for (const [key, value] of Object.entries(escaped)) next.push(`${key}=${value}`);
    svc.environment = next;
    return;
  }
  svc.environment = { ...(isRecord(env) ? env : {}), ...escaped };
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

    const gpuServices = plan.gpu.services ?? [];
    if (plan.gpu.devices.length > 0 && (gpuServices.length === 0 || gpuServices.includes(name))) {
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
