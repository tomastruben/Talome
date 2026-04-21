import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { atomicWriteFileSync } from "../utils/filesystem.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { db, schema } from "../db/index.js";
import { eq, and } from "drizzle-orm";
import { talomeAdapter } from "./adapters/talome-adapter.js";
import { uninstallApp } from "./lifecycle.js";
import type {
  AppBlueprint,
  InstructionPackSummary,
  SourceReference,
  ValidationCheck,
  WorkspaceSummary,
} from "../creator/contracts.js";

const USER_APPS_DIR = join(homedir(), ".talome", "user-apps");

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

function copyDirSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      copyDirSync(srcPath, destPath);
    } else {
      atomicWriteFileSync(destPath, readFileSync(srcPath));
    }
  }
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
function validateCreateAppInput(input: CreateAppInput): string | null {
  for (const svc of input.services) {
    if (!svc.image || typeof svc.image !== "string") {
      return `Service "${svc.name}" is missing an image tag.`;
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
      // Named volumes (no slash) and relative paths starting with ./ are
      // acceptable. Anything else (including "/var/run/docker.sock",
      // "/etc/passwd", "~/foo") is rejected.
      if (vol.hostPath.startsWith("/")) {
        return `Service "${svc.name}" mounts absolute host path "${vol.hostPath}". Use a named volume or a path relative to the app directory (e.g. "./data").`;
      }
      if (vol.hostPath.startsWith("~")) {
        return `Service "${svc.name}" mounts tilde path "${vol.hostPath}". Use a named volume or a relative path.`;
      }
    }
  }
  return null;
}

export function createUserApp(input: CreateAppInput): {
  success: boolean;
  appId: string;
  storeId: string;
  error?: string;
} {
  const validationError = validateCreateAppInput(input);
  if (validationError) {
    return { success: false, appId: input.id, storeId: "", error: validationError };
  }

  try {
    const storeId = ensureUserAppsStore();
    const appDir = join(USER_APPS_DIR, "apps", input.id);
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
    if (input.creator) {
      atomicWriteFileSync(join(appDir, "creator.json"), JSON.stringify(input.creator, null, 2));
    }

    // Prefer the docker-compose.yml generated by Claude Code in the workspace
    // (it may contain build:, command:, Dockerfile references, etc. that the
    // minimal generator cannot express). Fall back to generating from manifest.
    const workspaceComposeCandidates = input.creator?.workspace?.scaffoldPath
      ? [
          join(input.creator.workspace.scaffoldPath, "docker-compose.yml"),
          join(input.creator.workspace.scaffoldPath, "docker-compose.yaml"),
          join(input.creator.workspace.rootPath, "generated-app", "docker-compose.yml"),
          join(input.creator.workspace.rootPath, "generated-app", "docker-compose.yaml"),
        ]
      : [];
    const workspaceCompose = workspaceComposeCandidates.find((p) => existsSync(p));

    if (workspaceCompose) {
      // Copy the entire scaffold directory to the app directory.
      // This ensures all generated files (compose, Dockerfile, source code,
      // config files, etc.) are available when docker compose runs.
      const scaffoldDir = input.creator!.workspace!.scaffoldPath || join(input.creator!.workspace!.rootPath, "generated-app");
      if (existsSync(scaffoldDir)) {
        copyDirSync(scaffoldDir, appDir);
      } else {
        // Fallback: just copy the compose file
        const raw = readFileSync(workspaceCompose, "utf-8");
        atomicWriteFileSync(join(appDir, "docker-compose.yml"), raw);
      }
    } else {
      const composeServices: Record<string, any> = {};
      for (const svc of input.services) {
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

      const composeYaml = generateComposeYaml(composeServices);
      atomicWriteFileSync(join(appDir, "docker-compose.yml"), composeYaml);
    }

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

function generateComposeYaml(services: Record<string, any>): string {
  const lines: string[] = ["services:"];

  for (const [name, svc] of Object.entries(services)) {
    lines.push(`  ${name}:`);
    lines.push(`    image: ${svc.image}`);

    if (svc.container_name) {
      lines.push(`    container_name: ${svc.container_name}`);
    }
    lines.push(`    restart: ${svc.restart || "unless-stopped"}`);

    if (svc.ports?.length > 0) {
      lines.push("    ports:");
      for (const p of svc.ports) {
        lines.push(`      - "${p}"`);
      }
    }

    if (svc.volumes?.length > 0) {
      lines.push("    volumes:");
      for (const v of svc.volumes) {
        lines.push(`      - ${v}`);
      }
    }

    if (svc.environment && Object.keys(svc.environment).length > 0) {
      lines.push("    environment:");
      for (const [key, val] of Object.entries(svc.environment)) {
        lines.push(`      - ${key}=${val}`);
      }
    }

    if (svc.healthcheck) {
      lines.push("    healthcheck:");
      lines.push("      test:");
      for (const part of svc.healthcheck.test) {
        lines.push(`        - ${JSON.stringify(part)}`);
      }
      lines.push(`      interval: ${svc.healthcheck.interval || "30s"}`);
      lines.push(`      timeout: ${svc.healthcheck.timeout || "10s"}`);
      lines.push(`      retries: ${svc.healthcheck.retries || 3}`);
    }

    if (svc.deploy?.resources?.limits) {
      lines.push("    deploy:");
      lines.push("      resources:");
      lines.push("        limits:");
      if (svc.deploy.resources.limits.memory) {
        lines.push(`          memory: ${svc.deploy.resources.limits.memory}`);
      }
      if (svc.deploy.resources.limits.cpus) {
        lines.push(`          cpus: ${svc.deploy.resources.limits.cpus}`);
      }
    }
  }

  return lines.join("\n") + "\n";
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

export async function deleteUserApp(appId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const storeId = "user-apps";
    const registryPath = join(USER_APPS_DIR, "registry.json");

    // Stop and remove containers before cleaning up records
    const installed = db.select().from(schema.installedApps)
      .where(eq(schema.installedApps.appId, appId)).get();
    if (installed) {
      await uninstallApp(appId);
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

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
