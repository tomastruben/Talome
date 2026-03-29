/**
 * Unified `talome` bridge network — all managed containers join this network
 * so they can resolve each other by container/service name.
 *
 * Replaces per-app bridge isolation and the separate talome-proxy network.
 */

import { docker } from "./client.js";
import yaml from "js-yaml";

export const TALOME_NETWORK = "talome";

/**
 * Create the `talome` bridge network if it doesn't already exist.
 * Idempotent — safe to call on every install and at server startup.
 */
export async function ensureTalomeNetwork(): Promise<void> {
  try {
    const network = docker.getNetwork(TALOME_NETWORK);
    await network.inspect();
  } catch {
    await docker.createNetwork({
      Name: TALOME_NETWORK,
      Driver: "bridge",
      Labels: { "talome.managed": "true" },
    });
    console.log(`[network] Created ${TALOME_NETWORK} bridge network`);
  }
}

/**
 * Inject the shared `talome` external network into a parsed compose document.
 *
 * 1. Adds top-level `networks.talome` as external
 * 2. For each service: adds `networks: [talome, default]` (preserves intra-project
 *    `default` network for multi-service apps like Immich)
 * 3. Removes `network_mode: bridge` (conflicts with named networks)
 * 4. Skips services with `network_mode: host` (user explicitly wants host networking)
 *
 * Returns the modified document (mutates in place for efficiency).
 */
/**
 * Verify that all installed app containers are connected to the `talome` network.
 * Returns container names that should be connected but are not.
 * Called from the monitor loop for runtime network repair.
 */
export async function verifyTalomeNetworkAttachments(): Promise<{ missing: string[]; repaired: string[] }> {
  const missing: string[] = [];
  const repaired: string[] = [];

  try {
    const network = docker.getNetwork(TALOME_NETWORK);
    const info = await network.inspect();
    const connected = new Set(
      Object.values(info.Containers ?? {}).map((c: any) => c.Name as string),
    );

    // Get all running containers
    const containers = await docker.listContainers({ all: false });
    for (const c of containers) {
      const name = c.Names[0]?.replace(/^\//, "") ?? "";
      // Skip infrastructure containers that use host networking
      if (!name || name === "talome-dns" || name === "talome-avahi") continue;
      // Skip containers with host network mode
      if (c.HostConfig?.NetworkMode === "host") continue;

      const labels = c.Labels ?? {};
      // Only repair Talome-managed containers (compose-created or labeled)
      // Accept both legacy "talon.managed" and current "talome.managed" labels
      const isManaged =
        labels["com.docker.compose.project"] ||
        labels["talome.managed"] === "true" ||
        labels["talon.managed"] === "true";
      if (!isManaged) continue;

      if (!connected.has(name)) {
        missing.push(name);
        try {
          await network.connect({ Container: name });
          repaired.push(name);
        } catch {
          // Already connected or non-fatal
        }
      }
    }
  } catch {
    // Network may not exist yet — non-fatal
  }

  return { missing, repaired };
}

export function injectTalomeNetwork(doc: Record<string, unknown>): Record<string, unknown> {
  if (!doc?.services) return doc;

  // Add top-level networks declaration
  const networks = (doc.networks ?? {}) as Record<string, unknown>;
  networks[TALOME_NETWORK] = { external: true };
  doc.networks = networks;

  const services = doc.services as Record<string, Record<string, unknown>>;
  for (const svc of Object.values(services)) {
    // Skip host-networked services
    if (svc.network_mode === "host") continue;

    // Remove `network_mode: bridge` — conflicts with named networks
    if (svc.network_mode === "bridge") {
      delete svc.network_mode;
    }

    // Build network list: talome + default (for intra-project comms)
    const existing = svc.networks;
    if (Array.isArray(existing)) {
      if (!existing.includes(TALOME_NETWORK)) existing.push(TALOME_NETWORK);
      if (!existing.includes("default")) existing.push("default");
    } else if (existing && typeof existing === "object") {
      // Object-form networks: { mynet: { aliases: [...] } }
      const netObj = existing as Record<string, unknown>;
      if (!(TALOME_NETWORK in netObj)) netObj[TALOME_NETWORK] = {};
      if (!("default" in netObj)) netObj["default"] = {};
    } else {
      // No networks defined — set array form
      svc.networks = ["default", TALOME_NETWORK];
    }

    // ── Harden capabilities ──────────────────────────────────────────
    // Drop all Linux capabilities by default, then add back only what's
    // needed. Skip if service is privileged or already has cap_drop set.
    if (!svc.privileged && !svc.cap_drop) {
      svc.cap_drop = ["ALL"];
      // Preserve any explicit cap_add from the compose, or set sensible defaults
      if (!svc.cap_add) {
        // CHOWN + DAC_OVERRIDE + FOWNER + SETGID + SETUID are needed by most
        // containers that run as root then drop privileges (linuxserver pattern).
        svc.cap_add = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"];
      }
    }
  }

  return doc;
}
