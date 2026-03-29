"use client";

import useSWR from "swr";
import type { CatalogApp } from "@talome/types";
import { CORE_URL } from "@/lib/constants";

async function fetcher(url: string): Promise<CatalogApp[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch installed apps");
  return res.json();
}

export function useInstalledApps(enabled = true) {
  const { data, error, isLoading } = useSWR<CatalogApp[]>(
    enabled ? `${CORE_URL}/api/apps/installed` : null,
    fetcher
  );

  return {
    apps: data ?? [],
    error: error?.message ?? null,
    isLoading,
  };
}
