"use client";

import useSWR from "swr";
import type { ServiceStack } from "@talome/types";
import { CORE_URL, CONTAINERS_REFRESH_INTERVAL } from "@/lib/constants";

async function fetcher(url: string): Promise<ServiceStack[]> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch service stacks");
  return res.json();
}

export const SERVICE_STACKS_KEY = `${CORE_URL}/api/containers?grouped=true`;

export interface UseServiceStacksOptions {
  /** When false, nothing is fetched or polled (SWR key is null). Default true. */
  enabled?: boolean;
  /**
   * Polling interval in ms. Default CONTAINERS_REFRESH_INTERVAL.
   * Pass 0 for a passive subscriber that reads the shared cache (filled by
   * another polling instance) without starting its own timer.
   */
  refreshInterval?: number;
}

/** SWR key for the grouped containers endpoint, or null when disabled. */
export function getServiceStacksKey(enabled: boolean): string | null {
  return enabled ? SERVICE_STACKS_KEY : null;
}

export function useServiceStacks(options: UseServiceStacksOptions = {}) {
  const { enabled = true, refreshInterval = CONTAINERS_REFRESH_INTERVAL } = options;
  const passive = refreshInterval <= 0;
  const { data, error, mutate, isLoading } = useSWR<ServiceStack[]>(
    getServiceStacksKey(enabled),
    fetcher,
    passive
      ? { refreshInterval: 0, revalidateOnFocus: false, revalidateIfStale: false }
      : { refreshInterval },
  );

  return {
    stacks: data ?? [],
    error: error?.message ?? null,
    isLoading,
    refresh: mutate,
  };
}
