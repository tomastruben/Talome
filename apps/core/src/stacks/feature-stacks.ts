import { getSetting } from "../utils/settings.js";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { listContainers } from "../docker/client.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface FeatureStackDep {
  appId: string;
  role: string;
  required: boolean;
  alternatives?: string[];
  configKey: string;
  label: string;
}

export interface FeatureStack {
  id: string;
  name: string;
  description: string;
  deps: FeatureStackDep[];
  dashboardPage: string;
}

export type DepStatus = "not-installed" | "installed-not-configured" | "configured" | "error";

export interface DepStatusResult {
  appId: string;
  role: string;
  label: string;
  required: boolean;
  status: DepStatus;
  alternatives?: string[];
}

export interface StackStatusResult {
  id: string;
  name: string;
  description: string;
  readiness: number;
  dashboardPage: string;
  deps: DepStatusResult[];
}

// ── Stack definitions ────────────────────────────────────────────────────────

const FEATURE_STACKS: FeatureStack[] = [
  {
    id: "media",
    name: "Media",
    description: "Stream, download, and manage TV shows, movies, and requests.",
    dashboardPage: "/dashboard/media",
    deps: [
      {
        appId: "jellyfin",
        role: "media-server",
        required: true,
        alternatives: ["plex"],
        configKey: "jellyfin_url",
        label: "Media Server",
      },
      {
        appId: "sonarr",
        role: "tv-manager",
        required: true,
        configKey: "sonarr_url",
        label: "TV Manager",
      },
      {
        appId: "radarr",
        role: "movie-manager",
        required: true,
        configKey: "radarr_url",
        label: "Movie Manager",
      },
      {
        appId: "prowlarr",
        role: "indexer-manager",
        required: true,
        configKey: "prowlarr_url",
        label: "Indexer Manager",
      },
      {
        appId: "qbittorrent",
        role: "download-client",
        required: true,
        configKey: "qbittorrent_url",
        label: "Download Client",
      },
      {
        appId: "overseerr",
        role: "request-manager",
        required: false,
        configKey: "overseerr_url",
        label: "Request Manager",
      },
    ],
  },
  {
    id: "audiobooks",
    name: "Audiobooks",
    description: "Listen to and manage your audiobook library.",
    dashboardPage: "/dashboard/audiobooks",
    deps: [
      {
        appId: "audiobookshelf",
        role: "audiobook-server",
        required: true,
        configKey: "audiobookshelf_url",
        label: "Audiobook Server",
      },
    ],
  },
  {
    id: "smart-home",
    name: "Smart Home",
    description: "Automate your home and manage IoT devices.",
    dashboardPage: "/dashboard/smart-home",
    deps: [
      {
        appId: "homeassistant",
        role: "home-automation",
        required: true,
        configKey: "homeassistant_url",
        label: "Home Automation",
      },
      {
        appId: "pihole",
        role: "dns-blocker",
        required: false,
        configKey: "pihole_url",
        label: "DNS Blocker",
      },
    ],
  },
  {
    id: "privacy",
    name: "Privacy",
    description: "Block ads at the DNS level and manage passwords securely.",
    dashboardPage: "/dashboard/privacy",
    deps: [
      {
        appId: "pihole",
        role: "dns-blocker",
        required: true,
        configKey: "pihole_url",
        label: "DNS Blocker",
      },
      {
        appId: "vaultwarden",
        role: "password-manager",
        required: true,
        configKey: "vaultwarden_url",
        label: "Password Manager",
      },
    ],
  },
  {
    id: "books",
    name: "Books & Audiobooks",
    description: "Listen to audiobooks, manage ebook libraries, and automate book downloads.",
    dashboardPage: "/dashboard/audiobooks",
    deps: [
      {
        appId: "audiobookshelf",
        role: "audiobook-server",
        required: true,
        configKey: "audiobookshelf_url",
        label: "Audiobook Server",
      },
      {
        appId: "readarr",
        role: "book-manager",
        required: false,
        configKey: "readarr_url",
        label: "Book Manager",
      },
    ],
  },
];

// ── Config keys for alternatives (appId → settingsKey) ───────────────────────

