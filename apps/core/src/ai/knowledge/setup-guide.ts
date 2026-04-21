/**
 * Auto-generated setup guide injected into the AI system prompt
 * when users ask about configuring or troubleshooting apps.
 *
 * Stays in sync with the app registry — no stale docs.
 */

import { APP_REGISTRY } from "../../app-registry/index.js";

/** Generate a concise per-app settings reference from the registry. */
function generateAppReference(): string {
  const lines = Object.values(APP_REGISTRY).map((app) => {
    const keySource = app.configFilePath
      ? `auto-extract from ${app.configFilePath} (${app.apiKeyXPath})`
      : app.id === "jellyfin"
        ? "run jellyfin_create_api_key tool"
        : app.id === "audiobookshelf"
          ? "user's ABS Settings > Users > API token"
          : app.id === "homeassistant"
            ? "HA Settings > Long-Lived Access Tokens"
            : `set via set_setting("${app.apiKeySettingKey}", "<key>")`;
    const wires = app.relatesTo?.length ? ` → wires to: ${app.relatesTo.join(", ")}` : "";
    return `- **${app.name}**: URL=\`${app.apiBaseSettingKey}\` Key=\`${app.apiKeySettingKey}\` port=${app.commonPorts[0]}${wires}\n  API key: ${keySource}`;
  });
  return lines.join("\n");
}

const NETWORKING_GUIDE = `## Container networking
- Same Docker network: use container service name (e.g. \`http://sonarr:8989\`)
- Different network or host-to-container: use \`host.docker.internal\` (macOS) or bridge gateway IP (Linux)
- VPN containers (Gluetun): apps sharing \`network_mode: container:gluetun\` can't reach \`localhost\` — use service names or container IPs
- Port conflicts to watch: 8080 (qBittorrent vs Traefik), 80 (Pi-hole vs Caddy), 53 (Pi-hole vs CoreDNS)`;

const SETUP_SEQUENCE = `## Setup sequence
1. Install app (install_app) → wait for container healthy
2. Check health endpoint → confirm app is running
3. Get API key: arr apps auto-extract from config.xml; Jellyfin needs jellyfin_create_api_key; ABS from user settings
4. Store credentials: set_setting("<app>_url", "http://localhost:<port>") + set_setting("<app>_api_key", "<key>")
5. Wire related apps: wire_apps("sonarr", "qbittorrent") sets up download client, indexers, etc.
6. Media stack order: Prowlarr first (indexers) → Sonarr/Radarr (add root folders + download clients) → qBittorrent → Jellyfin (libraries) → Overseerr (connects to all)`;

/** Full setup guide — injected when user asks about setup/configuration. */
export function getSetupGuide(): string {
  return `## App settings reference
${generateAppReference()}

${NETWORKING_GUIDE}

${SETUP_SEQUENCE}`;
}
