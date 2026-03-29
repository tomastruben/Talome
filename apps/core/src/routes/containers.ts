import { Hono } from "hono";
import {
  listContainers,
  getContainerStats,
  startContainer,
  stopContainer,
  restartContainer,
  getContainerLogs,
  removeContainer,
  listNetworks,
  createNetwork,
  connectContainerToNetwork,
  disconnectContainerFromNetwork,
  removeNetwork,
} from "../docker/client.js";
import { writeAuditEntry } from "../db/audit.js";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { getLastErrorWithVariables, getStartupFailures } from "../services/docker.js";
import type { Container, ServiceStack } from "@talome/types";

const containers = new Hono();

/** Resolve a container ID to an app ID if it belongs to an installed app. */
function resolveAppId(id: string): string {
  const allApps = db.select().from(schema.installedApps).all();
  const match = allApps.find((app) => {
    const cids = JSON.parse(app.containerIds) as string[];
    return cids.some((cid) => cid === id || cid.startsWith(id));
  });
  return match ? match.appId : id;
}

/** Strip registry prefixes and tags to get a bare image name for matching. */
function normalizeImageName(image: string): string {
  return image
    .replace(/^(docker\.io|ghcr\.io|lscr\.io|registry\.hub\.docker\.com)\//i, "")
    .replace(/^(linuxserver|library)\//i, "")
    .replace(/:.*$/, "")
    .replace(/@sha256:.*$/, "")
    .toLowerCase();
}

/** Pick the "main" container in a stack: prefer one with TCP web ports, then first running. */
function pickPrimary(containers: Container[]): Container {
  const withPorts = containers.find(
    (c) => c.ports.some((p) => p.protocol === "tcp" && p.host > 0) && c.status === "running",
  );
  if (withPorts) return withPorts;
  const running = containers.find((c) => c.status === "running");
  return running ?? containers[0];
}

type CatalogRow = (typeof import("../db/schema.js"))["appCatalog"]["$inferSelect"];

/** Try to resolve a catalog row for a container via multiple heuristics. */
function matchCatalog(
  container: Container,
  catalogByKey: Map<string, CatalogRow>,
): CatalogRow | undefined {
  // 1. Try compose service label (e.g., "sonarr" from media-server compose)
  const service = container.labels["com.docker.compose.service"];
  if (service) {
    const hit = catalogByKey.get(service.toLowerCase());
    if (hit) return hit;
  }
  // 2. Try container name (e.g., "prowlarr", "sonarr")
  const name = container.name.toLowerCase();
  const hit = catalogByKey.get(name);
  if (hit) return hit;
  // 3. Try image name (e.g., "qmcgaw/gluetun" → "gluetun")
  const imageName = normalizeImageName(container.image);
  return catalogByKey.get(imageName)
    ?? catalogByKey.get(imageName.split("/").pop() ?? imageName);
}

/** Create a ServiceStack from a group of containers + optional app/catalog metadata. */
function makeStack(
  id: string,
  name: string,
  kind: ServiceStack["kind"],
  group: Container[],
  catalogRow?: { icon: string; iconUrl: string | null; category: string } | undefined,
  matchedApp?: { appId: string; storeSourceId: string } | undefined,
  catalogByKey?: Map<string, CatalogRow>,
): ServiceStack {
  const primary = pickPrimary(group);
  const runningCount = group.filter((c) => c.status === "running").length;

  // Resolve per-container icons for multi-container stacks
  let containerIcons: Record<string, { icon?: string; iconUrl?: string; name?: string }> | undefined;
  if (group.length > 1 && catalogByKey) {
    const icons: Record<string, { icon?: string; iconUrl?: string; name?: string }> = {};
    let hasAny = false;
    for (const c of group) {
      const row = matchCatalog(c, catalogByKey);
      if (row) {
        icons[c.id] = {
          icon: row.icon || undefined,
          iconUrl: row.iconUrl || undefined,
          name: row.name,
        };
        hasAny = true;
      }
    }
    if (hasAny) containerIcons = icons;
  }

  return {
    id,
    name: catalogRow?.icon ? (name || id) : name || primary.name,
    kind,
    icon: catalogRow?.icon || undefined,
    iconUrl: catalogRow?.iconUrl || undefined,
    category: catalogRow?.category || undefined,
    status: runningCount === group.length ? "running" : runningCount > 0 ? "partial" : "stopped",
    primaryContainer: primary,
    containers: group,
    cpuPercent: group.reduce((sum, c) => sum + (c.stats?.cpuPercent ?? 0), 0),
    memoryUsageMb: group.reduce((sum, c) => sum + (c.stats?.memoryUsageMb ?? 0), 0),
    runningCount,
    totalCount: group.length,
    storeId: matchedApp?.storeSourceId,
    appId: matchedApp?.appId,
    containerIcons,
  };
}

/** Build ServiceStack[] from enriched containers + app metadata.
 *  Groups by compose project first (OrbStack-style), then matches metadata. */
function buildStacks(containers: Container[]): ServiceStack[] {
  // 1. Load installed apps and catalog data
  let installed: (typeof schema.installedApps.$inferSelect)[];
  let catalog: (typeof schema.appCatalog.$inferSelect)[];
  try {
    installed = db.select().from(schema.installedApps).all();
    catalog = db.select().from(schema.appCatalog).all();
  } catch (err) {
    console.error("[containers] buildStacks DB error:", err);
    // Fall back to basic stacks without app metadata
    return containers.map((c) => makeStack(c.id, c.name, "standalone", [c]));
  }

  // 2. Map container ID → installed app
  const cidToApp = new Map<string, typeof installed[number]>();
  for (const app of installed) {
    const cids = JSON.parse(app.containerIds) as string[];
    for (const cid of cids) {
      cidToApp.set(cid, app);
      if (cid.length > 12) cidToApp.set(cid.slice(0, 12), app);
    }
  }

  // 3. Map appId → best catalog entry (prefer talome source)
  const appCatalogMap = new Map<string, typeof catalog[number]>();
  for (const row of catalog) {
    const existing = appCatalogMap.get(row.appId);
    if (!existing || row.source === "talome") {
      appCatalogMap.set(row.appId, row);
    }
  }

  // 4. Build a multi-key → catalog row map for heuristic matching.
  const catalogByKey = new Map<string, CatalogRow>();
  for (const row of catalog) {
    const dominated = (key: string) => {
      const existing = catalogByKey.get(key);
      return !existing || row.source === "talome";
    };
    const id = row.appId.toLowerCase();
    if (dominated(id)) catalogByKey.set(id, row);
    if (row.image) {
      const img = normalizeImageName(row.image);
      if (dominated(img)) catalogByKey.set(img, row);
      const seg = img.split("/").pop();
      if (seg && seg !== img && dominated(seg)) catalogByKey.set(seg, row);
    }
  }

  const installedAppIds = new Set(installed.map((a) => a.appId.toLowerCase()));

  // ── Step 1: Group ALL containers by compose project ──────────────────────
  const composeGroups = new Map<string, Container[]>();
  const standalones: Container[] = [];

  for (const c of containers) {
    const project = c.labels["com.docker.compose.project"];
    if (project) {
      const group = composeGroups.get(project) ?? [];
      group.push(c);
      composeGroups.set(project, group);
    } else {
      standalones.push(c);
    }
  }

  // ── Step 2: Build stacks from compose groups ─────────────────────────────
  const stacks: ServiceStack[] = [];

  for (const [project, group] of composeGroups) {
    const projectLower = project.toLowerCase();

    // Try to match this compose group to a Talome-installed app.
    // Check containerIds first, then project/service/name against installed appIds.
    let matchedApp: typeof installed[number] | undefined;
    for (const c of group) {
      const app = cidToApp.get(c.id);
      if (app) { matchedApp = app; break; }
    }
    if (!matchedApp && installedAppIds.has(projectLower)) {
      matchedApp = installed.find((a) => a.appId.toLowerCase() === projectLower);
    }
    // For single-container groups, also check service label and container name
    if (!matchedApp && group.length === 1) {
      const service = group[0].labels["com.docker.compose.service"]?.toLowerCase();
      if (service && installedAppIds.has(service)) {
        matchedApp = installed.find((a) => a.appId.toLowerCase() === service);
      }
      if (!matchedApp) {
        const name = group[0].name.toLowerCase();
        if (installedAppIds.has(name)) {
          matchedApp = installed.find((a) => a.appId.toLowerCase() === name);
        }
      }
    }

    if (matchedApp) {
      // Talome-installed app — use app metadata, prefer user-defined displayName
      const catalogRow = appCatalogMap.get(matchedApp.appId);
      const stackName = matchedApp.displayName || catalogRow?.name || matchedApp.appId;
      stacks.push(makeStack(
        matchedApp.appId, stackName,
        "talome", group, catalogRow, matchedApp, catalogByKey,
      ));
    } else if (group.length === 1) {
      // Single-container compose project — try catalog heuristic for icon
      const catalogRow = matchCatalog(group[0], catalogByKey);
      stacks.push(makeStack(
        project, catalogRow?.name ?? group[0].name,
        "compose", group, catalogRow, undefined, catalogByKey,
      ));
    } else {
      // Multi-container compose project — keep grouped (OrbStack-style).
      // Per-container icons are resolved inside makeStack via containerIcons.
      const projectCatalog = catalogByKey.get(projectLower);
      stacks.push(makeStack(
        project, projectCatalog?.name ?? project,
        "compose", group, projectCatalog, undefined, catalogByKey,
      ));
    }
  }

  // ── Step 3: Standalone containers (no compose project) ───────────────────
  for (const c of standalones) {
    const app = cidToApp.get(c.id);
    if (app) {
      const catalogRow = appCatalogMap.get(app.appId);
      const stackName = app.displayName || catalogRow?.name || app.appId;
      stacks.push(makeStack(app.appId, stackName, "talome", [c], catalogRow, app, catalogByKey));
    } else {
      const catalogRow = matchCatalog(c, catalogByKey);
      stacks.push(makeStack(c.id, catalogRow?.name ?? c.name, "standalone", [c], catalogRow));
    }
  }

  // Filter out Talome infrastructure containers — internal plumbing, not user apps.
  // These are created programmatically (caddy, dns, avahi, tailscale) and labeled
  // with talome.role. Users don't need to see or manage them.
  const INFRA_ROLES = new Set(["proxy", "dns", "mdns", "tailscale"]);
  const filtered = stacks.filter((s) => {
    const role = s.primaryContainer.labels["talome.role"];
    return !role || !INFRA_ROLES.has(role);
  });

  // Sort: running first, then partial, then stopped; alphabetical within
  const statusOrder = { running: 0, partial: 1, stopped: 2 };
  filtered.sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || a.name.localeCompare(b.name));

  return filtered;
}

containers.get("/", async (c) => {
  try {
    const list = await listContainers();
    const withStats = await Promise.all(
      list.map(async (container) => {
        if (container.status === "running") {
          try {
            const stats = await getContainerStats(container.id);
            return { ...container, stats };
          } catch {
            return container;
          }
        }
        return container;
      })
    );

    if (c.req.query("grouped") === "true") {
      return c.json(buildStacks(withStats));
    }

    return c.json(withStats);
  } catch (err) {
    return c.json({ error: "Failed to list containers" }, 500);
  }
});

containers.post("/:id/start", async (c) => {
  try {
    const id = c.req.param("id");
    await startContainer(id);
    writeAuditEntry("Started", "modify", id);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: "Failed to start container" }, 500);
  }
});

