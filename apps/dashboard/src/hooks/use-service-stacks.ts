"use client";

import useSWR from "swr";
import type { ServiceStack } from "@talome/types";
import { CORE_URL, CONTAINERS_REFRESH_INTERVAL } from "@/lib/constants";

async function fetcher(url: string): Promise<ServiceStack[]> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch service stacks");
  return res.json();
}

export function useServiceStacks() {
  const { data, error, mutate, isLoading } = useSWR<ServiceStack[]>(
    `${CORE_URL}/api/containers?grouped=true`,
    fetcher,
    { refreshInterval: CONTAINERS_REFRESH_INTERVAL },
  );

  return {
    stacks: data ?? [],
    error: error?.message ?? null,
    isLoading,
    refresh: mutate,
  };
}