const ALT_CONFIG_KEYS: Record<string, string> = {
  plex: "plex_url",
  jellyfin: "jellyfin_url",
};

// ── Status resolution ────────────────────────────────────────────────────────

/**
 * Build a set of app IDs that appear as running Docker containers.
 * Falls back to an empty set if Docker is unreachable.
 */
async function buildContainerSet(): Promise<Set<string>> {
  try {
    const containers = await listContainers();
    const names = new Set<string>();
    for (const c of containers) {
      names.add(c.name);
      // Also match by image name (e.g. "linuxserver/jellyfin:10.10.6" → "jellyfin")
      const imageName = c.image.split("/").pop()?.split(":")[0] ?? "";
      names.add(imageName.replace(/-/g, "").toLowerCase());
    }
    return names;
  } catch {
    return new Set();
  }
}

/**
 * Build a set of app IDs from the installed_apps DB table.
 * Falls back to an empty set if the query fails.
 */
function buildInstalledDbSet(): Set<string> {
  try {
    const rows = db.all(sql`SELECT app_id FROM installed_apps`) as { app_id: string }[];
    return new Set(rows.map((r) => r.app_id));
  } catch {
    return new Set();
  }
}

/**
 * Check whether an app is configured (has a setting value),
 * installed (in DB or Docker), or not present at all.
 */
function resolveDepStatus(
  appId: string,
  configKey: string,
  installedDbSet: Set<string>,
  containerSet: Set<string>,
): DepStatus {
  // Configured: the settings key has a value
  const settingValue = getSetting(configKey);
  if (settingValue) return "configured";

  // Installed but not configured: present in DB or Docker
  const normalizedAppId = appId.replace(/-/g, "").toLowerCase();
  if (installedDbSet.has(appId) || containerSet.has(appId) || containerSet.has(normalizedAppId)) {
    return "installed-not-configured";
  }

  return "not-installed";
}

/**
 * Check if any alternative for a dep is configured.
 */
function isAlternativeConfigured(
  alternatives: string[] | undefined,
  installedDbSet: Set<string>,
  containerSet: Set<string>,
): boolean {
  if (!alternatives || alternatives.length === 0) return false;
  for (const altAppId of alternatives) {
    const altConfigKey = ALT_CONFIG_KEYS[altAppId];
    if (!altConfigKey) continue;
    const status = resolveDepStatus(altAppId, altConfigKey, installedDbSet, containerSet);
    if (status === "configured") return true;
  }
  return false;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the status of all feature stacks, including per-dep status
 * and a readiness score (0-1) based on required deps that are satisfied.
 *
 * Resilient: if Docker or DB is unreachable, returns defaults gracefully.
 */
export async function getFeatureStackStatus(): Promise<StackStatusResult[]> {
  let installedDbSet: Set<string>;
  let containerSet: Set<string>;

  try {
    [installedDbSet, containerSet] = await Promise.all([
      Promise.resolve(buildInstalledDbSet()),
      buildContainerSet(),
    ]);
  } catch {
    installedDbSet = new Set();
    containerSet = new Set();
  }

  return FEATURE_STACKS.map((stack) => {
    const deps: DepStatusResult[] = stack.deps.map((dep) => {
      const status = resolveDepStatus(dep.appId, dep.configKey, installedDbSet, containerSet);
      return {
        appId: dep.appId,
        role: dep.role,
        label: dep.label,
        required: dep.required,
        status,
        alternatives: dep.alternatives,
      };
    });

    // Readiness: count of satisfied required deps / total required deps
    const requiredDeps = deps.filter((d) => d.required);
    const satisfiedCount = requiredDeps.filter((d) => {
      if (d.status === "configured") return true;
      // Check if any alternative is configured
      return isAlternativeConfigured(d.alternatives, installedDbSet, containerSet);
    }).length;

    const readiness = requiredDeps.length > 0 ? satisfiedCount / requiredDeps.length : 1;

    return {
      id: stack.id,
      name: stack.name,
      description: stack.description,
      readiness,
      dashboardPage: stack.dashboardPage,
      deps,
    };
  });
}

/**
 * Returns the raw feature stack definitions (no status resolution).
 */
export function getFeatureStacks(): FeatureStack[] {
  return FEATURE_STACKS;
}
