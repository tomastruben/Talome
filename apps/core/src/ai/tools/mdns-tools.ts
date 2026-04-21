import { tool } from "ai";
import { z } from "zod";
import {
  enableLocalDomains,
  disableLocalDomains,
  getLocalDomainsStatus,
} from "../../proxy/local-domains.js";

export const mdnsStatusTool = tool({
  description:
    "Check local domain status — whether DNS, reverse proxy, and mDNS are running, and the server's LAN IP. Also shows the setup command for client devices.",
  inputSchema: z.object({}),
  execute: async () => {
    const status = await getLocalDomainsStatus();
    return {
      ...status,
      setupCommand: status.enabled
        ? `curl -fsSL http://${status.serverIp}:4000/api/network/setup.sh | sudo bash`
        : null,
    };
  },
});

export const mdnsEnableTool = tool({
  description:
    "Enable local domains with DNS + HTTPS reverse proxy. Starts CoreDNS (wildcard DNS), Caddy (reverse proxy with self-signed TLS), and Avahi (mDNS for server discovery). Creates proxy routes for all installed apps. After enabling, devices need to run a setup command once.",
  inputSchema: z.object({
    baseDomain: z
      .string()
      .default("talome.local")
      .describe("Base domain for local access (default: talome.local)"),
  }),
  execute: async ({ baseDomain }) => {
    const result = await enableLocalDomains(baseDomain);
    if (!result.ok) {
      return { success: false, error: result.error };
    }
    return {
      success: true,
      ip: result.ip,
      domain: result.domain,
      proxyRoutes: result.proxyRoutes,
      setupCommand: `curl -fsSL http://${result.ip}:4000/api/network/setup.sh | sudo bash`,
      message: `Local domains enabled! ${result.proxyRoutes.length} app(s) routed. Run the setup command on each client device.`,
    };
  },
});

export const mdnsDisableTool = tool({
  description: "Disable local domains — stops CoreDNS, Avahi, and removes DNS routing. Caddy proxy keeps running for any non-local routes.",
  inputSchema: z.object({}),
  execute: async () => {
    await disableLocalDomains();
    return { success: true, message: "Local domains disabled" };
  },
});

export const mdnsRefreshTool = tool({
  description:
    "Refresh local domain configuration — re-applies DNS zone, proxy routes, and mDNS. Use after IP changes or if something seems off.",
  inputSchema: z.object({}),
  execute: async () => {
    const status = await getLocalDomainsStatus();
    if (!status.enabled) {
      return { success: true, message: "Local domains not enabled" };
    }
    const result = await enableLocalDomains(status.baseDomain);
    return {
      success: true,
      proxyRoutes: result.proxyRoutes,
      message: `Refreshed — ${result.proxyRoutes.length} route(s)`,
    };
  },
});
