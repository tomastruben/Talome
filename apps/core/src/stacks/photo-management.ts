import type { TalomeStack } from "@talome/types";

export const photoManagementStack: TalomeStack = {
  id: "photo-management",
  name: "Photo Management",
  description:
    "Self-hosted photo and video management with AI-powered search, face recognition, mobile backup, and a beautiful gallery. Immich replaces Google Photos, PhotoPrism adds powerful AI tagging, and Syncthing keeps your devices in sync.",
  tagline: "Your memories. Your storage. AI-powered search.",
  author: "talome",
  tags: ["photos", "backup", "immich", "gallery", "sync"],
  version: "1.0.0",
  createdAt: "2026-03-01T00:00:00Z",
  apps: [
    {
      appId: "immich",
      name: "Immich",
      compose: `services:
  immich-server:
    image: ghcr.io/immich-app/immich-server:v1.134.0
    container_name: immich
    restart: unless-stopped
    ports:
      - "2283:2283"
    volumes:
      - immich-upload:/usr/src/app/upload
    environment:
      - DB_HOSTNAME=immich-postgres
      - DB_USERNAME=postgres
      - DB_PASSWORD=postgres
      - DB_DATABASE_NAME=immich
      - REDIS_HOSTNAME=immich-redis
    depends_on:
      - immich-redis
      - immich-postgres
  immich-redis:
    image: docker.io/redis:7.4-alpine
    container_name: immich-redis
    restart: unless-stopped
    volumes:
      - immich-redis:/data
    healthcheck:
      test: redis-cli ping || exit 1
  immich-postgres:
    image: docker.io/tensorchord/pgvecto-rs:pg14-v0.2.0
    container_name: immich-postgres
    restart: unless-stopped
    volumes:
      - immich-postgres:/var/lib/postgresql/data
    environment:
      - POSTGRES_PASSWORD=postgres
      - POSTGRES_USER=postgres
      - POSTGRES_DB=immich
      - POSTGRES_INITDB_ARGS=--data-checksums
volumes:
  immich-upload:
  immich-redis:
  immich-postgres:
`,
      configSchema: {
        envVars: [
          { key: "DB_PASSWORD", description: "PostgreSQL password", required: false, defaultValue: "postgres" },
        ],
      },
    },
    {
      appId: "photoprism",
      name: "PhotoPrism",
      compose: `services:
  photoprism:
    image: photoprism/photoprism:250320
    container_name: photoprism
    restart: unless-stopped
    ports:
      - "2342:2342"
    volumes:
      - photoprism-storage:/photoprism/storage
      - /data/media/photos:/photoprism/originals:ro
    environment:
      - PHOTOPRISM_ADMIN_USER=admin
      - PHOTOPRISM_ADMIN_PASSWORD=changeme
      - PHOTOPRISM_SITE_URL=http://localhost:2342/
      - PHOTOPRISM_ORIGINALS_LIMIT=5000
      - PHOTOPRISM_RESOLUTION_LIMIT=150
      - PHOTOPRISM_DETECT_NSFW=false
      - PHOTOPRISM_EXPERIMENTAL=false
      - PHOTOPRISM_DATABASE_DRIVER=sqlite
volumes:
  photoprism-storage:
`,
      configSchema: {
        envVars: [
          { key: "PHOTOPRISM_ADMIN_USER", description: "Admin username", required: false, defaultValue: "admin" },
          { key: "PHOTOPRISM_ADMIN_PASSWORD", description: "Admin password", required: true, secret: true, defaultValue: "changeme" },
        ],
      },
    },
    {
      appId: "syncthing",
      name: "Syncthing",
      compose: `services:
  syncthing:
    image: linuxserver/syncthing:1.29.5
    container_name: syncthing
    restart: unless-stopped
    ports:
      - "8384:8384"
      - "22000:22000/tcp"
      - "22000:22000/udp"
      - "21027:21027/udp"
    volumes:
      - syncthing-config:/config
      - /data/media/photos:/data/photos
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/London
volumes:
  syncthing-config:
`,
      configSchema: {
        envVars: [
          { key: "PUID", description: "User ID", required: false, defaultValue: "1000" },
          { key: "PGID", description: "Group ID", required: false, defaultValue: "1000" },
          { key: "TZ", description: "Timezone", required: false, defaultValue: "Europe/London" },
        ],
      },
    },
  ],
  postInstallPrompt: `The Photo Management stack is installed:
- Immich (port 2283): Create your admin account, then install the mobile app for automatic backup. This is your primary photo management tool.
- PhotoPrism (port 2342): Login with admin/changeme (change password immediately). Point it at your photo library for AI-powered tagging and search.
- Syncthing (port 8384): Set up folder synchronization between your devices. Share the photos folder with your phone or laptop for continuous backup.

Recommend the user change default passwords immediately.`,
};
