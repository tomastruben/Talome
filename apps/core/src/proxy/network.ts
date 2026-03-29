import { docker } from "../docker/client.js";
import { ensureTalomeNetwork, TALOME_NETWORK } from "../docker/talome-network.js";

/** Unified network — Caddy and all apps share the same `talome` bridge. */
const PROXY_NETWORK = TALOME_NETWORK;

export async function ensureProxyNetwork(): Promise<void> {
  await ensureTalomeNetwork();
}

export async function connectContainerToProxyNetwork(containerIdOrName: string): Promise<void> {
  try {
    await ensureProxyNetwork();
    const network = docker.getNetwork(PROXY_NETWORK);
    await network.connect({ Container: containerIdOrName });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Already connected is fine
    if (msg.includes("already exists")) return;
    throw err;
  }
}

export async function disconnectContainerFromProxyNetwork(containerIdOrName: string): Promise<void> {
  try {
    const network = docker.getNetwork(PROXY_NETWORK);
    await network.disconnect({ Container: containerIdOrName });
  } catch {
    // Container may not be connected — that's fine
  }
}

export { PROXY_NETWORK };
