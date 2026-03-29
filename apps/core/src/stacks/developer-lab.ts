import type { TalomeStack } from "@talome/types";

export const developerLabStack: TalomeStack = {
  id: "developer-lab",
  name: "Developer Lab",
  description:
    "A self-hosted developer toolchain: Gitea for Git hosting, a private Docker Registry for container images, and Portainer for Docker management.",
  tagline: "Ship code. Own your infrastructure.",
  author: "talome",
  tags: ["developer", "git", "registry", "devops"],
  version: "1.0.0",
  createdAt: "2026-03-01T00:00:00Z",
  apps: [
    {
      appId: "gitea",
      name: "Gitea",
      compose: `services:
  gitea:
    image: gitea/gitea:1.23.5
    container_name: gitea
    restart: unless-stopped
    ports:
      - "3030:3000"
      - "2222:22"
    volumes:
      - gitea-data:/data
    environment:
      - USER_UID=1000
      - USER_GID=1000
      - GITEA__database__DB_TYPE=sqlite3
      - GITEA__server__DOMAIN=localhost
      - GITEA__server__SSH_PORT=2222
      - GITEA__server__HTTP_PORT=3000
volumes:
  gitea-data:
`,
      configSchema: {
        envVars: [
          { key: "USER_UID", description: "User ID", required: false, defaultValue: "1000" },
          { key: "USER_GID", description: "Group ID", required: false, defaultValue: "1000" },
          { key: "GITEA__server__DOMAIN", description: "Your server domain or IP", required: false, defaultValue: "localhost" },
        ],
      },
    },
    {
      appId: "registry",
      name: "Docker Registry",
      compose: `services:
  registry:
    image: registry:2
    container_name: registry
    restart: unless-stopped
    ports:
      - "5000:5000"
    volumes:
      - registry-data:/var/lib/registry
volumes:
  registry-data:
`,
      configSchema: { envVars: [] },
    },
  ],
};
