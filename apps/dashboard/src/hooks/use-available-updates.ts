"use client";

import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";

export interface AppUpdateInfo {
  appId: string;
  storeId: string;
  name: string;
  installedVersion: string;
  availableVersion: string;
  hasUpdate: boolean;
}

async function fetcher(url: string): Promise<AppUpdateInfo[]> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch updates");
  return res.json();
}

/** Fetches available updates for all installed apps. Refreshes every 5 minutes. */
export function useAvailableUpdates() {
  const { data, error, mutate, isLoading } = useSWR<AppUpdateInfo[]>(
    `${CORE_URL}/api/updates`,
    fetcher,
    { refreshInterval: 5 * 60 * 1000 },
  );

  const updates = data?.filter((u) => u.hasUpdate) ?? [];
  const updateMap = new Map(updates.map((u) => [u.appId, u]));

  return {
    updates,
    updateMap,
    error: error?.message ?? null,
    isLoading,
    refresh: mutate,
  };
}
