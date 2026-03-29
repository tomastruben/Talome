import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { docker } from "../docker/client.js";
import {
  ensureCaddyRunning,
  writeCaddyfileAndReload,
  getCaddyStatus,
  stopCaddy,
} from "../proxy/caddy.js";
import { connectContainerToProxyNetwork } from "../proxy/network.js";

export const proxy = new Hono();

// List all proxy routes + Caddy status
proxy.get("/", async (c) => {
  const routes = db.all(sql`SELECT * FROM proxy_routes ORDER BY created_at DESC`) as {
    id: string; app_id: string | null; domain: string; upstream: string;
    tls_mode: string; enabled: number; cert_status: string; cert_error: string | null; created_at: string;
  }[];
  const status = await getCaddyStatus();
  return c.json({ ...status, routes });
});

// Get Caddy status
proxy.get("/status", async (c) => {
  const status = await getCaddyStatus();
  return c.json(status);
});

// Add a new route
const addRouteSchema = z.object({
  domain: z.string().min(1),
  upstream: z.string().min(1),
  appId: z.string().optional(),
  tlsMode: z.enum(["auto", "selfsigned", "manual", "off"]).default("auto"),
});

proxy.post("/routes", async (c) => {
  const body = addRouteSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);

  const { domain, upstream, appId, tlsMode } = body.data;
  const normalizedUpstream = upstream.startsWith("http") ? upstream : `http://${upstream}`;

  const id = randomUUID();
  const now = new Date().toISOString();
  db.run(sql`INSERT INTO proxy_routes (id, app_id, domain, upstream, tls_mode, created_at) VALUES (${id}, ${appId ?? null}, ${domain}, ${normalizedUpstream}, ${tlsMode}, ${now})`);

  // Ensure Caddy is running and reload
  await ensureCaddyRunning();

  // Connect upstream container to proxy network if applicable
  if (!upstream.includes("localhost") && !upstream.includes("127.0.0.1")) {
    const containerName = upstream.split(":")[0];
    try {
      await connectContainerToProxyNetwork(containerName);
    } catch {
      // Non-fatal
    }
  }

  await writeCaddyfileAndReload();
  return c.json({ id, domain, upstream: normalizedUpstream, tlsMode }, 201);
});

// Update a route
proxy.patch("/routes/:id", async (c) => {
  const routeId = c.req.param("id");
  const body = await c.req.json() as Record<string, unknown>;

  const updates: string[] = [];
  if (typeof body.domain === "string") {
    db.run(sql`UPDATE proxy_routes SET domain = ${body.domain} WHERE id = ${routeId}`);
  }
  if (typeof body.upstream === "string") {
    const u = (body.upstream as string).startsWith("http") ? body.upstream as string : `http://${body.upstream as string}`;
    db.run(sql`UPDATE proxy_routes SET upstream = ${u} WHERE id = ${routeId}`);
  }
  if (typeof body.tlsMode === "string") {
    db.run(sql`UPDATE proxy_routes SET tls_mode = ${body.tlsMode as string} WHERE id = ${routeId}`);
  }
  if (typeof body.enabled === "boolean") {
    db.run(sql`UPDATE proxy_routes SET enabled = ${body.enabled ? 1 : 0} WHERE id = ${routeId}`);
  }

  await writeCaddyfileAndReload();
  return c.json({ ok: true });
});

// Delete a route
proxy.delete("/routes/:id", async (c) => {
  const routeId = c.req.param("id");
  db.run(sql`DELETE FROM proxy_routes WHERE id = ${routeId}`);
  await writeCaddyfileAndReload();
  return c.json({ ok: true });
});

// Reload Caddy
proxy.post("/reload", async (c) => {
  const result = await ensureCaddyRunning();
  if (!result.ok) return c.json({ error: result.error }, 500);
  await writeCaddyfileAndReload();
  return c.json({ ok: true });
});

// Apply base domain to all installed apps — creates routes for apps that don't have one yet
const applyDomainSchema = z.object({
  baseDomain: z.string().min(1),
  tlsMode: z.enum(["auto", "selfsigned", "manual", "off"]).default("selfsigned"),
});

proxy.post("/apply-domain", async (c) => {
  const body = applyDomainSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);

  const { baseDomain, tlsMode } = body.data;
  const isLocal = baseDomain.endsWith(".local") || baseDomain.endsWith(".lan") || baseDomain.endsWith(".home");
  const effectiveTls = isLocal ? "selfsigned" : tlsMode;

  // Get existing app routes to avoid duplicates
  const existingRoutes = db.all(sql`SELECT app_id FROM proxy_routes WHERE app_id IS NOT NULL`) as { app_id: string }[];
  const existingAppIds = new Set(existingRoutes.map((r) => r.app_id));

  // Collect all apps: { appId, port }
  const appPorts = new Map<string, number>();

  // 1. Talome-installed apps from DB
  const dbApps = db.all(sql`
    SELECT ia.app_id, ac.web_port
    FROM installed_apps ia
    LEFT JOIN app_catalog ac ON ia.app_id = ac.app_id AND ia.store_source_id = ac.store_source_id
    WHERE ac.web_port IS NOT NULL
  `) as { app_id: string; web_port: number }[];
  for (const app of dbApps) {
    appPorts.set(app.app_id, app.web_port);
  }

  // 2. All running Docker containers with exposed TCP ports
  const skip = new Set(["talome-caddy", "talome-avahi", "talome-tailscale"]);
  try {
    const containers = await docker.listContainers({ all: false });
    for (const ct of containers) {
      const name = (ct.Names?.[0] ?? "").replace(/^\//, "");
      if (!name || skip.has(name)) continue;
      if (appPorts.has(name)) continue;
      const tcpPort = ct.Ports?.find((p) => p.Type === "tcp" && p.PublicPort);
      if (tcpPort) {
        appPorts.set(name, tcpPort.PrivatePort);
      }
    }
  } catch {
    // Docker not available
  }

  const created: string[] = [];
  const now = new Date().toISOString();

  for (const [appId, port] of appPorts) {
    if (existingAppIds.has(appId)) continue;

    const domain = `${appId}.${baseDomain}`;
    const upstream = `http://${appId}:${port}`;
    const id = randomUUID();

    db.run(sql`INSERT INTO proxy_routes (id, app_id, domain, upstream, tls_mode, created_at) VALUES (${id}, ${appId}, ${domain}, ${upstream}, ${effectiveTls}, ${now})`);

    try {
      await connectContainerToProxyNetwork(appId);
    } catch {
      // Non-fatal
    }

    created.push(domain);
  }

  if (created.length > 0) {
    await ensureCaddyRunning();
    await writeCaddyfileAndReload();
  }

  return c.json({ ok: true, created, skipped: appPorts.size - created.length });
});
