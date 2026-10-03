"use client";

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import { useSearchParams } from "next/navigation";
import { CORE_URL } from "@/lib/constants";
import type { StackStatusResult } from "@/hooks/use-feature-stacks";

/** Throws on failure: a failed load must never read as "nothing configured". */
async function fetcher(url: string) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

interface AiModelsSummary {
  activeProvider: string;
  providers: { provider: string; configured: boolean }[];
}

async function appsFetcher(url: string): Promise<unknown[]> {
  const res = await fetch(url);
  if (!res.ok) return [];
  return res.json();
}

async function stacksFetcher(url: string): Promise<{ stacks: StackStatusResult[] }> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) return { stacks: [] };
  return res.json();
}

/** Setup phase derived from configuration state */
export type SetupPhase =
  | "fresh"        // no account
  | "ai-pending"   // account exists, no AI provider
  | "exploring"    // AI configured, no apps
  | "building"     // apps installed, no stack fully configured
  | "operational"  // at least one feature stack fully configured
  | "growing";     // multiple stacks complete or 5+ apps

export interface SetupStatus {
  isLoaded: boolean;
  isConfigured: boolean;
  hasApps: boolean;
  appCount: number;
  /** Which integrations have URLs configured */
  integrations: string[];
  /** Derived lifecycle phase */
  phase: SetupPhase;
  /** Active preview mode, or null if viewing real state */
  previewState: SetupPhase | null;
  /** Feature stack readiness data */
  stacks: StackStatusResult[];
  /** Number of stacks that are fully configured */
  completeStackCount: number;
  /** The nearest-to-complete stack (highest readiness < 1.0) */
  nearestStack: StackStatusResult | null;
}

const INTEGRATION_KEYS: Record<string, string> = {
  sonarr_url: "sonarr",
  radarr_url: "radarr",
  readarr_url: "readarr",
  prowlarr_url: "prowlarr",
  qbittorrent_url: "qbittorrent",
  jellyfin_url: "jellyfin",
  plex_url: "plex",
  overseerr_url: "overseerr",
  audiobookshelf_url: "audiobookshelf",
  homeassistant_url: "homeassistant",
  pihole_url: "pihole",
  vaultwarden_url: "vaultwarden",
  ollama_url: "ollama",
};

const ALL_PHASES: SetupPhase[] = ["fresh", "ai-pending", "exploring", "building", "operational", "growing"];

function derivePhase(
  isConfigured: boolean,
  hasApps: boolean,
  completeStacks: number,
  appCount: number,
): SetupPhase {
  if (!isConfigured) return "ai-pending";
  if (!hasApps) return "exploring";
  if (completeStacks === 0) return "building";
  if (completeStacks >= 2 || appCount >= 5) return "growing";
  return "operational";
}

export function useSetupStatus(): SetupStatus {
  const searchParams = useSearchParams();
  const preview = searchParams.get("preview") as SetupPhase | null;

  const { data } = useSWR<Record<string, string>>(
    `${CORE_URL}/api/settings`,
    fetcher,
    { revalidateOnFocus: true, dedupingInterval: 30000 }
  );

  // "AI configured" means the active provider is usable (a key for hosted
  // providers, a reachable server with a model for Ollama), not that some
  // key exists somewhere.
  const { data: aiModels } = useSWR<AiModelsSummary>(
    `${CORE_URL}/api/ai/models`,
    fetcher,
    { revalidateOnFocus: true, dedupingInterval: 30000 }
  );

  const { data: apps } = useSWR<unknown[]>(
    `${CORE_URL}/api/apps/installed`,
    appsFetcher,
    { revalidateOnFocus: true, dedupingInterval: 30000 }
  );

  const { data: stacksData } = useSWR<{ stacks: StackStatusResult[] }>(
    `${CORE_URL}/api/stacks/feature-status`,
    stacksFetcher,
    { revalidateOnFocus: true, dedupingInterval: 30000 }
  );

  const stacks = stacksData?.stacks ?? [];
  const completeStacks = stacks.filter(s => s.readiness >= 1.0);
  const incompleteStacks = stacks
    .filter(s => s.readiness > 0 && s.readiness < 1.0)
    .sort((a, b) => b.readiness - a.readiness);

  const hasAiKey = !!(data?.anthropic_key || data?.openai_key || data?.kimi_key || data?.ollama_url);
  const activeProviderReady = aiModels
    ? aiModels.providers.find((p) => p.provider === aiModels.activeProvider)?.configured === true
    : undefined;
  const appCount = apps?.length ?? 0;
  const realConfigured = activeProviderReady ?? hasAiKey;
  const realHasApps = appCount > 0;

  // Detect configured integrations
  const integrations: string[] = [];
  if (data) {
    for (const [key, label] of Object.entries(INTEGRATION_KEYS)) {
      if (data[key]) integrations.push(label);
    }
  }

  // Preview mode overrides
  const isPreview = ALL_PHASES.includes(preview as SetupPhase);
  const isConfigured = isPreview
    ? preview !== "fresh" && preview !== "ai-pending"
    : realConfigured;
  const hasApps = isPreview
    ? preview === "building" || preview === "operational" || preview === "growing"
    : realHasApps;

  return {
    isLoaded: data !== undefined,
    isConfigured,
    hasApps,
    appCount: isPreview ? (hasApps ? 3 : 0) : appCount,
    integrations: isPreview ? [] : integrations,
    phase: isPreview
      ? preview!
      : derivePhase(realConfigured, realHasApps, completeStacks.length, appCount),
    previewState: isPreview ? preview : null,
    stacks,
    completeStackCount: completeStacks.length,
    nearestStack: incompleteStacks[0] ?? null,
  };
}

// ── Sign-in probe ────────────────────────────────────────────────────────────

export type AuthStatus =
  | { state: "loading" }
  | { state: "ready"; accountExists: boolean; wallpaperUrl?: string }
  | { state: "error"; message: string };

/**
 * Asks core whether an account exists. A failed probe is an error the
 * screen shows with Retry: it is never read as "no account", so the sign-in
 * form can't turn into account creation because the server was briefly down.
 */
export async function fetchAuthStatus(): Promise<AuthStatus> {
  try {
    const res = await fetch("/api/auth/status", { credentials: "include", cache: "no-store" });
    const body = (await res.json().catch(() => null)) as { passwordConfigured?: unknown; wallpaperUrl?: unknown } | null;
    if (!res.ok || typeof body?.passwordConfigured !== "boolean") {
      return { state: "error", message: "Couldn't reach the Talome server. Check that it's running, then retry." };
    }
    return { state: "ready", accountExists: body.passwordConfigured,
      ...(typeof body.wallpaperUrl === "string" && /^\/wallpapers\/(?:[a-z][a-z0-9-]*|generated\/talome-\d{2})\.jpg$/.test(body.wallpaperUrl) ? { wallpaperUrl: body.wallpaperUrl } : {}) };
  } catch {
    return { state: "error", message: "Couldn't reach the Talome server. Check that it's running, then retry." };
  }
}

export function useAuthStatus(): { status: AuthStatus; retry: () => void } {
  const [status, setStatus] = useState<AuthStatus>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetchAuthStatus().then((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  const retry = useCallback(() => {
    setStatus({ state: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { status, retry };
}
