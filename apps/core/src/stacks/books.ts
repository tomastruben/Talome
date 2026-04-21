import type { TalomeStack } from "@talome/types";

export const booksStack: TalomeStack = {
  id: "books",
  name: "Books & Audiobooks",
  description:
    "A complete self-hosted reading stack: Audiobookshelf for audiobooks with progress tracking, Readarr for automated book downloads, and Calibre-Web for ebook management.",
  tagline: "Read. Listen. Own your library.",
  author: "talome",
  tags: ["books", "audiobooks", "ebooks", "reading"],
  version: "1.0.0",
  createdAt: "2026-03-01T00:00:00Z",
  apps: [
    {
      appId: "audiobookshelf",
      name: "Audiobookshelf",
      compose: `services:
  audiobookshelf:
    image: ghcr.io/advplyr/audiobookshelf:2.19.6
    container_name: audiobookshelf
    restart: unless-stopped
    ports:
      - "13378:80"
    volumes:
      - audiobookshelf-config:/config
      - audiobookshelf-metadata:/metadata
      - /data/media/audiobooks:/audiobooks
volumes:
  audiobookshelf-config:
  audiobookshelf-metadata:
`,
      configSchema: { envVars: [] },
    },
    {
      appId: "readarr",
      name: "Readarr",
      compose: `services:
  readarr:
    image: linuxserver/readarr:0.4.12-develop
    container_name: readarr
    restart: unless-stopped
    ports:
      - "8787:8787"
    volumes:
      - readarr-config:/config
      - /data/media/books:/books
      - /data/downloads:/downloads
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/London
volumes:
  readarr-config:
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
      appId: "calibre-web",
      name: "Calibre-Web",
      compose: `services:
  calibre-web:
    image: linuxserver/calibre-web:0.6.24
    container_name: calibre-web
    restart: unless-stopped
    ports:
      - "8083:8083"
    volumes:
      - calibre-config:/config
      - /data/media/books:/books
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/London
volumes:
  calibre-config:
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
  postInstallPrompt:
    "The Books stack is installed. Audiobookshelf is on port 13378 — create an account and add your audiobook library at /audiobooks. Readarr is on port 8787 for automated book downloads (connect it to your download client). Calibre-Web is on port 8083 for ebook browsing (point it at your Calibre library database).",
};
