export interface AppCapabilities {
  id: string;
  name: string;
  category: "media" | "smart-home" | "utility" | "privacy" | "productivity";
  /** Settings key for the base URL, e.g. "sonarr_url" */
  apiBaseSettingKey: string;
  /** Settings key for the API key, e.g. "sonarr_api_key" */
  apiKeySettingKey: string;
  healthEndpoint: string;
  configEndpoints: {
    rootFolders?: string;
    downloadClients?: string;
    indexers?: string;
    libraries?: string;
  };
  commonPorts: number[];
  /** Docker service name for inter-container DNS resolution */
  dockerServiceName?: string;
  setupGuideUrl: string;
  /** Prefix used for AI tool names, e.g. "arr_" */
  talomeToolPrefix: string;
  /** Related apps that this app can configure to talk to */
  relatesTo?: string[];
  /** Path to config file relative to app-data dir (e.g. "config/config.xml") */
  configFilePath?: string;
  /** XML tag containing the API key (e.g. "ApiKey") */
  apiKeyXPath?: string;
  /** How the setup loop can discover this app's API key */
  apiKeyDiscoveryMethod?: "config_xml" | "create" | "default_creds" | "user";
  /** Apps that must be configured before this one */
  setupDependsOn?: string[];
}

export const APP_REGISTRY: Record<string, AppCapabilities> = {
  sonarr: {
    id: "sonarr",
    name: "Sonarr",
    category: "media",
    apiBaseSettingKey: "sonarr_url",
    apiKeySettingKey: "sonarr_api_key",
    healthEndpoint: "/api/v3/health",
    configEndpoints: {
      rootFolders: "/api/v3/rootfolder",
      downloadClients: "/api/v3/downloadclient",
      indexers: "/api/v3/indexer",
    },
    commonPorts: [8989],
    dockerServiceName: "sonarr",
    setupGuideUrl: "https://wiki.servarr.com/sonarr",
    talomeToolPrefix: "arr_",
    relatesTo: ["qbittorrent", "prowlarr", "jellyfin"],
    configFilePath: "config/config.xml",
    apiKeyXPath: "ApiKey",
    apiKeyDiscoveryMethod: "config_xml",
    setupDependsOn: ["prowlarr"],
  },
  radarr: {
    id: "radarr",
    name: "Radarr",
    category: "media",
    apiBaseSettingKey: "radarr_url",
    apiKeySettingKey: "radarr_api_key",
    healthEndpoint: "/api/v3/health",
    configEndpoints: {
      rootFolders: "/api/v3/rootfolder",
      downloadClients: "/api/v3/downloadclient",
      indexers: "/api/v3/indexer",
    },
    commonPorts: [7878],
    dockerServiceName: "radarr",
    setupGuideUrl: "https://wiki.servarr.com/radarr",
    talomeToolPrefix: "arr_",
    relatesTo: ["qbittorrent", "prowlarr", "jellyfin"],
    configFilePath: "config/config.xml",
    apiKeyXPath: "ApiKey",
    apiKeyDiscoveryMethod: "config_xml",
    setupDependsOn: ["prowlarr"],
  },
  prowlarr: {
    id: "prowlarr",
    name: "Prowlarr",
    category: "media",
    apiBaseSettingKey: "prowlarr_url",
    apiKeySettingKey: "prowlarr_api_key",
    healthEndpoint: "/api/v1/health",
    configEndpoints: {
      indexers: "/api/v1/indexer",
    },
    commonPorts: [9696],
    dockerServiceName: "prowlarr",
    setupGuideUrl: "https://wiki.servarr.com/prowlarr",
    talomeToolPrefix: "arr_",
    relatesTo: ["sonarr", "radarr", "readarr"],
    configFilePath: "config/config.xml",
    apiKeyXPath: "ApiKey",
    apiKeyDiscoveryMethod: "config_xml",
    setupDependsOn: [],
  },
  jellyfin: {
    id: "jellyfin",
    name: "Jellyfin",
    category: "media",
    apiBaseSettingKey: "jellyfin_url",
    apiKeySettingKey: "jellyfin_api_key",
    healthEndpoint: "/health",
    configEndpoints: {
      libraries: "/Library/VirtualFolders",
    },
    commonPorts: [8096],
    dockerServiceName: "jellyfin",
    setupGuideUrl: "https://jellyfin.org/docs",
    talomeToolPrefix: "jellyfin_",
    relatesTo: ["overseerr"],
    apiKeyDiscoveryMethod: "create",
    setupDependsOn: [],
  },
  qbittorrent: {
    id: "qbittorrent",
    name: "qBittorrent",
    category: "media",
    apiBaseSettingKey: "qbittorrent_url",
    apiKeySettingKey: "qbittorrent_password",
    healthEndpoint: "/api/v2/app/version",
    configEndpoints: {},
    commonPorts: [8080],
    dockerServiceName: "qbittorrent",
    setupGuideUrl: "https://github.com/qbittorrent/qBittorrent/wiki",
    talomeToolPrefix: "qbt_",
    relatesTo: ["sonarr", "radarr"],
    apiKeyDiscoveryMethod: "default_creds",
    setupDependsOn: [],
  },
  overseerr: {
    id: "overseerr",
    name: "Overseerr",
    category: "media",
    apiBaseSettingKey: "overseerr_url",
    apiKeySettingKey: "overseerr_api_key",
    healthEndpoint: "/api/v1/status",
    configEndpoints: {},
    commonPorts: [5055],
    dockerServiceName: "overseerr",
    setupGuideUrl: "https://docs.overseerr.dev",
    talomeToolPrefix: "overseerr_",
    relatesTo: ["jellyfin", "sonarr", "radarr"],
    apiKeyDiscoveryMethod: "user",
    setupDependsOn: ["jellyfin", "sonarr", "radarr"],
  },
  homeassistant: {
    id: "homeassistant",
    name: "Home Assistant",
    category: "smart-home",
    apiBaseSettingKey: "homeassistant_url",
    apiKeySettingKey: "homeassistant_token",
    healthEndpoint: "/api/",
    configEndpoints: {},
    commonPorts: [8123],
    dockerServiceName: "homeassistant",
    setupGuideUrl: "https://www.home-assistant.io/docs",
    talomeToolPrefix: "hass_",
    relatesTo: [],
    apiKeyDiscoveryMethod: "user",
    setupDependsOn: [],
  },
  pihole: {
    id: "pihole",
    name: "Pi-hole",
    category: "privacy",
    apiBaseSettingKey: "pihole_url",
    apiKeySettingKey: "pihole_api_key",
    healthEndpoint: "/admin/api.php?status",
    configEndpoints: {},
    commonPorts: [80, 53],
    dockerServiceName: "pihole",
    setupGuideUrl: "https://docs.pi-hole.net",
    talomeToolPrefix: "pihole_",
    relatesTo: [],
    apiKeyDiscoveryMethod: "user",
    setupDependsOn: [],
  },
  vaultwarden: {
    id: "vaultwarden",
    name: "Vaultwarden",
    category: "privacy",
    apiBaseSettingKey: "vaultwarden_url",
    apiKeySettingKey: "vaultwarden_admin_token",
    healthEndpoint: "/api/alive",
    configEndpoints: {},
    commonPorts: [80, 3012],
    dockerServiceName: "vaultwarden",
    setupGuideUrl: "https://github.com/dani-garcia/vaultwarden/wiki",
    talomeToolPrefix: "vaultwarden_",
    relatesTo: [],
    apiKeyDiscoveryMethod: "user",
    setupDependsOn: [],
  },
  audiobookshelf: {
    id: "audiobookshelf",
    name: "Audiobookshelf",
    category: "media",
    apiBaseSettingKey: "audiobookshelf_url",
    apiKeySettingKey: "audiobookshelf_api_key",
    healthEndpoint: "/healthcheck",
    configEndpoints: {
      libraries: "/api/libraries",
    },
    commonPorts: [13378],
    dockerServiceName: "audiobookshelf",
    setupGuideUrl: "https://www.audiobookshelf.org/docs",
    talomeToolPrefix: "audiobookshelf_",
    relatesTo: ["readarr"],
    apiKeyDiscoveryMethod: "user",
    setupDependsOn: [],
  },
  readarr: {
    id: "readarr",
    name: "Readarr",
    category: "media",
    apiBaseSettingKey: "readarr_url",
    apiKeySettingKey: "readarr_api_key",
    healthEndpoint: "/api/v1/health",
    configEndpoints: {
      rootFolders: "/api/v1/rootfolder",
      downloadClients: "/api/v1/downloadclient",
      indexers: "/api/v1/indexer",
    },
    commonPorts: [8787],
    dockerServiceName: "readarr",
    setupGuideUrl: "https://wiki.servarr.com/readarr",
    talomeToolPrefix: "arr_",
    relatesTo: ["qbittorrent", "prowlarr", "audiobookshelf"],
    configFilePath: "config/config.xml",
    apiKeyXPath: "ApiKey",
    apiKeyDiscoveryMethod: "config_xml",
    setupDependsOn: ["prowlarr"],
  },
};

