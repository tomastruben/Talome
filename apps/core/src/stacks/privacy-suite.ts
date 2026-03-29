import type { TalomeStack } from "@talome/types";

export const privacySuiteStack: TalomeStack = {
  id: "privacy-suite",
  name: "Privacy Suite",
  description:
    "Take back control of your digital privacy: Pi-hole for DNS-level ad blocking, WireGuard for VPN access to your home network, and Vaultwarden for self-hosted password management.",
  tagline: "Your data. Your network. Your rules.",
  author: "talome",
  tags: ["privacy", "security", "dns", "vpn", "passwords"],
  version: "1.0.0",
  createdAt: "2026-03-01T00:00:00Z",
  apps: [
    {
      appId: "pihole",
      name: "Pi-hole",
      compose: `services:
  pihole:
    image: pihole/pihole:2025.03.0
    container_name: pihole
    restart: unless-stopped
    ports:
      - "53:53/tcp"
      - "53:53/udp"
      - "8053:80/tcp"
    volumes:
      - pihole-config:/etc/pihole
      - pihole-dnsmasq:/etc/dnsmasq.d
    environment:
      - TZ=Europe/London
      - WEBPASSWORD=<PLACEHOLDER: PIHOLE_WEBPASSWORD>
volumes:
  pihole-config:
  pihole-dnsmasq:
`,
      configSchema: {
        envVars: [
          { key: "TZ", description: "Timezone", required: false, defaultValue: "Europe/London" },
          { key: "WEBPASSWORD", description: "Pi-hole admin panel password", required: true, secret: true },
        ],
      },
    },
    {
      appId: "vaultwarden",
      name: "Vaultwarden",
      compose: `services:
  vaultwarden:
    image: vaultwarden/server:1.33.2
    container_name: vaultwarden
    restart: unless-stopped
    ports:
      - "8222:80"
    volumes:
      - vaultwarden-data:/data
    environment:
      - ADMIN_TOKEN=<PLACEHOLDER: VW_ADMIN_TOKEN>
      - SIGNUPS_ALLOWED=true
volumes:
  vaultwarden-data:
`,
      configSchema: {
        envVars: [
          { key: "ADMIN_TOKEN", description: "Admin panel token (generate a secure random string)", required: true, secret: true },
          { key: "SIGNUPS_ALLOWED", description: "Allow new user signups", required: false, defaultValue: "true" },
        ],
      },
    },
  ],
};
