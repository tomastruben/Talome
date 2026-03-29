import type { TalomeStack } from "@talome/types";

export const monitoringStack: TalomeStack = {
  id: "monitoring",
  name: "Monitoring",
  description:
    "Monitor your services and system health. Uptime Kuma tracks service availability with notifications, Netdata provides real-time system metrics and performance graphs.",
  tagline: "Know before it breaks.",
  author: "talome",
  tags: ["monitoring", "uptime", "metrics", "alerts"],
  version: "1.0.0",
  createdAt: "2026-03-01T00:00:00Z",
  apps: [
    {
      appId: "uptime-kuma",
      name: "Uptime Kuma",
      compose: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:1.23.16
    container_name: uptime-kuma
    restart: unless-stopped
    ports:
      - "3001:3001"
    volumes:
      - uptime-kuma-data:/app/data
volumes:
  uptime-kuma-data:
`,
      configSchema: { envVars: [] },
    },
    {
      appId: "netdata",
      name: "Netdata",
      compose: `services:
  netdata:
    image: netdata/netdata:v2.4
    container_name: netdata
    restart: unless-stopped
    ports:
      - "19999:19999"
    cap_add:
      - SYS_PTRACE
      - SYS_ADMIN
    security_opt:
      - apparmor:unconfined
    volumes:
      - netdata-config:/etc/netdata
      - netdata-lib:/var/lib/netdata
      - netdata-cache:/var/cache/netdata
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /etc/os-release:/host/etc/os-release:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
volumes:
  netdata-config:
  netdata-lib:
  netdata-cache:
`,
      configSchema: { envVars: [] },
    },
  ],
  postInstallPrompt:
    "The Monitoring stack is installed. Uptime Kuma is on port 3001 — create an admin account and add monitors for your services. Netdata is on port 19999 for real-time system metrics (CPU, memory, disk, network, Docker containers).",
};