export function getAppCapabilities(appId: string): AppCapabilities | undefined {
  return APP_REGISTRY[appId.toLowerCase()];
}

/**
 * Apps Talome can talk to through saved settings, deliberately kept OUT of
 * APP_REGISTRY. Registry membership opts an app into health scoring,
 * scheduled setup runs, auto-configure, wiring detectors and app_api_call's
 * registry auth — all of which assume Talome can discover the API key. These
 * apps need a user-created key, so they would score as "missing settings"
 * forever and re-trigger the setup loop. Outcome verification reads their
 * connection details via getConnectableApp().
 */
export const SETTINGS_ONLY_APPS: Record<string, AppCapabilities> = {
  jellyseerr: {
    id: "jellyseerr",
    name: "Jellyseerr",
    category: "media",
    apiBaseSettingKey: "jellyseerr_url",
    apiKeySettingKey: "jellyseerr_api_key",
    healthEndpoint: "/api/v1/status",
    configEndpoints: {},
    commonPorts: [5055],
    dockerServiceName: "jellyseerr",
    setupGuideUrl: "https://docs.jellyseerr.dev",
    talomeToolPrefix: "overseerr_",
    relatesTo: ["jellyfin", "sonarr", "radarr"],
    apiKeyDiscoveryMethod: "user",
    setupDependsOn: ["jellyfin", "sonarr", "radarr"],
  },
  immich: {
    id: "immich",
    name: "Immich",
    category: "media",
    apiBaseSettingKey: "immich_url",
    apiKeySettingKey: "immich_api_key",
    healthEndpoint: "/api/server/ping",
    configEndpoints: {},
    commonPorts: [2283],
    dockerServiceName: "immich",
    setupGuideUrl: "https://immich.app/docs",
    talomeToolPrefix: "immich_",
    relatesTo: [],
    apiKeyDiscoveryMethod: "user",
    setupDependsOn: [],
  },
};

