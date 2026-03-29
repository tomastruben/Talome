import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { db, schema } from "../db/index.js";
import { eq, and } from "drizzle-orm";

const USER_APPS_DIR = join(homedir(), ".talome", "user-apps");

export interface ExportedApp {
  manifest: Record<string, any>;
  dockerCompose: string;
  creator?: Record<string, any>;
  workspaceFiles?: { path: string; content: string }[];
}

function readWorkspaceFiles(root: string, relative = ""): { path: string; content: string }[] {
  const target = join(root, relative);
  const entries = readdirSync(target, { withFileTypes: true });
  const files: { path: string; content: string }[] = [];

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".talome-creator") continue;
    const nextRelative = relative ? join(relative, entry.name) : entry.name;
    const fullPath = join(root, nextRelative);

    if (entry.isDirectory()) {
      files.push(...readWorkspaceFiles(root, nextRelative));
      continue;
    }

    try {
      const stats = statSync(fullPath);
      if (stats.size > 200_000) continue;
      files.push({ path: nextRelative, content: readFileSync(fullPath, "utf-8") });
    } catch {
      // best effort
    }
  }

  return files;
}

export function exportApp(appId: string): { success: boolean; data?: ExportedApp; error?: string } {
  const appDir = join(USER_APPS_DIR, "apps", appId);

  const manifestPath = join(appDir, "manifest.json");
  const composePath = join(appDir, "docker-compose.yml");

  if (!existsSync(manifestPath)) {
    return { success: false, error: "App manifest not found" };
  }

  if (!existsSync(composePath)) {
    return { success: false, error: "Docker compose file not found" };
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const dockerCompose = readFileSync(composePath, "utf-8");
    const creatorPath = join(appDir, "creator.json");
    const creator = existsSync(creatorPath)
      ? JSON.parse(readFileSync(creatorPath, "utf-8"))
      : undefined;
    const workspaceFiles =
      creator?.workspace?.scaffoldPath && existsSync(creator.workspace.scaffoldPath)
        ? readWorkspaceFiles(creator.workspace.scaffoldPath)
        : undefined;

    return {
      success: true,
      data: { manifest, dockerCompose, creator, workspaceFiles },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export function exportAppAsBundle(appId: string): {
  success: boolean;
  bundle?: {
    format: "talome-app-v1";
    app: ExportedApp;
    metadata: {
      exportedAt: string;
      exportedFrom: string;
    };
  };
  error?: string;
} {
  const result = exportApp(appId);
  if (!result.success || !result.data) {
    return { success: false, error: result.error };
  }

  return {
    success: true,
    bundle: {
      format: "talome-app-v1",
      app: result.data,
      metadata: {
        exportedAt: new Date().toISOString(),
        exportedFrom: "talome",
      },
    },
  };
}
