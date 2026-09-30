import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { atomicWriteFileSync } from "../utils/filesystem.js";
import { join, relative, resolve, isAbsolute } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { homedir } from "node:os";
import { db, schema } from "../db/index.js";
import { eq, and } from "drizzle-orm";
import { talomeAdapter } from "./adapters/talome-adapter.js";
import { uninstallApp } from "./lifecycle.js";
import { createLogger } from "../utils/logger.js";
import type {
  AppBlueprint,
  InstructionPackSummary,
  SourceReference,
  ValidationCheck,
  WorkspaceSummary,
} from "../creator/contracts.js";
import { deleteAppSpec, getStoredAppSpec, saveAppSpec } from "../app-specs/service.js";
import { createDefaultAppSpec, TalomeAppSpecSchema } from "../app-specs/schema.js";
import { assertNoPublicationConflicts, copyGeneratedArtifactSync, publicationValidationClaims } from "./creator-artifacts.js";

const USER_APPS_DIR = join(homedir(), ".talome", "user-apps");
const log = createLogger("creator");
const APP_ID_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function ensureUserAppsStore(): string {
  const storeId = "user-apps";

  const existing = db
    .select()
    .from(schema.storeSources)
    .where(eq(schema.storeSources.id, storeId))
    .get();

  if (!existing) {
    mkdirSync(USER_APPS_DIR, { recursive: true });

    const registryPath = join(USER_APPS_DIR, "registry.json");
    if (!existsSync(registryPath)) {
      atomicWriteFileSync(registryPath, JSON.stringify({ version: 1, apps: [] }, null, 2));
    }

    db.insert(schema.storeSources)
      .values({
        id: storeId,
        name: "My Creations",
        type: "user-created",
        localPath: USER_APPS_DIR,
        branch: "main",
        enabled: true,
        appCount: 0,
      })
      .run();
  }

  return storeId;
}

function updateRegistry(appId: string): void {
  const registryPath = join(USER_APPS_DIR, "registry.json");
  let registry: { version: number; apps: string[] };

  if (existsSync(registryPath)) {
    registry = JSON.parse(readFileSync(registryPath, "utf-8"));
  } else {
    registry = { version: 1, apps: [] };
  }

  if (!registry.apps.includes(appId)) {
    registry.apps.push(appId);
    atomicWriteFileSync(registryPath, JSON.stringify(registry, null, 2));
  }
}

export interface CreateAppInput {
  id: string;
  name: string;
  description: string;
  category: string;
  services: {
    name: string;
    image: string;
    ports: { host: number; container: number }[];
    volumes: { hostPath: string; containerPath: string }[];
    environment: Record<string, string>;
    healthcheck?: {
      test: string[];
      interval?: string;
      timeout?: string;
      retries?: number;
    };
    resources?: {
      memory?: string;
      cpus?: string;
    };
  }[];
  env: { key: string; label: string; required: boolean; default?: string; secret?: boolean }[];
  creator?: {
    blueprint: AppBlueprint;
    sources: SourceReference[];
    validations: ValidationCheck[];
    instructionPack: InstructionPackSummary;
    workspace?: WorkspaceSummary;
    createdAt: string;
  };
}

/**
 * Blueprint safety checks — refuse to generate compose files that would
 * bring down a home server. Applied at the creator layer so both AI-authored
 * and user-authored blueprints are validated before any file is written.
 *
 *  - `:latest` and untagged images float, so a restart can pull a breaking
 *    version with no rollback path.
 *  - Absolute host paths let a blueprint mount arbitrary host directories
 *    (including `/`, `/etc`, `$HOME`). Relative paths under the app's
 *    install directory are the only safe default.
 */
/**
 * True when compose reads a volume source as a named volume rather than a
 * host path: no leading "." "/" or "~" and no slash (compose rejects a slash
 * in a volume name).
 */
export function isNamedVolumeSource(hostPath: string): boolean {
  return !/^[./~$]/.test(hostPath) && !hostPath.includes("/");
}

