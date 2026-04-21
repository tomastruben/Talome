import { tool } from "ai";
import { z } from "zod";
import { db } from "../../db/index.js";
import { sql } from "drizzle-orm";
import {
  ensureCaddyRunning,
  writeCaddyfileAndReload,
  getCaddyStatus,
  stopCaddy,
} from "../../proxy/caddy.js";
import { connectContainerToProxyNetwork } from "../../proxy/network.js";
import { randomUUID } from "node:crypto";

export const proxyListRoutesTool = tool({
  description: "List all configured reverse proxy routes with their domains, upstreams, and TLS status.",
  inputSchema: z.object({}),
  execute: async () => {
    const rows = db.all(sql`SELECT * FROM proxy_routes ORDER BY created_at DESC`) as {
      id: string; app_id: string | null; domain: string; upstream: string;
      tls_mode: string; enabled: number; cert_status: string; cert_error: string | null;
    }[];
    const status = await getCaddyStatus();
    return {
      caddyRunning: status.running,
      routes: rows.map((r) => ({
        id: r.id,
        appId: r.app_id,
        domain: r.domain,
        upstream: r.upstream,
        tlsMode: r.tls_mode,
        enabled: r.enabled === 1,
        certStatus: r.cert_status,
        certError: r.cert_error,
      })),
    };
  },
});

export const proxyAddRouteTool = tool({
  description:
    "Add a new reverse proxy route. Maps a domain to an upstream service. Use this when the user wants to expose an app via a domain name.",
  inputSchema: z.object({
    domain: z.string().describe("The domain name (e.g., jellyfin.example.com)"),
    upstream: z.string().describe("The upstream target (e.g., jellyfin:8096 or http://localhost:8096)"),
    appId: z.string().optional().describe("Optional app ID to link this route to"),
    tlsMode: z.enum(["auto", "selfsigned", "off"]).default("auto")
      .describe("TLS mode: auto (Let's Encrypt), selfsigned (LAN), off (HTTP only)"),
  }),
  execute: async ({ domain, upstream, appId, tlsMode }) => {
    // Ensure Caddy is running
    const startResult = await ensureCaddyRunning();
    if (!startResult.ok) {
      return { success: false, error: `Failed to start Caddy: ${startResult.error}` };
    }

    // Normalize upstream
    const normalizedUpstream = upstream.startsWith("http") ? upstream : `http://${upstream}`;

    const id = randomUUID();
    const now = new Date().toISOString();
    db.run(sql`INSERT INTO proxy_routes (id, app_id, domain, upstream, tls_mode, created_at) VALUES (${id}, ${appId ?? null}, ${domain}, ${normalizedUpstream}, ${tlsMode}, ${now})`);

    // Connect upstream container to proxy network if it looks like a container name
    if (!upstream.includes("localhost") && !upstream.includes("127.0.0.1")) {
      const containerName = upstream.split(":")[0];
      try {
        await connectContainerToProxyNetwork(containerName);
      } catch {
        // Non-fatal — container might not exist yet
      }
    }

    await writeCaddyfileAndReload();

    return {
      success: true,
      route: { id, domain, upstream: normalizedUpstream, tlsMode },
      message: `Route created: ${domain} → ${normalizedUpstream}`,
    };
  },
});

export const proxyRemoveRouteTool = tool({
  description: "Remove a reverse proxy route by ID or domain.",
  inputSchema: z.object({
    routeId: z.string().optional().describe("Route ID to remove"),
    domain: z.string().optional().describe("Domain to remove"),
  }),
  execute: async ({ routeId, domain }) => {
    if (routeId) {
      db.run(sql`DELETE FROM proxy_routes WHERE id = ${routeId}`);
    } else if (domain) {
      db.run(sql`DELETE FROM proxy_routes WHERE domain = ${domain}`);
    } else {
      return { success: false, error: "Provide either routeId or domain" };
    }

    await writeCaddyfileAndReload();
    return { success: true, message: `Route removed` };
  },
});

export const proxyReloadTool = tool({
  description: "Reload the Caddy reverse proxy configuration. Use after manual changes.",
  inputSchema: z.object({}),
  execute: async () => {
    const result = await ensureCaddyRunning();
    if (!result.ok) return { success: false, error: result.error };
    await writeCaddyfileAndReload();
    return { success: true, message: "Caddy configuration reloaded" };
  },
});

export const proxyConfigureTlsTool = tool({
  description: "Change the TLS mode for a proxy route. Modes: auto (Let's Encrypt), selfsigned (internal/LAN), off (HTTP only).",
  inputSchema: z.object({
    routeId: z.string().describe("Route ID to update"),
    tlsMode: z.enum(["auto", "selfsigned", "off"]).describe("New TLS mode"),
  }),
  execute: async ({ routeId, tlsMode }) => {
    const existing = db.get(sql`SELECT id FROM proxy_routes WHERE id = ${routeId}`) as { id: string } | undefined;
    if (!existing) return { success: false, error: "Route not found" };

    db.run(sql`UPDATE proxy_routes SET tls_mode = ${tlsMode} WHERE id = ${routeId}`);
    await writeCaddyfileAndReload();

    return { success: true, message: `TLS mode updated to ${tlsMode}` };
  },
});
