import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AppManifest } from "@talome/types";
import type { StoreAdapter } from "./types.js";

export const talomeAdapter: StoreAdapter = {
  type: "talome",

  detect(storePath: string): boolean {
    return existsSync(join(storePath, "registry.json"));
  },

  parse(storePath: string, storeId: string): AppManifest[] {
    const registryPath = join(storePath, "registry.json");
    if (!existsSync(registryPath)) return [];

    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    const appIds: string[] = registry.apps || [];
    const results: AppManifest[] = [];

    for (const id of appIds) {
      try {
        const manifestPath = join(storePath, "apps", id, "manifest.json");
        if (!existsSync(manifestPath)) continue;

        const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
        const composePath = join(storePath, "apps", id, "docker-compose.yml");

        results.push({
          id: raw.id || id,
          name: raw.name || id,
          version: raw.version || "latest",
          tagline: raw.tagline || raw.description || "",
          description: raw.description || "",
          releaseNotes: raw.releaseNotes,
          icon: raw.icon || "📦",
          iconUrl: raw.iconUrl,
          coverUrl: raw.coverUrl,
          screenshots: raw.screenshots,
          category: raw.category || "other",
          author: raw.author || "Unknown",
          website: raw.website,
          repo: raw.repo,
          support: raw.support,
          source: "talome",
          storeId,
          composePath,
          image: raw.image,
          ports: (raw.ports || []).map((p: any) => ({
            host: p.host,
            container: p.container,
          })),
          volumes: (raw.volumes || []).map((v: any) => ({
            name: v.name,
            containerPath: v.containerPath,
            description: v.description,
            mediaVolume: v.mediaVolume,
          })),
          env: (raw.env || []).map((e: any) => ({
            key: e.key,
            label: e.label || e.key,
            required: e.required ?? false,
            default: e.default,
            secret: e.secret,
          })),
          architectures: raw.arm64 ? ["amd64", "arm64"] : ["amd64"],
          dependencies: raw.dependsOn || raw.dependencies,
          installNotes: raw.installNotes,
          defaultUsername: raw.defaultUsername,
          defaultPassword: raw.defaultPassword,
          webPort: raw.ports?.[0]?.host,
        });
      } catch {
        // Skip malformed manifests
      }
    }

    return results;
  },
};
