"use client";

import useSWR, { type SWRConfiguration } from "swr";
import type { Container } from "@talome/types";
import { CORE_URL, CONTAINERS_REFRESH_INTERVAL } from "@/lib/constants";

async function fetcher(url: string): Promise<Container[]> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch containers");
  return res.json();
}

export const CONTAINERS_KEY = `${CORE_URL}/api/containers`;

export function useContainers() {
  const { data, error, mutate, isLoading } = useSWR<Container[]>(
    CONTAINERS_KEY,
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

/** Minimum time between two lookup fetches, shared by every lookup consumer. */
export const CONTAINER_LOOKUP_DEDUPE_MS = 60_000;

/**
 * SWR options for the non-polling container lookup. Every consumer shares the
 * `/api/containers` cache key, never starts a timer and refetches at most
 * once per CONTAINER_LOOKUP_DEDUPE_MS — enough for linkifying container
 * names in chat, which only needs names/ports/status.
 */
export const CONTAINER_LOOKUP_SWR_OPTIONS: SWRConfiguration<Container[]> = {
  refreshInterval: 0,
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  dedupingInterval: CONTAINER_LOOKUP_DEDUPE_MS,
  shouldRetryOnError: false,
};

/**
 * Low-frequency, non-polling container list for lookups (chat links, inline
 * code tags, header prompts). Pass `enabled: false` to skip fetching entirely.
 */
export function useContainerLookup(enabled = true) {
  const { data } = useSWR<Container[]>(
    enabled ? CONTAINERS_KEY : null,
    fetcher,
    CONTAINER_LOOKUP_SWR_OPTIONS,
  );
  return { containers: data ?? [] };
}