containers.post("/:id/stop", async (c) => {
  try {
    const id = c.req.param("id");
    await stopContainer(id);
    writeAuditEntry("Stopped", "modify", id);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: "Failed to stop container" }, 500);
  }
});

containers.post("/:id/restart", async (c) => {
  try {
    const id = c.req.param("id");
    await restartContainer(id);
    writeAuditEntry("Restarted", "modify", id);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: "Failed to restart container" }, 500);
  }
});

containers.delete("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    await removeContainer(id);
    writeAuditEntry("Removed", "destructive", id);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: "Failed to remove container" }, 500);
  }
});

containers.get("/:id/logs", async (c) => {
  try {
    const tail = Number(c.req.query("tail")) || 200;
    const logs = await getContainerLogs(c.req.param("id"), tail);
    return c.text(logs);
  } catch (err) {
    return c.json({ error: "Failed to get container logs" }, 500);
  }
});

containers.get("/:id/stats", async (c) => {
  try {
    const stats = await getContainerStats(c.req.param("id"));
    return c.json(stats);
  } catch (err) {
    return c.json({ error: "Failed to get container stats" }, 500);
  }
});

containers.get("/:id/last-error", async (c) => {
  try {
    const appId = resolveAppId(c.req.param("id"));
    const result = getLastErrorWithVariables(appId);
    if (!result) return c.json({ error: "No install error found" }, 404);
    return c.json(result);
  } catch (err) {
    return c.json({ error: "Failed to retrieve error details" }, 500);
  }
});

