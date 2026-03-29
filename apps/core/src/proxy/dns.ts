/**
 * CoreDNS container manager.
 *
 * Runs a CoreDNS container that serves a wildcard A record for *.talome.local
 * (or any configured base domain) and returns authoritative empty AAAA responses
 * to eliminate the 5-second mDNS IPv6 timeout on macOS.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { docker } from "../docker/client.js";
import { getServerLanIp } from "./ip.js";

const DNS_CONTAINER_NAME = "talome-dns";
const DNS_IMAGE = "coredns/coredns:1.12.0";
const DNS_DIR = join(os.homedir(), ".talome", "coredns");

/* ── Config generation ─────────────────────────────────────────────────────── */

function generateCorefile(baseDomain: string): string {
  return `${baseDomain} {
    file /etc/coredns/db.${baseDomain}
    template IN AAAA ${baseDomain} {
        rcode NOERROR
    }
    log
}

. {
    forward . 1.1.1.1 8.8.8.8
    cache 30
    log
}
`;
}

function generateZoneFile(baseDomain: string, serverIp: string): string {
  const serial = Math.floor(Date.now() / 1000);
  return `$ORIGIN ${baseDomain}.
@       IN SOA  ns.${baseDomain}. admin.${baseDomain}. (
                ${serial}  ; serial
                3600       ; refresh
                600        ; retry
                86400      ; expire
                60         ; minimum TTL
        )
        IN NS   ns.${baseDomain}.
        IN A    ${serverIp}
*       IN A    ${serverIp}
ns      IN A    ${serverIp}
`;
}

function writeConfigIfChanged(path: string, content: string): boolean {
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  if (existing === content) return false;
  writeFileSync(path, content);
  return true;
}

/* ── Container lifecycle ───────────────────────────────────────────────────── */

export async function ensureDnsRunning(baseDomain: string, serverIp: string): Promise<{ ok: boolean; error?: string }> {
  mkdirSync(DNS_DIR, { recursive: true });

  const corefilePath = join(DNS_DIR, "Corefile");
  const zoneFilePath = join(DNS_DIR, `db.${baseDomain}`);

  // Write config files
  writeFileSync(corefilePath, generateCorefile(baseDomain));
  writeFileSync(zoneFilePath, generateZoneFile(baseDomain, serverIp));

  // Check if container already exists
  try {
    const container = docker.getContainer(DNS_CONTAINER_NAME);
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    }
    return { ok: true };
  } catch {
    // Container doesn't exist — create it
  }

  try {
    // Pull image
    try {
      const stream = await docker.pull(DNS_IMAGE);
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err: Error | null) => err ? reject(err) : resolve(undefined));
      });
    } catch {
      // Image might already exist locally
    }

    const container = await docker.createContainer({
      name: DNS_CONTAINER_NAME,
      Image: DNS_IMAGE,
      Cmd: ["-conf", "/etc/coredns/Corefile"],
      HostConfig: {
        Binds: [
          `${DNS_DIR}:/etc/coredns:ro`,
        ],
        PortBindings: {
          "53/udp": [{ HostPort: "53" }],
          "53/tcp": [{ HostPort: "53" }],
        },
        RestartPolicy: { Name: "unless-stopped" },
      },
      ExposedPorts: {
        "53/udp": {},
        "53/tcp": {},
      },
      Labels: {
        "talome.managed": "true",
        "talome.role": "dns",
      },
    });

    await container.start();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export async function writeDnsConfigAndReload(baseDomain = "talome.local"): Promise<void> {
  const serverIp = getServerLanIp();

  const corefilePath = join(DNS_DIR, "Corefile");
  const zoneFilePath = join(DNS_DIR, `db.${baseDomain}`);

  const corefileChanged = writeConfigIfChanged(corefilePath, generateCorefile(baseDomain));
  const zoneChanged = writeConfigIfChanged(zoneFilePath, generateZoneFile(baseDomain, serverIp));

  if (!corefileChanged && !zoneChanged) return;

  // Reload CoreDNS — it watches for SIGUSR1
  try {
    const container = docker.getContainer(DNS_CONTAINER_NAME);
    const info = await container.inspect();
    if (info.State.Running) {
      await container.kill({ signal: "SIGUSR1" });
    }
  } catch {
    // Container not running
  }
}

export async function getDnsStatus(): Promise<{
  running: boolean;
  serverIp: string;
  baseDomain: string;
}> {
  const serverIp = getServerLanIp();
  try {
    const container = docker.getContainer(DNS_CONTAINER_NAME);
    const info = await container.inspect();
    return {
      running: info.State.Running,
      serverIp,
      baseDomain: "talome.local",
    };
  } catch {
    return { running: false, serverIp, baseDomain: "talome.local" };
  }
}

export async function stopDns(): Promise<void> {
  try {
    const container = docker.getContainer(DNS_CONTAINER_NAME);
    await container.stop();
    await container.remove();
  } catch {
    // Not running
  }
}

/* ── IP change monitoring ──────────────────────────────────────────────────── */

let lastKnownIp: string | null = null;

export function startIpMonitor(baseDomain: string, intervalMs = 60_000): () => void {
  lastKnownIp = getServerLanIp();

  const timer = setInterval(async () => {
    const currentIp = getServerLanIp();
    if (lastKnownIp && currentIp !== lastKnownIp) {
      console.log(`[dns] IP changed: ${lastKnownIp} -> ${currentIp}`);
      lastKnownIp = currentIp;

      // Regenerate zone file with new IP
      const zoneFilePath = join(DNS_DIR, `db.${baseDomain}`);
      writeFileSync(zoneFilePath, generateZoneFile(baseDomain, currentIp));

      // Reload CoreDNS
      try {
        const container = docker.getContainer(DNS_CONTAINER_NAME);
        const info = await container.inspect();
        if (info.State.Running) {
          await container.kill({ signal: "SIGUSR1" });
        }
      } catch {
        // Container not running
      }
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
