import os from "node:os";

/**
 * Detect the server's LAN-facing IPv4 address.
 * Prefers common physical interface names, falls back to any non-internal IPv4.
 */
export function getServerLanIp(): string {
  const interfaces = os.networkInterfaces();

  // Prefer non-internal IPv4 on common physical interface names
  const preferred = ["eth0", "en0", "eno1", "enp0s3", "wlan0", "wlp2s0"];
  for (const name of preferred) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    const v4 = addrs.find((a) => a.family === "IPv4" && !a.internal);
    if (v4) return v4.address;
  }

  // Fallback: first non-internal, non-docker-bridge IPv4
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    if (name.startsWith("br-") || name.startsWith("veth") || name === "docker0") continue;
    const v4 = addrs.find((a) => a.family === "IPv4" && !a.internal);
    if (v4) return v4.address;
  }

  return "127.0.0.1";
}
