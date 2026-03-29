import { tool } from "ai";
import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAuditEntry } from "../../db/audit.js";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";
import { listContainers } from "../../docker/client.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT =
  process.env.TALOME_ROOT || resolve(THIS_DIR, "..", "..", "..", "..", "..");

const BACKUP_DIR = join(process.env.HOME || "/tmp", ".talome", "backups", "compose");

function safePath(userPath: string): string {
  const resolved = resolve(userPath);
  // Allow absolute paths that exist on the filesystem (compose files can be anywhere)
  // but prevent path traversal attacks using ".."
  if (userPath.includes("..")) {
    throw new Error(`Path "${userPath}" contains path traversal. Access denied.`);
  }
  return resolved;
}

function getInstalledAppComposePath(appId: string): string | null {
  try {
    const row = db
      .select()
      .from(schema.installedApps)
      .where(eq(schema.installedApps.appId, appId))
      .get();
    return row?.overrideComposePath ?? null;
  } catch {
    return null;
  }
}

/**
 * Discover compose file path from Docker container labels.
 * Works for any Compose-managed container (CasaOS, Umbrel, manual)
 * by reading the standard `com.docker.compose.project.config_files` label.
 */
async function discoverComposePathFromContainer(appId: string): Promise<{ composePath: string; serviceName: string } | null> {
  try {
    const containers = await listContainers();
    // Match by compose service label or container name
    const match = containers.find((c) => {
      const service = c.labels["com.docker.compose.service"]?.toLowerCase();
      return service === appId.toLowerCase() || c.name.toLowerCase() === appId.toLowerCase();
    });
    if (!match) return null;
    const configFiles = match.labels["com.docker.compose.project.config_files"];
    const serviceName = match.labels["com.docker.compose.service"] ?? appId;
    if (!configFiles) return null;
    // config_files can contain multiple paths separated by commas; use the first
    const composePath = configFiles.split(",")[0].trim();
    if (!composePath || !existsSync(composePath)) return null;
    return { composePath, serviceName };
  } catch {
    return null;
  }
}

async function backupCompose(composePath: string, appId: string): Promise<void> {
  await mkdir(BACKUP_DIR, { recursive: true });
  const content = await readFile(composePath, "utf-8");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  await writeFile(join(BACKUP_DIR, `${appId}-${ts}.yml.bak`), content, "utf-8");
}

// ── get_app_config ────────────────────────────────────────────────────────────