/** Characters Docker accepts in a volume name. */
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** Characters compose accepts in a service name (it is also the container name). */
const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** Control characters (newlines included) — never part of a name, image or path. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * `${APP_DATA_DIR}` (or `$APP_DATA_DIR`), optionally followed by a path: the
 * app's data directory, which Talome sets when it runs compose. It is the
 * only variable a volume source may use — any other one (HOME, or a value
 * from the app's own .env) can make it an arbitrary host path.
 */
const APP_DATA_DIR_SOURCE = /^\$(\{APP_DATA_DIR\}|APP_DATA_DIR)(\/|$)/;

function hasParentSegment(path: string): boolean {
  return path.split("/").includes("..");
}

/**
 * `generatesCompose`: the compose file is generated from these services. When
 * a validated Creator workspace supplies its own compose file, the service
 * list only describes it, so the checks on how compose reads a source are
 * skipped (the path safety checks are not).
 */
function validateCreateAppInput(input: CreateAppInput, generatesCompose = true): string | null {
  for (const svc of input.services) {
    if (generatesCompose && (typeof svc.name !== "string" || !SERVICE_NAME.test(svc.name))) {
      return `Service name "${String(svc.name).replace(/[\u0000-\u001f\u007f]+/g, " ")}" may contain only letters, numbers, "_", "." and "-".`;
    }
    if (!svc.image || typeof svc.image !== "string") {
      return `Service "${svc.name}" is missing an image tag.`;
    }
    if (/\s/.test(svc.image) || CONTROL_CHARS.test(svc.image)) {
      return `Service "${svc.name}" has an invalid image reference "${svc.image.replace(/[\s\u0000-\u001f\u007f]+/g, " ")}".`;
    }
    if (generatesCompose) {
      for (const key of Object.keys(svc.environment ?? {})) {
        if (!key || /[\s=]/.test(key) || CONTROL_CHARS.test(key)) {
          return `Service "${svc.name}" has an invalid environment variable name "${key.replace(/[\u0000-\u001f\u007f]+/g, " ")}".`;
        }
      }
    }

    // Strip any digest suffix before checking the tag (images can legitimately
    // be pinned to :<tag>@sha256:<digest>, which is fine).
    const imageNoDigest = svc.image.split("@")[0];
    const lastColon = imageNoDigest.lastIndexOf(":");
    const lastSlash = imageNoDigest.lastIndexOf("/");
    const hasTag = lastColon > lastSlash && lastColon < imageNoDigest.length - 1;
    if (!hasTag) {
      return `Service "${svc.name}" uses image "${svc.image}" without a tag. Pin a specific version instead of relying on an implicit :latest.`;
    }
    const tag = imageNoDigest.slice(lastColon + 1);
    if (tag.toLowerCase() === "latest") {
      return `Service "${svc.name}" uses "${svc.image}". Talome refuses :latest tags in user apps — pin a specific version.`;
    }

    for (const vol of svc.volumes) {
      if (!vol.hostPath || typeof vol.hostPath !== "string") {
        return `Service "${svc.name}" has a volume with no hostPath.`;
      }
      if (typeof vol.containerPath !== "string" || !vol.containerPath || CONTROL_CHARS.test(vol.containerPath)) {
        return `Service "${svc.name}" has a volume with an invalid container path.`;
      }
      if (CONTROL_CHARS.test(vol.hostPath)) {
        return `Service "${svc.name}" mounts a host path containing control characters.`;
      }
      // Named volumes (no slash), paths inside the app directory ("./data")
      // and inside its data directory ("${APP_DATA_DIR}/config") are
      // acceptable. Anything else (including "/var/run/docker.sock",
      // "/etc/passwd", "~/foo", "../../etc", "${HOME}") is rejected.
      if (hasParentSegment(vol.hostPath)) {
        return `Service "${svc.name}" mounts "${vol.hostPath}", which leaves the app directory. Use a path inside it (e.g. "./data") or a named volume.`;
      }
      if (vol.hostPath.startsWith("$") ? !APP_DATA_DIR_SOURCE.test(vol.hostPath) || vol.hostPath.indexOf("$", 1) !== -1 : vol.hostPath.includes("$")) {
        return `Service "${svc.name}" mounts "${vol.hostPath}". A volume source may use only \${APP_DATA_DIR} (e.g. "\${APP_DATA_DIR}/config"), no other variable.`;
      }
      if (APP_DATA_DIR_SOURCE.test(vol.hostPath)) continue;
      if (vol.hostPath.startsWith("/")) {
        return `Service "${svc.name}" mounts absolute host path "${vol.hostPath}". Use a named volume or a path relative to the app directory (e.g. "./data").`;
      }
      if (vol.hostPath.startsWith("~")) {
        return `Service "${svc.name}" mounts tilde path "${vol.hostPath}". Use a named volume or a relative path.`;
      }
      if (!generatesCompose) continue;
      if (isNamedVolumeSource(vol.hostPath)) {
        if (!VOLUME_NAME.test(vol.hostPath)) {
          return `Service "${svc.name}" uses the volume name "${vol.hostPath}". Volume names may contain only letters, numbers, "_", "." and "-".`;
        }
      } else if (!vol.hostPath.startsWith(".")) {
        // "data/db" is neither a path compose resolves nor a valid volume name
        return `Service "${svc.name}" mounts "${vol.hostPath}". Use "./${vol.hostPath}" for a folder in the app directory, or a name without slashes for a named volume.`;
      }
    }
  }
  return null;
}

export function createUserApp(input: CreateAppInput, options: { validatedScaffoldPath?: string } = {}): {
  success: boolean;
  appId: string;
  storeId: string;
  error?: string;
} {
  // Every entry point, including raw user-app API calls, reaches this check
  // before an ID can become a filesystem path or a registry key.
  if (typeof input.id !== "string" || input.id.length > 96 || !APP_ID_SLUG.test(input.id)) {
    return { success: false, appId: input.id, storeId: "", error: "App ID must be a slug of 1–96 lowercase letters, numbers, and single hyphens between words." };
  }
  // This second argument is supplied only by the server's fresh validation path;
  // a serialized creator.workspace or generatedWithClaudeCode flag is not proof.
  if (input.creator?.workspace && !options.validatedScaffoldPath) {
    return { success: false, appId: input.id, storeId: "", error: "Publish generated workspaces through Creator completion so their current files are validated first." };
  }
  if (input.creator) {
    input = { ...input, creator: { ...input.creator, validations: publicationValidationClaims(input.creator.validations, Boolean(options.validatedScaffoldPath)) } };
  }
  const validationError = validateCreateAppInput(input, !(options.validatedScaffoldPath && workspaceComposePath(options.validatedScaffoldPath)));
  if (validationError) {
    return { success: false, appId: input.id, storeId: "", error: validationError };
  }

  try {
    const appDir = join(USER_APPS_DIR, "apps", input.id);
    let validatedSpecBytes: Buffer | undefined;
    if (options.validatedScaffoldPath && input.creator?.blueprint?.appSpec) {
      validatedSpecBytes = readFileSync(join(options.validatedScaffoldPath, "talome-app.json"));
      const artifactSpec = TalomeAppSpecSchema.parse(JSON.parse(validatedSpecBytes.toString("utf8")));
      const validatedSpec = TalomeAppSpecSchema.parse(input.creator.blueprint.appSpec);
      if (artifactSpec.appId !== input.id || JSON.stringify(artifactSpec) !== JSON.stringify(validatedSpec)) {
        throw new Error("Published native contract differs from its validated snapshot");
      }
      const current = getStoredAppSpec("user-apps", input.id, { includeInactive: true });
      if (current && current.revision >= validatedSpec.revision) {
        throw new Error("Native app changed after validation; rerun Creator completion before publishing");
      }
    }
    if (options.validatedScaffoldPath && existsSync(appDir)) assertNoPublicationConflicts(options.validatedScaffoldPath, appDir);
    const storeId = ensureUserAppsStore();
    mkdirSync(appDir, { recursive: true });
    const primaryRepo = input.creator?.sources.find((source) => source.repoUrl)?.repoUrl;

    const manifest = {
      id: input.id,
      name: input.name,
      description: input.description,
      icon: input.creator?.blueprint?.icon || "🔧",
      category: input.category || "other",
      version: "1.0.0",
      website: primaryRepo || "",
      author: "User",
      image: input.services[0]?.image || "",
      ports: input.services.flatMap((s) => s.ports),
      volumes: input.services.flatMap((s) =>
        s.volumes.map((v) => ({
          name: v.hostPath.split("/").pop() || "data",
          containerPath: v.containerPath,
          description: "",
        })),
      ),
      env: input.env,
      minResources: { cpuCores: 1, memoryMb: 512, diskMb: 1024 },
      arm64: true,
    };

    atomicWriteFileSync(join(appDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    // Prefer the docker-compose.yml generated by Claude Code in the workspace
    // (it may contain build:, command:, Dockerfile references, etc. that the
    // minimal generator cannot express). Fall back to generating from manifest.
    const workspaceCompose = options.validatedScaffoldPath ? workspaceComposePath(options.validatedScaffoldPath) : undefined;

    if (workspaceCompose) {
      // Copy the entire scaffold directory to the app directory.
      // This ensures all generated files (compose, Dockerfile, source code,
      // config files, etc.) are available when docker compose runs.
      const scaffoldDir = options.validatedScaffoldPath!;
      if (existsSync(scaffoldDir)) {
        copyGeneratedArtifactSync(scaffoldDir, appDir);
      } else {
        // Fallback: just copy the compose file
        const raw = readFileSync(workspaceCompose, "utf-8");
        atomicWriteFileSync(join(appDir, "docker-compose.yml"), raw);
      }
    } else {
      atomicWriteFileSync(join(appDir, "docker-compose.yml"), buildUserAppComposeYaml(input.services));
    }

    // Generated source cannot replace the server-issued validation metadata.
    if (input.creator) {
      atomicWriteFileSync(join(appDir, "creator.json"), JSON.stringify(input.creator, null, 2));
    }

    const nativeSpec = input.creator?.blueprint?.appSpec ?? createDefaultAppSpec({
      appId: input.id,
      storeId,
      name: input.name,
      description: input.description,
      icon: input.creator?.blueprint?.icon ?? manifest.icon,
    });
    const parsedSpec = TalomeAppSpecSchema.parse(options.validatedScaffoldPath ? nativeSpec : {
      ...nativeSpec,
      appId: input.id,
      name: input.name,
      description: input.description,
      icon: input.creator?.blueprint?.icon ?? nativeSpec.icon,
    });
    if (parsedSpec.appId !== input.id) throw new Error("Validated AppSpec does not match the published app ID");
    if (validatedSpecBytes) {
      atomicWriteFileSync(join(appDir, "talome-app.json"), validatedSpecBytes);
    } else {
      atomicWriteFileSync(join(appDir, "talome-app.json"), JSON.stringify(parsedSpec, null, 2));
    }
    saveAppSpec({ storeId, spec: parsedSpec, status: "approved" });

    updateRegistry(input.id);

    const manifests = talomeAdapter.parse(USER_APPS_DIR, storeId);
    const thisManifest = manifests.find((m) => m.id === input.id);

    if (thisManifest) {
      db.delete(schema.appCatalog)
        .where(
          and(
            eq(schema.appCatalog.appId, input.id),
            eq(schema.appCatalog.storeSourceId, storeId),
          ),
        )
        .run();

      db.insert(schema.appCatalog)
        .values({
          appId: thisManifest.id,
          storeSourceId: storeId,
          name: thisManifest.name,
          version: thisManifest.version,
          tagline: thisManifest.tagline,
          description: thisManifest.description,
          icon: thisManifest.icon,
          category: thisManifest.category,
          author: thisManifest.author,
          source: "user-created",
          composePath: thisManifest.composePath,
          image: thisManifest.image || null,
          ports: JSON.stringify(thisManifest.ports),
          volumes: JSON.stringify(thisManifest.volumes),
          env: JSON.stringify(thisManifest.env),
          webPort: thisManifest.webPort || null,
        })
        .run();

      db.update(schema.storeSources)
        .set({ appCount: manifests.length })
        .where(eq(schema.storeSources.id, storeId))
        .run();
    }

    return { success: true, appId: input.id, storeId };
  } catch (err: any) {
    return { success: false, appId: input.id, storeId: "user-apps", error: err.message };
  }
}

/** The compose file a validated Creator workspace supplies, if any. */
function workspaceComposePath(scaffoldPath: string): string | undefined {
  return [join(scaffoldPath, "docker-compose.yml"), join(scaffoldPath, "docker-compose.yaml")].find((p) => existsSync(p));
}

/**
 * The compose file for a user app built from its service list. Named volumes
 * (a source without a path, e.g. "pgdata") are declared at the top level —
 * compose refuses a service that uses an undeclared volume.
 */
export function buildUserAppComposeYaml(services: CreateAppInput["services"]): string {
  const composeServices: Record<string, any> = {};
  for (const svc of services) {
    const svcDef: any = {
      image: svc.image,
      container_name: svc.name,
      restart: "unless-stopped",
      // Default log cap so a chatty container can't fill the host disk.
      // 20 MB × 3 rotations = 60 MB ceiling per service. User can
      // override by providing their own logging block in the blueprint.
      logging: {
        driver: "json-file",
        options: {
          "max-size": "20m",
          "max-file": "3",
        },
      },
    };

    if (svc.ports.length > 0) {
      svcDef.ports = svc.ports.map((p) => `${p.host}:${p.container}`);
    }

    if (svc.volumes.length > 0) {
      svcDef.volumes = svc.volumes.map((v) => `${v.hostPath}:${v.containerPath}`);
    }

    if (Object.keys(svc.environment).length > 0) {
      svcDef.environment = svc.environment;
    }

    if (svc.healthcheck) {
      svcDef.healthcheck = svc.healthcheck;
    }

    if (svc.resources && (svc.resources.memory || svc.resources.cpus)) {
      svcDef.deploy = {
        resources: {
          limits: {
            ...(svc.resources.memory ? { memory: svc.resources.memory } : {}),
            ...(svc.resources.cpus ? { cpus: svc.resources.cpus } : {}),
          },
        },
      };
    }

    composeServices[svc.name] = svcDef;
  }

  const namedVolumes = [
    ...new Set(services.flatMap((svc) => svc.volumes.map((v) => v.hostPath).filter(isNamedVolumeSource))),
  ];
  return generateComposeYaml(composeServices, namedVolumes);
}

/**
 * Serialize the compose document. Every value goes through the YAML
 * serializer — never string concatenation — so a blueprint value cannot add
 * keys (a newline in an image or path), and names YAML would read as another
 * type ("1", "true", "null") stay strings.
 */
function generateComposeYaml(services: Record<string, any>, namedVolumes: string[] = []): string {
  const doc: Record<string, unknown> = {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, svc] of Object.entries(services)) {
    const def: Record<string, unknown> = { image: String(svc.image) };
    if (svc.container_name) def.container_name = String(svc.container_name);
    def.restart = svc.restart || "unless-stopped";
    if (svc.ports?.length > 0) def.ports = svc.ports.map((p: unknown) => String(p));
    if (svc.volumes?.length > 0) def.volumes = svc.volumes.map((v: unknown) => String(v));
    if (svc.environment && Object.keys(svc.environment).length > 0) {
      def.environment = Object.entries(svc.environment).map(([key, val]) => `${key}=${val}`);
    }
    if (svc.healthcheck) {
      def.healthcheck = {
        test: (svc.healthcheck.test ?? []).map((part: unknown) => String(part)),
        interval: String(svc.healthcheck.interval || "30s"),
        timeout: String(svc.healthcheck.timeout || "10s"),
        retries: Number(svc.healthcheck.retries) || 3,
      };
    }
    if (svc.deploy?.resources?.limits) {
      const limits: Record<string, string> = {};
      if (svc.deploy.resources.limits.memory) limits.memory = String(svc.deploy.resources.limits.memory);
      if (svc.deploy.resources.limits.cpus) limits.cpus = String(svc.deploy.resources.limits.cpus);
      def.deploy = { resources: { limits } };
    }
    out[name] = def;
  }
  doc.services = out;
  if (namedVolumes.length > 0) doc.volumes = Object.fromEntries(namedVolumes.map((name) => [name, {}]));
  return stringifyYaml(doc, { lineWidth: 0 });
}

export function listUserApps() {
  const storeId = "user-apps";
  return db
    .select()
    .from(schema.appCatalog)
    .where(eq(schema.appCatalog.storeSourceId, storeId))
    .all()
    .map((r) => ({
      id: r.appId,
      name: r.name,
      category: r.category,
      description: r.tagline || r.description,
    }));
}

export async function deleteUserApp(appId: string): Promise<{ success: boolean; error?: string; keptData?: string[] }> {
  try {
    const storeId = "user-apps";
    const registryPath = join(USER_APPS_DIR, "registry.json");

    // Stop and remove containers before cleaning up records
    const installed = db.select().from(schema.installedApps)
      .where(eq(schema.installedApps.appId, appId)).get();
    if (installed) {
      // Keep the catalog/registry entry when uninstall did not happen (e.g. an
      // update is running): deleting it would orphan a still-installed app.
      const uninstall = await uninstallApp(appId);
      if (!uninstall.success) {
        return { success: false, error: uninstall.error ?? `Could not uninstall ${appId}` };
      }
    }

    if (existsSync(registryPath)) {
      const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
      registry.apps = registry.apps.filter((id: string) => id !== appId);
      atomicWriteFileSync(registryPath, JSON.stringify(registry, null, 2));
    }

    db.delete(schema.appCatalog)
      .where(
        and(
          eq(schema.appCatalog.appId, appId),
          eq(schema.appCatalog.storeSourceId, storeId),
        ),
      )
      .run();

    deleteAppSpec("user-apps", appId);
    const cleanup = removeUserAppDir(appId);
    return { success: true, ...(cleanup.kept.length > 0 ? { keptData: cleanup.kept } : {}) };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Host paths inside `appDir` that the app's compose file bind-mounts (its
 * runtime data when the compose ran from this directory). Returns null when
 * the compose cannot be read or a source cannot be resolved (e.g. ${VAR}) —
 * the caller must then keep everything.
 */
function boundPathsInAppDir(appDir: string): string[] | null {
  const composePath = ["docker-compose.yml", "docker-compose.yaml"].map((f) => join(appDir, f)).find((p) => existsSync(p));
  if (!composePath) return [];
  let doc: { services?: Record<string, { volumes?: unknown[] } | null> } | null;
  try {
    doc = parseYaml(readFileSync(composePath, "utf-8")) as typeof doc;
  } catch {
    return null;
  }
  // The directory as written and with symlinks resolved: an absolute source
  // may name either form
  const roots = [appDir];
  try {
    const real = realpathSync(appDir);
    if (real !== appDir) roots.push(real);
  } catch {
    // keep the path as written
  }
  const out: string[] = [];
  for (const svc of Object.values(doc?.services ?? {})) {
    for (const vol of (Array.isArray(svc?.volumes) ? svc.volumes : []) as unknown[]) {
      let source: string | null = null;
      if (typeof vol === "string") {
        const parts = vol.split(":");
        if (parts.length >= 2) source = parts[0];
      } else if (vol && typeof vol === "object") {
        const v = vol as { type?: unknown; source?: unknown };
        if (typeof v.source === "string" && v.type !== "volume" && v.type !== "tmpfs") source = v.source;
      }
      if (!source) continue;
      if (source.includes("$")) return null;
      if (isNamedVolumeSource(source)) continue;
      const expanded = source === "~" || source.startsWith("~/") ? join(homedir(), source.slice(1)) : source;
      if (expanded.startsWith("~")) continue; // ~otheruser: never inside this directory
      const candidates = [resolve(appDir, expanded)];
      try {
        candidates.push(realpathSync(candidates[0]));
      } catch {
        // does not exist (yet) — the path as written
      }
      for (const abs of candidates) {
        const root = roots.find((r) => isInside(r, abs) || isInside(abs, r));
        if (!root) continue;
        // A mount of the directory itself or of a folder above it: keep everything
        out.push(isInside(abs, root) ? appDir : join(appDir, relative(root, abs)));
        break;
      }
    }
  }
  return out;
}

/**
 * Remove a deleted user app's directory (manifest, compose, creator files,
 * generated source). Data the compose bind-mounts from inside the directory
 * is never deleted — the top-level entries holding it are kept. Backups live
 * elsewhere and are not touched.
 */
function removeUserAppDir(appId: string): { removed: boolean; kept: string[] } {
  if (typeof appId !== "string" || appId.length > 96 || !APP_ID_SLUG.test(appId)) return { removed: false, kept: [] };
  const appsRoot = join(USER_APPS_DIR, "apps");
  const appDir = join(appsRoot, appId);
  if (!isInside(appsRoot, appDir) || appDir === appsRoot || !existsSync(appDir)) return { removed: false, kept: [] };
  try {
    const bound = boundPathsInAppDir(appDir);
    if (bound === null || bound.includes(appDir)) {
      log.warn(`${appId}: kept ${appDir} — it may hold app data (its compose mounts it, or could not be read)`);
      return { removed: false, kept: [appDir] };
    }
    const existing = bound.filter((p) => existsSync(p));
    if (existing.length === 0) {
      rmSync(appDir, { recursive: true, force: true });
      return { removed: true, kept: [] };
    }
    const kept: string[] = [];
    for (const name of readdirSync(appDir)) {
      const entry = join(appDir, name);
      if (existing.some((p) => isInside(entry, p))) {
        kept.push(entry);
        continue;
      }
      rmSync(entry, { recursive: true, force: true });
    }
    log.info(`${appId}: removed the app files, kept its data at ${kept.join(", ")}`);
    return { removed: false, kept };
  } catch (err) {
    log.warn(`${appId}: could not remove ${appDir}`, err);
    return { removed: false, kept: [] };
  }
}
