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
  },
};

export function getAppCapabilities(appId: string): AppCapabilities | undefined {
  return APP_REGISTRY[appId.toLowerCase()];
}