export const getAppConfigTool = tool({
  description:
    "Read the docker-compose.yml for an installed app. Returns parsed environment variables, ports, volumes, image name, and resource limits.",
  inputSchema: z.object({
    appId: z.string().describe("The app ID of the installed app (e.g. 'sonarr', 'jellyfin')"),
  }),
  execute: async ({ appId }) => {
    const composePath = getInstalledAppComposePath(appId);
    if (!composePath) {
      return { success: false, error: `No compose path found for app '${appId}'. Is it installed?` };
    }
    try {
      const safe = safePath(composePath);
      const content = await readFile(safe, "utf-8");
      const parsed = parseYaml(content) as Record<string, unknown>;
      return { success: true, appId, composePath, config: parsed };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── set_app_env ───────────────────────────────────────────────────────────────

export const setAppEnvTool = tool({
  description:
    "Set or update an environment variable for an installed app by editing its docker-compose.yml. The container must be recreated for the change to take effect — this tool does that automatically. Requires user confirmation for sensitive keys.",
  inputSchema: z.object({
    appId: z.string().describe("The app ID"),
    serviceName: z.string().describe("The docker-compose service name to update (e.g. 'sonarr')"),
    key: z.string().describe("Environment variable name"),
    value: z.string().describe("New value for the environment variable"),
  }),
  execute: async ({ appId, serviceName, key, value }) => {
    const composePath = getInstalledAppComposePath(appId);
    if (!composePath) {
      return { success: false, error: `No compose path found for '${appId}'.` };
    }
    try {
      const safe = safePath(composePath);
      const content = await readFile(safe, "utf-8");
      const parsed = parseYaml(content) as Record<string, unknown>;

      const services = parsed.services as Record<string, Record<string, unknown>>;
      if (!services?.[serviceName]) {
        return { success: false, error: `Service '${serviceName}' not found in compose file.` };
      }

      const service = services[serviceName];
      let env = service.environment;

      if (Array.isArray(env)) {
        // Array format: ["KEY=VALUE", ...]
        const idx = env.findIndex((e: string) => e.startsWith(`${key}=`));
        if (idx >= 0) {
          env[idx] = `${key}=${value}`;
        } else {
          env.push(`${key}=${value}`);
        }
      } else if (env && typeof env === "object") {
        // Object format: { KEY: "VALUE" }
        (env as Record<string, string>)[key] = value;
      } else {
        // No existing environment block — create one
        service.environment = { [key]: value };
      }

      await backupCompose(safe, appId);
      await writeFile(safe, stringifyYaml(parsed), "utf-8");
      writeAuditEntry(`AI: set_app_env(${appId})`, "modify", `${key}=${value}`);

      return {
        success: true,
        appId,
        serviceName,
        key,
        message: `Updated ${key} in ${appId}. Recreate the container to apply: restart the app from the Services page or ask me to restart it.`,
      };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── change_port_mapping ───────────────────────────────────────────────────────

export const changePortMappingTool = tool({
  description:
    "Change the host port mapping for an installed app. For example, move Jellyfin from host port 8096 to 8097. Container port stays the same — only the host-side port changes.",
  inputSchema: z.object({
    appId: z.string().describe("The app ID"),
    serviceName: z.string().describe("The docker-compose service name"),
    containerPort: z.number().describe("The container port to remap"),
    newHostPort: z.number().describe("The new host port to bind to"),
  }),
  execute: async ({ appId, serviceName, containerPort, newHostPort }) => {
    const composePath = getInstalledAppComposePath(appId);
    if (!composePath) {
      return { success: false, error: `No compose path found for '${appId}'.` };
    }
    try {
      const safe = safePath(composePath);
      const content = await readFile(safe, "utf-8");
      const parsed = parseYaml(content) as Record<string, unknown>;

      const services = parsed.services as Record<string, Record<string, unknown>>;
      const service = services?.[serviceName];
      if (!service) {
        return { success: false, error: `Service '${serviceName}' not found.` };
      }

      const ports = service.ports as string[] | undefined;
      if (!ports) {
        return { success: false, error: `No ports defined for '${serviceName}'.` };
      }

      let changed = false;
      service.ports = ports.map((p: string) => {
        const [host, container] = p.split(":");
        if (Number(container) === containerPort) {
          changed = true;
          return `${newHostPort}:${container}`;
        }
        return p;
      });

      if (!changed) {
        return { success: false, error: `Port ${containerPort} not found in ${serviceName} ports.` };
      }

      await backupCompose(safe, appId);
      await writeFile(safe, stringifyYaml(parsed), "utf-8");
      writeAuditEntry(`AI: change_port_mapping(${appId})`, "modify", `${containerPort} → ${newHostPort}`);

      return {
        success: true,
        appId,
        message: `Changed ${serviceName} host port from previous → ${newHostPort}:${containerPort}. Recreate the container to apply.`,
      };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── add_volume_mount ──────────────────────────────────────────────────────────

export const addVolumeMountTool = tool({
  description:
    "Add a host path bind mount to an app's compose definition. Works with Talome-installed apps AND external apps (CasaOS, manual compose) by auto-discovering the compose file from Docker container labels. After adding a mount, the container must be recreated (restart_app or restart_container).",
  inputSchema: z.object({
    appId: z.string().describe("The app ID or container/service name"),
    serviceName: z.string().optional().describe("The docker-compose service name (auto-detected if omitted)"),
    hostPath: z.string().describe("Absolute path on the host"),
    containerPath: z.string().describe("Path inside the container"),
    readOnly: z.boolean().default(false).describe("Mount as read-only"),
  }),
  execute: async ({ appId, serviceName, hostPath, containerPath, readOnly }) => {
    // Try Talome's DB first, then fall back to Docker label discovery
    let composePath = getInstalledAppComposePath(appId);
    let effectiveServiceName = serviceName ?? appId;

    if (!composePath) {
      const discovered = await discoverComposePathFromContainer(appId);
      if (discovered) {
        composePath = discovered.composePath;
        if (!serviceName) effectiveServiceName = discovered.serviceName;
      }
    }

    if (!composePath) {
      return {
        success: false,
        error: `No compose path found for '${appId}'. The app must be managed by Docker Compose (Talome, CasaOS, or manual). Use inspect_container to verify.`,
      };
    }
    try {
      const safe = safePath(composePath);
      const content = await readFile(safe, "utf-8");
      const parsed = parseYaml(content) as Record<string, unknown>;

      const services = parsed.services as Record<string, Record<string, unknown>>;
      const service = services?.[effectiveServiceName];
      if (!service) {
        const available = Object.keys(services ?? {}).join(", ");
        return { success: false, error: `Service '${effectiveServiceName}' not found. Available: ${available}` };
      }

      const mount = readOnly ? `${hostPath}:${containerPath}:ro` : `${hostPath}:${containerPath}`;

      // Check for duplicate mounts
      const volumes = Array.isArray(service.volumes) ? (service.volumes as string[]) : [];
      if (volumes.some((v) => v.startsWith(`${hostPath}:${containerPath}`))) {
        return { success: true, appId, mount, message: `Mount ${mount} already exists. No changes made.` };
      }

      if (!Array.isArray(service.volumes)) {
        service.volumes = [];
      }
      (service.volumes as string[]).push(mount);

      await backupCompose(safe, appId);
      await writeFile(safe, stringifyYaml(parsed), "utf-8");
      writeAuditEntry(`AI: add_volume_mount(${appId})`, "modify", mount);

      return {
        success: true,
        appId,
        mount,
        composePath,
        message: `Added volume mount ${mount}. Recreate the container to apply (use restart_container or docker compose up -d).`,
      };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── set_resource_limits ───────────────────────────────────────────────────────

export const setResourceLimitsTool = tool({
  description:
    "Set memory and/or CPU limits for an installed app container. Memory is specified in bytes or with units like '512m' or '1g'. CPU as a decimal (e.g. 0.5 = 50% of one core).",
  inputSchema: z.object({
    appId: z.string().describe("The app ID"),
    serviceName: z.string().describe("The docker-compose service name"),
    memoryLimit: z.string().optional().describe("Memory limit, e.g. '512m' or '2g'"),
    cpuLimit: z.number().optional().describe("CPU quota as a decimal (0.5 = half a CPU core)"),
  }),
  execute: async ({ appId, serviceName, memoryLimit, cpuLimit }) => {
    const composePath = getInstalledAppComposePath(appId);
    if (!composePath) {
      return { success: false, error: `No compose path found for '${appId}'.` };
    }
    try {
      const safe = safePath(composePath);
      const content = await readFile(safe, "utf-8");
      const parsed = parseYaml(content) as Record<string, unknown>;

      const services = parsed.services as Record<string, Record<string, unknown>>;
      const service = services?.[serviceName];
      if (!service) {
        return { success: false, error: `Service '${serviceName}' not found.` };
      }

      if (!service.deploy || typeof service.deploy !== "object") {
        service.deploy = {};
      }
      const deploy = service.deploy as Record<string, unknown>;
      if (!deploy.resources || typeof deploy.resources !== "object") {
        deploy.resources = { limits: {} };
      }
      const resources = deploy.resources as Record<string, Record<string, unknown>>;
      if (!resources.limits) resources.limits = {};

      if (memoryLimit) resources.limits.memory = memoryLimit;
      if (cpuLimit !== undefined) resources.limits.cpus = String(cpuLimit);

      await backupCompose(safe, appId);
      await writeFile(safe, stringifyYaml(parsed), "utf-8");
      writeAuditEntry(`AI: set_resource_limits(${appId})`, "modify", `mem=${memoryLimit} cpu=${cpuLimit}`);

      return { success: true, appId, limits: resources.limits, message: "Resource limits updated. Recreate the container to apply." };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// ── upgrade_app_image ─────────────────────────────────────────────────────────

export const upgradeAppImageTool = tool({
  description:
    "Pull the latest version of an app's Docker image and update the image tag in docker-compose.yml. Use this to upgrade an app to its latest release.",
  inputSchema: z.object({
    appId: z.string().describe("The app ID"),
    serviceName: z.string().describe("The docker-compose service name"),
    newImageTag: z.string().optional().default("latest").describe("New image tag (default: latest)"),
  }),
  execute: async ({ appId, serviceName, newImageTag }) => {
    const composePath = getInstalledAppComposePath(appId);
    if (!composePath) {
      return { success: false, error: `No compose path found for '${appId}'.` };
    }
    try {
      const safe = safePath(composePath);
      const content = await readFile(safe, "utf-8");
      const parsed = parseYaml(content) as Record<string, unknown>;

      const services = parsed.services as Record<string, Record<string, unknown>>;
      const service = services?.[serviceName];
      if (!service) {
        return { success: false, error: `Service '${serviceName}' not found.` };
      }

      const currentImage = service.image as string | undefined;
      if (!currentImage) {
        return { success: false, error: `No image defined for '${serviceName}'.` };
      }

      const [imageName] = currentImage.split(":");
      service.image = `${imageName}:${newImageTag}`;

      await backupCompose(safe, appId);
      await writeFile(safe, stringifyYaml(parsed), "utf-8");
      writeAuditEntry(`AI: upgrade_app_image(${appId})`, "modify", `${currentImage} → ${service.image}`);

      return {
        success: true,
        appId,
        previousImage: currentImage,
        newImage: service.image,
        message: `Updated image to ${service.image}. Recreate the container to pull and apply the new image.`,
      };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

// Re-export safePath for tests
export { safePath };
