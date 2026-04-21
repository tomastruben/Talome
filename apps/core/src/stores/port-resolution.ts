import { createServer } from "node:net";
import { readFileSync, mkdirSync } from "node:fs";
import { atomicWriteFileSync } from "../utils/filesystem.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { db, schema } from "../db/index.js";
import { eq, and } from "drizzle-orm";

const APP_DATA_DIR = join(homedir(), ".talome", "app-data");

const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT) || 3000;
const CORE_PORT = Number(process.env.CORE_PORT) || 4000;
const RESERVED_PORTS = new Set([DASHBOARD_PORT, CORE_PORT]);

export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Server type lacks .once() in newer @types/node
    const s = srv as any;
    s.once("error", () => resolve(false));
    s.once("listening", () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, "0.0.0.0");
  });
}

export async function findAvailablePort(start: number): Promise<number> {
  let port = start;
  const max = start + 100;
  while (port < max) {
    if (!RESERVED_PORTS.has(port) && await isPortAvailable(port)) return port;
    port++;
  }
  return start;
}

export async function checkPortConflicts(ports: { host: number; container: number }[], excludeAppId?: string): Promise<number[]> {
  const installed = db.select().from(schema.installedApps).all();
  const usedPorts = new Set<number>(RESERVED_PORTS);

  for (const app of installed) {
    if (app.appId === excludeAppId) continue;

    const catalogEntry = db
      .select()
      .from(schema.appCatalog)
      .where(
        and(
          eq(schema.appCatalog.appId, app.appId),
          eq(schema.appCatalog.storeSourceId, app.storeSourceId),
        ),
      )
      .get();

    if (catalogEntry) {
      const appPorts = JSON.parse(catalogEntry.ports) as { host: number; container: number }[];
      for (const p of appPorts) usedPorts.add(p.host);
    }
  }

  return ports.filter((p) => usedPorts.has(p.host)).map((p) => p.host);
}

export async function resolvePortMappings(
  ports: { host: number; container: number }[],
  excludeAppId?: string,
): Promise<{ resolved: { host: number; container: number }[]; remapped: Record<number, number> }> {
  const conflicts = await checkPortConflicts(ports, excludeAppId);
  if (conflicts.length === 0) return { resolved: ports, remapped: {} };

  const conflictSet = new Set(conflicts);
  const resolved: { host: number; container: number }[] = [];
  const remapped: Record<number, number> = {};

  for (const p of ports) {
    if (conflictSet.has(p.host)) {
      const newPort = await findAvailablePort(p.host + 1);
      resolved.push({ host: newPort, container: p.container });
      remapped[p.host] = newPort;
    } else {
      resolved.push(p);
    }
  }

  return { resolved, remapped };
}

export function buildOverrideCompose(
  originalPath: string,
  appId: string,
  remapped: Record<number, number>,
): string | null {
  if (Object.keys(remapped).length === 0) return null;

  try {
    const raw = readFileSync(originalPath, "utf-8");
    let modified = raw;

    for (const [original, replacement] of Object.entries(remapped)) {
      const origStr = String(original);
      const replStr = String(replacement);
      modified = modified
        .replace(new RegExp(`published:\\s*["']?${origStr}["']?`, "g"), `published: "${replStr}"`)
        .replace(new RegExp(`^(\\s*-\\s*)["']?${origStr}:`, "gm"), `$1"${replStr}:`);
    }

    const overrideDir = join(APP_DATA_DIR, appId);
    mkdirSync(overrideDir, { recursive: true });
    const overridePath = join(overrideDir, "docker-compose.yml");
    atomicWriteFileSync(overridePath, modified, "utf-8");
    return overridePath;
  } catch {
    return null;
  }
}
