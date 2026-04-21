export interface SystemStats {
  cpu: { usage: number; cores: number; model: string };
  memory: { usedBytes: number; totalBytes: number; percent: number };
  disk: { usedBytes: number; totalBytes: number; percent: number; mounts: DiskMount[] };
  network: { rxBytesPerSec: number; txBytesPerSec: number };
  uptime: number;
  platform: "darwin" | "linux";
  arch: "arm64" | "x64";
  hostname: string;
}

export interface DiskMount {
  fs: string;
  mount: string;
  usedBytes: number;
  totalBytes: number;
  percent: number;
  type: "internal" | "external" | "network";
}
