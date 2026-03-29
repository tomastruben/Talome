import { tool } from "ai";
import { z } from "zod";
import { ensureTailscaleRunning, getTailscaleStatus, stopTailscale } from "../../proxy/tailscale.js";

export const tailscaleSetupTool = tool({
  description:
    "Set up Tailscale for secure remote access. Requires a Tailscale auth key. Use this when the user wants to access their server remotely.",
  inputSchema: z.object({
    authKey: z.string().describe("Tailscale auth key (starts with tskey-)"),
    hostname: z.string().optional().describe("Tailscale hostname (default: talome)"),
  }),
  execute: async ({ authKey, hostname }) => {
    const result = await ensureTailscaleRunning(authKey, hostname);
    if (!result.ok) {
      return { success: false, error: result.error };
    }
    // Wait a moment for Tailscale to connect
    await new Promise((r) => setTimeout(r, 3000));
    const status = await getTailscaleStatus();
    return {
      success: true,
      status,
      message: status.ip
        ? `Tailscale connected! Access your server at ${status.ip}`
        : "Tailscale container started. It may take a moment to connect.",
    };
  },
});

export const tailscaleStatusTool = tool({
  description: "Check Tailscale connection status, IP address, and connected peers.",
  inputSchema: z.object({}),
  execute: async () => {
    return getTailscaleStatus();
  },
});

export const tailscaleStopTool = tool({
  description: "Stop the Tailscale container and disconnect from the Tailscale network.",
  inputSchema: z.object({}),
  execute: async () => {
    await stopTailscale();
    return { success: true, message: "Tailscale stopped" };
  },
});