/** Registry entry, or a settings-only app, for code that only needs connection details. */
export function getConnectableApp(appId: string): AppCapabilities | undefined {
  const id = appId.toLowerCase();
  if (Object.hasOwn(APP_REGISTRY, id)) return APP_REGISTRY[id];
  if (Object.hasOwn(SETTINGS_ONLY_APPS, id)) return SETTINGS_ONLY_APPS[id];
  return undefined;
}

export type AppAuthScheme = "x-api-key" | "mediabrowser" | "bearer" | "qbt-cookie" | "query" | "none";

/**
 * How each known app expects its stored credential. Mirrors AUTH_PATTERNS in
 * ai/tools/universal-tools.ts (which should adopt this map); apps not listed
 * there use the convention fallback (X-Api-Key), which matches what is listed here.
 */
export const APP_AUTH_SCHEMES: Record<string, AppAuthScheme> = {
  sonarr: "x-api-key",
  radarr: "x-api-key",
  readarr: "x-api-key",
  prowlarr: "x-api-key",
  overseerr: "x-api-key",
  jellyseerr: "x-api-key",
  immich: "x-api-key",
  jellyfin: "mediabrowser",
  audiobookshelf: "bearer",
  homeassistant: "bearer",
  vaultwarden: "bearer",
  pihole: "query",
  qbittorrent: "qbt-cookie",
};

/**
 * Apps that share another app's API and may be configured through its
 * settings — Jellyseerr is an Overseerr fork, and the overseerr_* tools
 * (and settings) are used for both.
 */
export const APP_SETTINGS_FALLBACK: Record<string, string> = {
  jellyseerr: "overseerr",
};
