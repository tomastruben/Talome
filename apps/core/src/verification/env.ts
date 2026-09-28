/**
 * Probe environment — everything a check needs from the outside world,
 * injectable so probes are testable without network, Docker or a database.
 */

import { networkInterfaces } from "node:os";
import { APP_REGISTRY } from "../app-registry/index.js";
import { isSecretSettingKey } from "../utils/crypto.js";
import { getSetting as readSetting } from "../utils/settings.js";

export interface MountInfo {
  /** Host path (bind mount source or named-volume mountpoint). */
  source: string;
  /** Path inside the container. */
  destination: string;
}

export interface HttpResult<T = unknown> {
  ok: boolean;
  /** HTTP status, or 0 when the request never got an answer. */
  status: number;
  data?: T;
  error?: string;
  /** Raw Set-Cookie header (only needed for qBittorrent's session login). */
  setCookie?: string;
}

export interface QbtSession {
  ok: boolean;
  status: number;
  /** null = authenticated without a cookie (localhost auth bypass). */
  sid: string | null;
  error?: string;
}

export interface ProbeEnvDeps {
  /** Reads a Talome setting, decrypting secret values (utils/settings.ts). */
  getSetting: (key: string) => string | undefined;
  fetch: typeof fetch;
  /** Returns a container's mounts, or null when Docker can't tell us. Read-only. */
  inspectMounts: (container: string) => Promise<MountInfo[] | null>;
  /** Best-guess LAN address of this server, used in mobile-app guidance. */
  lanAddress: () => string | undefined;
  now: () => number;
}

export interface ProbeEnv extends ProbeEnvDeps {
  /** Every secret value read during the run — scrubbed from all evidence. */
  secrets: Set<string>;
  /** Per-run GET cache so app and stack checks share upstream responses. */
  cache: Map<string, Promise<HttpResult>>;
  qbtSessions: Map<string, Promise<QbtSession>>;
}

async function defaultInspectMounts(container: string): Promise<MountInfo[] | null> {
  try {
    const { inspectContainer } = await import("../docker/client.js");
    const info = await inspectContainer(container);
    return info.mounts
      .filter((m) => m.source && m.destination)
      .map((m) => ({ source: m.source, destination: m.destination }));
  } catch {
    return null;
  }
}

function defaultLanAddress(): string | undefined {
  try {
    for (const addrs of Object.values(networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (addr.family === "IPv4" && !addr.internal && !addr.address.startsWith("169.254.")) {
          return addr.address;
        }
      }
    }
  } catch {
    // Not critical — guidance falls back to a placeholder.
  }
  return undefined;
}

/** Setting keys whose values must be scrubbed even if a probe never reads them directly. */
function registrySecretKeys(): string[] {
  const keys = new Set<string>(["qbittorrent_password"]);
  for (const caps of Object.values(APP_REGISTRY)) keys.add(caps.apiKeySettingKey);
  return [...keys];
}

export function createProbeEnv(deps: Partial<ProbeEnvDeps> = {}): ProbeEnv {
  const baseGetSetting = deps.getSetting ?? readSetting;
  const secrets = new Set<string>();

  const getSetting = (key: string): string | undefined => {
    const value = baseGetSetting(key);
    if (value && isSecretSettingKey(key)) secrets.add(value);
    return value;
  };

  // Seed with every known app credential so upstream error bodies that echo
  // another app's key (e.g. Overseerr returning Sonarr settings) are scrubbed too.
  for (const key of registrySecretKeys()) getSetting(key);

  return {
    getSetting,
    fetch: deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
    inspectMounts: deps.inspectMounts ?? defaultInspectMounts,
    lanAddress: deps.lanAddress ?? defaultLanAddress,
    now: deps.now ?? (() => Date.now()),
    secrets,
    cache: new Map(),
    qbtSessions: new Map(),
  };
}
