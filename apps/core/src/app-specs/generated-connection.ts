import { existsSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { listContainers, parseTcpDockerHost } from "../docker/client.js";
import { selectComposeContainers } from "../stores/compose-exec.js";
import { getDockerHostAddress } from "../platform/index.js";

const portsSchema = z.array(z.object({ host: z.number().int().positive().max(65535), container: z.number().int().positive().max(65535) }));

/** Resolve only installed personal creations; never guess another container by name. */
export async function resolveGeneratedAppUrl(appId: string): Promise<{ baseUrl: string } | { error: string }> {
  try {
    const installed = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, appId)).get();
    if (!installed || installed.storeSourceId !== "user-apps") return { error: `No configured connection or installed personal app found for '${appId}'.` };
    const catalog = db.select().from(schema.appCatalog).where(and(eq(schema.appCatalog.appId, appId), eq(schema.appCatalog.storeSourceId, installed.storeSourceId))).get();
    if (!catalog) return { error: `The installed app '${appId}' is missing its service definition.` };
    const declared = portsSchema.parse(JSON.parse(catalog.ports));
    // webPort is the manifest's host port. Match its container port against live
    // Docker bindings so remapping/reinstall never leaves a stale URL setting.
    const web = catalog.webPort ? declared.find((port) => port.host === catalog.webPort) : declared.length === 1 ? declared[0] : undefined;
    if (!web) return { error: `The app '${appId}' needs an unambiguous web port in its manifest.` };
    const containers = selectComposeContainers(await listContainers(), appId, installed.overrideComposePath ?? catalog.composePath, { strict: true });
    const candidates = containers.filter((container) => container.status === "running").flatMap((container) => container.ports.filter((port) => port.protocol === "tcp" && port.container === web.container));
    const hosts = [...new Set(candidates.map((port) => port.host))];
    if (hosts.length !== 1) return { error: `The app '${appId}' has no unique running web service. Start it or check its port configuration.` };
    const remote = parseTcpDockerHost(process.env.DOCKER_HOST);
    const host = remote?.host ?? (existsSync("/.dockerenv") ? getDockerHostAddress() : "127.0.0.1");
    return { baseUrl: `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${hosts[0]}` };
  } catch {
    return { error: `Could not resolve the installed service connection for '${appId}'. Check Docker and the app manifest.` };
  }
}
