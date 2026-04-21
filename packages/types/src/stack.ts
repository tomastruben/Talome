export interface StackEnvVar {
  key: string;
  description: string;
  required: boolean;
  /** If true, the value will be replaced with a placeholder on export */
  secret?: boolean;
  defaultValue?: string;
}

export interface StackApp {
  appId: string;
  name: string;
  /** docker-compose YAML as a string. Secrets replaced with <PLACEHOLDER: KEY> on export. */
  compose: string;
  configSchema: {
    envVars: StackEnvVar[];
  };
}

export interface TalomeStack {
  id: string;
  name: string;
  description: string;
  /** Short tagline for display */
  tagline: string;
  author: string;
  tags: string[];
  apps: StackApp[];
  version: string;
  createdAt: string;
  /** System prompt injected into the agent after stack install completes */
  postInstallPrompt?: string;
}

/** App data enriched with catalog info for display in the App Store */
export interface EnrichedStackApp {
  appId: string;
  name: string;
  icon?: string;
  iconUrl?: string;
  category?: string;
  tagline?: string;
  storeId?: string;
  /** Whether the app is detected as running (via installed_apps DB or Docker container) */
  installed?: boolean;
}

/** Stack summary returned by the listing endpoint */
export interface StackListItem {
  id: string;
  name: string;
  tagline: string;
  description: string;
  author: string;
  tags: string[];
  appCount: number;
  apps: EnrichedStackApp[];
}

export interface StackExport {
  /** TalomeStack with all secret env var values replaced by <PLACEHOLDER: KEY> */
  stack: TalomeStack;
  exportedAt: string;
  talomeVersion: string;
}
