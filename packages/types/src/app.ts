export type StoreType = "casaos" | "umbrel" | "talome" | "user-created";

export type AppCategory =
  | "media"
  | "productivity"
  | "ai"
  | "networking"
  | "storage"
  | "security"
  | "developer"
  | "finance"
  | "social"
  | "automation"
  | "crypto"
  | "backup"
  | "files"
  | "other";

export interface AppPort {
  host: number;
  container: number;
}

export interface AppVolume {
  name: string;
  containerPath: string;
  description?: string;
  /** True for volumes that hold user media (movies, audiobooks, etc.) — prompted at install time. */
  mediaVolume?: boolean;
}

export interface AppEnvVar {
  key: string;
  label: string;
  required: boolean;
  default?: string;
  secret?: boolean;
}

export type HookType = "shell" | "ai_prompt" | "http";

export interface AppHook {
  type: HookType;
  /** Shell: command to exec in container. AI: prompt to send to agent. HTTP: URL to call. */
  value: string;
  /** For shell hooks, the service/container to exec in (defaults to main service) */
  service?: string;
  /** Timeout in ms (default 30000) */
  timeout?: number;
}

export interface AppHooks {
  postInstall?: AppHook;
  preStart?: AppHook;
  postStart?: AppHook;
  preUninstall?: AppHook;
}

export type AppNetworkMode = "bridge" | "host" | "none";

export interface AppPermissions {
  /** Requires GPU passthrough */
  gpu?: boolean;
  /** Docker network mode override */
  networkMode?: AppNetworkMode;
  /** Requires privileged container mode */
  privileged?: boolean;
  /** Host directories the app needs access to (beyond its own data dir) */
  storageAccess?: string[];
}

export interface AppManifest {
  id: string;
  name: string;
  version: string;

  tagline: string;
  description: string;
  releaseNotes?: string;

  icon: string;
  iconUrl?: string;
  coverUrl?: string;
  screenshots?: string[];
  installNotes?: string;

  category: string;
  author: string;
  website?: string;
  repo?: string;
  support?: string;

  source: StoreType;
  storeId: string;
  composePath: string;

  image?: string;
  ports: AppPort[];
  volumes: AppVolume[];
  env: AppEnvVar[];
  architectures?: string[];
  dependencies?: string[];
  hooks?: AppHooks;
  permissions?: AppPermissions;

  defaultUsername?: string;
  defaultPassword?: string;
  webPort?: number;
}

export type InstalledAppStatus = "installing" | "running" | "stopped" | "error" | "updating" | "unknown";

export interface InstalledApp {
  appId: string;
  storeId: string;
  status: InstalledAppStatus;
  installedAt: string;
  updatedAt: string;
  envConfig: Record<string, string>;
  containerIds: string[];
  version: string;
  /** User-defined display name override */
  displayName?: string;
}

export interface StoreSource {
  id: string;
  name: string;
  type: StoreType;
  gitUrl?: string;
  branch: string;
  localPath?: string;
  lastSyncedAt?: string;
  appCount: number;
  enabled: boolean;
}

export interface CatalogApp extends AppManifest {
  installed?: InstalledApp | null;
  /** App detected running as a Docker container but not installed via Talome */
  detectedRunning?: boolean;
}
