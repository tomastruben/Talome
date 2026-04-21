import type { TalomeStack } from "@talome/types";

export const mediaServerStack: TalomeStack = {
  id: "media-server",
  name: "Media Server",
  description:
    "A complete self-hosted media stack: Jellyfin for streaming, Sonarr/Radarr for automated TV and movie downloads, Prowlarr for indexers, qBittorrent for downloads, and Overseerr for request management.",
  tagline: "Stream everything. Download automatically. Request from your phone.",
  author: "talome",
  tags: ["media", "streaming", "arr-stack", "jellyfin"],
  version: "1.0.0",
  createdAt: "2026-03-01T00:00:00Z",
  apps: [
    {
      appId: "jellyfin",
      name: "Jellyfin",
      compose: `services:
  jellyfin:
    image: linuxserver/jellyfin:10.10.6
    container_name: jellyfin
    restart: unless-stopped
    ports:
      - "8096:8096"
    volumes:
      - jellyfin-config:/config
      - /data/media:/data/media:ro
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/London
volumes:
  jellyfin-config:
`,
      configSchema: {
        envVars: [
          { key: "PUID", description: "User ID for file permissions", required: false, defaultValue: "1000" },
          { key: "PGID", description: "Group ID for file permissions", required: false, defaultValue: "1000" },
          { key: "TZ", description: "Timezone", required: false, defaultValue: "Europe/London" },
        ],
      },
    },
    {
      appId: "sonarr",
      name: "Sonarr",
      compose: `services:
  sonarr:
    image: linuxserver/sonarr:4.0.14
    container_name: sonarr
    restart: unless-stopped
    ports:
      - "8989:8989"
    volumes:
      - sonarr-config:/config
      - /data/media/tv:/data/media/tv
      - /data/downloads:/downloads
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/London
volumes:
  sonarr-config:
`,
      configSchema: {
        envVars: [
          { key: "PUID", description: "User ID", required: false, defaultValue: "1000" },
          { key: "PGID", description: "Group ID", required: false, defaultValue: "1000" },
          { key: "TZ", description: "Timezone", required: false, defaultValue: "Europe/London" },
        ],
      },
    },
    {
      appId: "radarr",
      name: "Radarr",
      compose: `services:
  radarr:
    image: linuxserver/radarr:5.21.1
    container_name: radarr
    restart: unless-stopped
    ports:
      - "7878:7878"
    volumes:
      - radarr-config:/config
      - /data/media/movies:/data/media/movies
      - /data/downloads:/downloads
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/London
volumes:
  radarr-config:
`,
      configSchema: {
        envVars: [
          { key: "PUID", description: "User ID", required: false, defaultValue: "1000" },
          { key: "PGID", description: "Group ID", required: false, defaultValue: "1000" },
          { key: "TZ", description: "Timezone", required: false, defaultValue: "Europe/London" },
        ],
      },
    },
    {
      appId: "prowlarr",
      name: "Prowlarr",
      compose: `services:
  prowlarr:
    image: linuxserver/prowlarr:1.31.2
    container_name: prowlarr
    restart: unless-stopped
    ports:
      - "9696:9696"
    volumes:
      - prowlarr-config:/config
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/London
volumes:
  prowlarr-config:
`,
      configSchema: {
        envVars: [
          { key: "PUID", description: "User ID", required: false, defaultValue: "1000" },
          { key: "PGID", description: "Group ID", required: false, defaultValue: "1000" },
          { key: "TZ", description: "Timezone", required: false, defaultValue: "Europe/London" },
        ],
      },
    },
    {
      appId: "qbittorrent",
      name: "qBittorrent",
      compose: `services:
  qbittorrent:
    image: linuxserver/qbittorrent:5.0.4
    container_name: qbittorrent
    restart: unless-stopped
    ports:
      - "8080:8080"
      - "6881:6881"
      - "6881:6881/udp"
    volumes:
      - qbittorrent-config:/config
      - /data/downloads:/downloads
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/London
      - WEBUI_PORT=8080
volumes:
  qbittorrent-config:
`,
      configSchema: {
        envVars: [
          { key: "PUID", description: "User ID", required: false, defaultValue: "1000" },
          { key: "PGID", description: "Group ID", required: false, defaultValue: "1000" },
          { key: "TZ", description: "Timezone", required: false, defaultValue: "Europe/London" },
        ],
      },
    },
    {
      appId: "overseerr",
      name: "Overseerr",
      compose: `services:
  overseerr:
    image: sctx/overseerr:1.33.2
    container_name: overseerr
    restart: unless-stopped
    ports:
      - "5055:5055"
    volumes:
      - overseerr-config:/app/config
    environment:
      - TZ=Europe/London
      - LOG_LEVEL=info
volumes:
  overseerr-config:
`,
      configSchema: {
        envVars: [
          { key: "TZ", description: "Timezone", required: false, defaultValue: "Europe/London" },
        ],
      },
    },
  ],
  postInstallPrompt: `The Media Server stack has been installed successfully. Now configure it automatically:
1. Add root folder /data/media/tv to Sonarr
2. Add root folder /data/media/movies to Radarr
3. Connect qBittorrent to Sonarr as a download client
4. Connect qBittorrent to Radarr as a download client
5. Sync Prowlarr indexers to both Sonarr and Radarr
6. Connect Overseerr to Jellyfin
7. Add Sonarr and Radarr as servers in Overseerr
Please complete all these steps now using the available tools.`,
};
