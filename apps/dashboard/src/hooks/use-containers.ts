"use client";

import useSWR from "swr";
import type { Container } from "@talome/types";
import { CORE_URL, CONTAINERS_REFRESH_INTERVAL } from "@/lib/constants";

async function fetcher(url: string): Promise<Container[]> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch containers");
  return res.json();
}

export function useContainers() {
  const { data, error, mutate, isLoading } = useSWR<Container[]>(
    `${CORE_URL}/api/containers`,
    fetcher,
    { refreshInterval: CONTAINERS_REFRESH_INTERVAL }
  );

  return {
    containers: data ?? [],
    error: error?.message ?? null,
    isLoading,
    refresh: mutate,
  };
}
