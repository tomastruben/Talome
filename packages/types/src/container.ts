export interface Container {
  id: string;
  name: string;
  image: string;
  status: "running" | "stopped" | "restarting" | "paused" | "exited" | "created";
  ports: { host: number; container: number; protocol: "tcp" | "udp" }[];
  created: string;
  stats?: ContainerStats;
  labels: Record<string, string>;
}

export interface ContainerStats {
  cpuPercent: number;
  memoryUsageMb: number;
  memoryLimitMb: number;
  networkRxBytes: number;
  networkTxBytes: number;
}

export interface ServiceStack {
  /** Unique key: appId, compose project name, or container ID */
  id: string;
  /** Human-readable name from catalog, compose project, or container name */
  name: string;
  /** Origin: installed via Talome, external compose stack, or standalone container */
  kind: "talome" | "compose" | "standalone";
  /** Emoji icon from app catalog */
  icon?: string;
  /** Image URL from app catalog */
  iconUrl?: string;
  /** App category from catalog */
  category?: string;
  /** Aggregate status across all containers in the stack */
  status: "running" | "partial" | "stopped";
  /** Primary container (has web ports, or first running) */
  primaryContainer: Container;
  /** All containers in this stack */
  containers: Container[];
  /** Sum of CPU % across all containers */
  cpuPercent: number;
  /** Sum of memory usage across all containers */
  memoryUsageMb: number;
  /** How many containers are running */
  runningCount: number;
  /** Total containers in stack */
  totalCount: number;
  /** Store source ID (Talome-installed only) */
  storeId?: string;
  /** App ID (Talome-installed only) */
  appId?: string;
  /** Per-container icon metadata (container ID → icon info) */
  containerIcons?: Record<string, { icon?: string; iconUrl?: string; name?: string }>;
}
