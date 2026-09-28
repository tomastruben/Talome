import type { TalomeStack } from "@talome/types";

export const photoManagementStack: TalomeStack = {
  id: "photo-management",
  name: "Photo Management",
  description:
    "Self-hosted photo and video management with AI-powered search, face recognition, mobile backup, and a beautiful gallery. Immich replaces Google Photos, PhotoPrism adds powerful AI tagging, and Syncthing keeps your devices in sync.",
  tagline: "Your memories. Your storage. AI-powered search.",
  author: "talome",
  tags: ["photos", "backup", "immich", "gallery", "sync"],
  version: "1.1.0",
  createdAt: "2026-03-01T00:00:00Z",
  apps: [
    {
      appId: "immich",
      name: "Immich",
      // Mirrors Immich's official docker-compose (server + machine-learning +
      // valkey + postgres with VectorChord). Server and ML must run the same
      // version — both follow IMMICH_VERSION. The postgres image also ships
      // pgvecto.rs so older pgvecto-rs databases migrate automatically.
      // Time zone comes from TZ, not an /etc/localtime bind (Docker Desktop on
      // macOS rejects binds of unshared host paths).
      compose: `services:
  immich-server:
    image: ghcr.io/immich-app/immich-server:\${IMMICH_VERSION:-v2.0.0}
    container_name: immich
    restart: unless-stopped
    ports:
      - "2283:2283"
    volumes:
      - \${UPLOAD_LOCATION:-./library}:/data
    environment:
      - TZ=\${TZ:-America/New_York}
      - DB_HOSTNAME=immich-postgres
      - DB_USERNAME=postgres
      - DB_PASSWORD=\${DB_PASSWORD}
      - DB_DATABASE_NAME=immich
      - REDIS_HOSTNAME=immich-redis
    depends_on:
      - immich-redis
      - immich-postgres
    healthcheck:
      disable: false
  immich-machine-learning:
    image: ghcr.io/immich-app/immich-machine-learning:\${IMMICH_VERSION:-v2.0.0}
    container_name: immich-machine-learning
    restart: unless-stopped
    volumes:
      - ./model-cache:/cache
    environment:
      - TZ=\${TZ:-America/New_York}
    healthcheck:
      disable: false
  immich-redis:
    image: docker.io/valkey/valkey:8-bookworm
    container_name: immich-redis
    restart: unless-stopped
    healthcheck:
      test: redis-cli ping || exit 1
  immich-postgres:
    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0
    container_name: immich-postgres
    restart: unless-stopped
    shm_size: 128mb
    volumes:
      - \${DB_DATA_LOCATION:-./postgres}:/var/lib/postgresql/data
    environment:
      - POSTGRES_PASSWORD=\${DB_PASSWORD}
      - POSTGRES_USER=postgres
      - POSTGRES_DB=immich
      - POSTGRES_INITDB_ARGS=--data-checksums
`,
      configSchema: {
        envVars: [
          {
            key: "UPLOAD_LOCATION",
            description:
              "Where photos and videos are stored. Ask the user which drive to use and give an absolute folder on it (e.g. /mnt/photos/immich or /Volumes/Photos/immich); keep ./library to store them in Talome's app data. Needs room for the whole camera roll.",
            required: false,
            defaultValue: "./library",
          },
          {
            key: "DB_DATA_LOCATION",
            description: "Immich database folder. Keep it on a local SSD — never a network share (SMB/NFS corrupts Postgres).",
            required: false,
            defaultValue: "./postgres",
          },
          {
            key: "DB_PASSWORD",
            description: "Internal database password — generate a random alphanumeric value (A–Z, a–z, 0–9 only). Users never type it.",
            required: true,
            secret: true,
          },
          {
            key: "IMMICH_VERSION",
            description: "Immich release for both server and machine-learning (they must match). Upgrade by bumping this after reading the release notes.",
            required: false,
            defaultValue: "v2.0.0",
          },
          { key: "TZ", description: "Timezone (used for photo dates)", required: false, defaultValue: "America/New_York" },
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
  postInstallPrompt: `The Photo Management stack is installed. Finish setup so the user gets working phone backup, not just running containers:

1. Immich (port 2283) — the first account created at http://<server>:2283 becomes the admin; have the user create it now.
2. Connect Immich to Talome: save immich_url (http://localhost:2283) and ask the user to create an API key in Immich → Account Settings → API Keys, then save it as immich_api_key.
3. Phone backup (iPhone and Android):
   - Install "Immich" from the App Store or Google Play.
   - Server URL: at home use http://<server-LAN-IP>:2283. For backup away from home, expose Immich through Tailscale or Talome's reverse proxy and use that https URL instead; set it as the External Domain in Immich → Administration → Settings → Server (or save it as immich_external_url in Talome).
   - Log in, open the cloud icon → select albums (Recents / Camera Roll) → enable Backup.
   - iPhone: enable Background Backup in the app and Background App Refresh in iOS Settings; iOS only backs up in the background occasionally, so open the app now and then (Low Power Mode pauses it).
   - Android: enable Background Backup and set battery usage for Immich to "Unrestricted"; optionally require Wi-Fi/charging.
4. PhotoPrism (port 2342): login admin / the configured password and change it immediately.
5. Syncthing (port 8384): optional folder sync between devices.

Then call verify_app_outcome with stackId "photo-management" and fix any failed or degraded checks (storage drive, phone-reachable URL) before telling the user it's done.`,
};
