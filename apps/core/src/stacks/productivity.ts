import type { TalomeStack } from "@talome/types";

export const productivityStack: TalomeStack = {
  id: "productivity",
  name: "Productivity",
  description:
    "Digitize and organize your documents with AI-powered OCR, tagging, and full-text search. Plus a complete PDF toolbox for merging, splitting, and converting files.",
  tagline: "Paperless office. Intelligent document management.",
  author: "talome",
  tags: ["documents", "productivity", "ocr", "pdf"],
  version: "1.0.0",
  createdAt: "2026-03-01T00:00:00Z",
  apps: [
    {
      appId: "paperless-ngx",
      name: "Paperless-ngx",
      compose: `services:
  paperless-redis:
    image: docker.io/redis:7.4-alpine
    container_name: paperless-redis
    restart: unless-stopped
    volumes:
      - paperless-redis:/data
  paperless-ngx:
    image: ghcr.io/paperless-ngx/paperless-ngx:2.16
    container_name: paperless-ngx
    restart: unless-stopped
    ports:
      - "8010:8000"
    volumes:
      - paperless-data:/usr/src/paperless/data
      - paperless-media:/usr/src/paperless/media
      - paperless-consume:/usr/src/paperless/consume
      - paperless-export:/usr/src/paperless/export
    environment:
      - PAPERLESS_REDIS=redis://paperless-redis:6379
      - PAPERLESS_ADMIN_USER=admin
      - PAPERLESS_ADMIN_PASSWORD=changeme
      - PAPERLESS_OCR_LANGUAGE=eng
      - PAPERLESS_TIME_ZONE=Europe/London
      - USERMAP_UID=1000
      - USERMAP_GID=1000
    depends_on:
      - paperless-redis
volumes:
  paperless-redis:
  paperless-data:
  paperless-media:
  paperless-consume:
  paperless-export:
`,
      configSchema: {
        envVars: [
          { key: "PAPERLESS_ADMIN_USER", description: "Admin username", required: false, defaultValue: "admin" },
          { key: "PAPERLESS_ADMIN_PASSWORD", description: "Admin password", required: true, secret: true, defaultValue: "changeme" },
          { key: "PAPERLESS_OCR_LANGUAGE", description: "OCR language (eng, deu, fra, etc.)", required: false, defaultValue: "eng" },
        ],
      },
    },
    {
      appId: "stirling-pdf",
      name: "Stirling PDF",
      compose: `services:
  stirling-pdf:
    image: frooodle/s-pdf:0.38.2
    container_name: stirling-pdf
    restart: unless-stopped
    ports:
      - "8012:8080"
    volumes:
      - stirling-data:/usr/share/tessdata
    environment:
      - DOCKER_ENABLE_SECURITY=false
volumes:
  stirling-data:
`,
      configSchema: { envVars: [] },
    },
  ],
  postInstallPrompt:
    "The Productivity stack is installed. Paperless-ngx is on port 8010 (admin/changeme — change the password immediately). Drop documents into the consume directory for automatic OCR and filing. Stirling PDF is on port 8012 for PDF tools.",
};
