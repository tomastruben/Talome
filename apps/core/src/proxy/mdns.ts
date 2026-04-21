/**
 * Simplified Avahi/mDNS module.
 *
 * Only publishes the single base hostname (e.g. "talome.local") via mDNS
 * for zero-config server discovery on the LAN. Per-app subdomain resolution
 * is handled by CoreDNS (see dns.ts).
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { docker } from "../docker/client.js";
import { getServerLanIp } from "./ip.js";

const AVAHI_CONTAINER_NAME = "talome-avahi";
const AVAHI_IMAGE = "talome-avahi:local";
const AVAHI_DIR = join(os.homedir(), ".talome", "avahi");
const HOSTS_FILE = join(AVAHI_DIR, "hosts");

/* ── Build the Avahi image ───────────────────────────────────────────────── */

const DOCKERFILE = `FROM alpine:3.21
RUN apk add --no-cache avahi avahi-tools dbus
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
`;

const ENTRYPOINT = `#!/bin/sh
rm -f /run/dbus/pid /run/dbus/dbus.pid /run/dbus/system_bus_socket /run/avahi-daemon/pid

mkdir -p /run/dbus /run/avahi-daemon
dbus-daemon --system --nofork &

for i in 1 2 3 4 5; do
  [ -S /run/dbus/system_bus_socket ] && break
  sleep 1
done

avahi-daemon --daemonize --no-drop-root

for i in 1 2 3 4 5; do
  avahi-browse -t -r _http._tcp >/dev/null 2>&1 && break
  sleep 1
done

if [ -f /etc/avahi/hosts ]; then
  while IFS=' ' read -r ip hostname; do
    [ -z "$ip" ] && continue
    [ -z "$hostname" ] && continue
    case "$ip" in \\#*) continue ;; esac
    avahi-publish -a -R "$hostname" "$ip" &
    sleep 0.3
  done < /etc/avahi/hosts
fi
wait
`;

async function ensureAvahiImage(): Promise<void> {
  try {
    await docker.getImage(AVAHI_IMAGE).inspect();
    return;
  } catch {
    // Need to build
  }

  const buildDir = join(AVAHI_DIR, "build");
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(join(buildDir, "Dockerfile"), DOCKERFILE);
  writeFileSync(join(buildDir, "entrypoint.sh"), ENTRYPOINT);

  const stream = await docker.buildImage(
    { context: buildDir, src: ["Dockerfile", "entrypoint.sh"] },
    { t: AVAHI_IMAGE },
  );

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/* ── Container lifecycle ───────────────────────────────────────────────────── */

export async function ensureAvahiRunning(baseDomain?: string, serverIp?: string): Promise<{ ok: boolean; error?: string }> {
  mkdirSync(AVAHI_DIR, { recursive: true });

  // Write hosts file with single base hostname
  const ip = serverIp || getServerLanIp();
  const domain = baseDomain || "talome.local";
  writeFileSync(HOSTS_FILE, `${ip} ${domain}\n`);

  // Check if container already exists
  try {
    const container = docker.getContainer(AVAHI_CONTAINER_NAME);
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    } else {
      // Restart to pick up new hosts file
      await container.restart({ t: 2 });
    }
    return { ok: true };
  } catch {
    // Container doesn't exist — create it
  }

  try {
    await ensureAvahiImage();

    const container = await docker.createContainer({
      name: AVAHI_CONTAINER_NAME,
      Image: AVAHI_IMAGE,
      HostConfig: {
        NetworkMode: "host",
        Binds: [`${HOSTS_FILE}:/etc/avahi/hosts`],
        RestartPolicy: { Name: "unless-stopped" },
      },
      Labels: {
        "talome.managed": "true",
        "talome.role": "mdns",
      },
    });

    await container.start();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export async function getAvahiStatus(): Promise<{
  running: boolean;
  baseDomain: string;
  serverIp: string;
}> {
  const serverIp = getServerLanIp();
  try {
    const container = docker.getContainer(AVAHI_CONTAINER_NAME);
    const info = await container.inspect();
    return { running: info.State.Running, baseDomain: "talome.local", serverIp };
  } catch {
    return { running: false, baseDomain: "talome.local", serverIp };
  }
}

export async function stopAvahi(): Promise<void> {
  try {
    const container = docker.getContainer(AVAHI_CONTAINER_NAME);
    await container.stop();
    await container.remove();
  } catch {
    // Not running
  }
}
