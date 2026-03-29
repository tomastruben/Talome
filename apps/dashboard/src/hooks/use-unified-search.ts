"use client";

import useSWR from "swr";
import { useState, useEffect, useRef, useCallback } from "react";
import type { UnifiedSearchResponse } from "@talome/types";
import { CORE_URL } from "@/lib/constants";

/**
 * Fetcher with AbortController support so SWR can cancel stale requests.
 * When a new query fires, the previous in-flight request is aborted.
 */
function createAbortableFetcher() {
  let controller: AbortController | null = null;

  return async function fetcher(url: string): Promise<UnifiedSearchResponse> {
    // Abort any previous in-flight request
    if (controller) controller.abort();
    controller = new AbortController();
    const { signal } = controller;

    const res = await fetch(url, { credentials: "include", signal });
    if (!res.ok) throw new Error("Search failed");
    return res.json();
  };
}

const abortableFetcher = createAbortableFetcher();

export function useUnifiedSearch(query: string, debounceMs = 200) {
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!query.trim()) {
      setDebouncedQuery("");
      return;
    }
    timerRef.current = setTimeout(() => setDebouncedQuery(query), debounceMs);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query, debounceMs]);

  const key = debouncedQuery.length >= 2
    ? `${CORE_URL}/api/search?q=${encodeURIComponent(debouncedQuery)}`
    : null;

  const { data, error, isLoading } = useSWR<UnifiedSearchResponse>(key, abortableFetcher, {
    keepPreviousData: true,
    revalidateOnFocus: false,
    dedupingInterval: 500,
  });

  return {
    results: data?.results ?? [],
    timing: data?.timing ?? {},
    isSearching: isLoading && !!key,
    error: error?.message ?? null,
  };
}