containers.get("/:id/startup-errors", async (c) => {
  try {
    const appId = resolveAppId(c.req.param("id"));
    const failures = getStartupFailures(appId, 5);
    return c.json({ appId, failures });
  } catch (err) {
    return c.json({ error: "Failed to retrieve startup errors" }, 500);
  }
});

// ── Networks ──────────────────────────────────────────────────────────────────

containers.get("/networks", async (c) => {
  try {
    const networks = await listNetworks();
    return c.json({ networks });
  } catch (err) {
    return c.json({ error: "Failed to list networks" }, 500);
  }
});

containers.post("/networks", async (c) => {
  try {
    const { name, driver } = await c.req.json<{ name: string; driver?: string }>();
    if (!name) return c.json({ error: "Name is required" }, 400);
    const result = await createNetwork(name, driver ?? "bridge");
    writeAuditEntry(`Created network: ${name}`, "modify", `Driver: ${driver ?? "bridge"}`);
    return c.json({ ok: true, id: result.id });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed to create network" }, 500);
  }
});

containers.delete("/networks/:name", async (c) => {
  try {
    const name = c.req.param("name");
    await removeNetwork(name);
    writeAuditEntry(`Removed network: ${name}`, "destructive");
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed to remove network" }, 500);
  }
});

containers.post("/networks/:name/connect", async (c) => {
  try {
    const name = c.req.param("name");
    const { container } = await c.req.json<{ container: string }>();
    if (!container) return c.json({ error: "Container is required" }, 400);
    await connectContainerToNetwork(name, container);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed to connect" }, 500);
  }
});

containers.post("/networks/:name/disconnect", async (c) => {
  try {
    const name = c.req.param("name");
    const { container } = await c.req.json<{ container: string }>();
    if (!container) return c.json({ error: "Container is required" }, 400);
    await disconnectContainerFromNetwork(name, container);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed to disconnect" }, 500);
  }
});

export { containers };
