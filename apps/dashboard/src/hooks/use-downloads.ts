"use client";

import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";
import { pickPollInterval, POLL_IDLE_MS } from "@/lib/polling";
import type { DownloadsData } from "@talome/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

/** True when anything in the payload is actively downloading. */
export function isDownloadsDataActive(data: DownloadsData | undefined): boolean {
  if (!data) return false;
  return (
    (data.torrents ?? []).some((t) => t?.state === "downloading") ||
    (data.queue ?? []).some((q) => q?.status === "downloading")
  );
}

/**
 * SWR refresh function for always-mounted badges (sidebar / mobile nav):
 * `activeMs` while something is downloading, POLL_IDLE_MS otherwise.
 */
export function adaptiveDownloadsInterval(activeMs: number) {
  return (data: DownloadsData | undefined) => pickPollInterval(isDownloadsDataActive(data), { fast: activeMs, slow: POLL_IDLE_MS });
}

export function useDownloads(refreshInterval: number | ((data: DownloadsData | undefined) => number) = 5000) {
  const { data, isLoading, error } = useSWR<DownloadsData>(
    `${CORE_URL}/api/media/downloads`,
    fetcher,
    { refreshInterval }
  );

  const torrents = (data?.torrents ?? []).filter(Boolean);
  const queue = (data?.queue ?? []).filter(Boolean);

  const isActivelyDownloading =
    torrents.some((t) => t?.state === "downloading") ||
    queue.some((q) => q?.status === "downloading");

  const totalCount = torrents.length + queue.length;

  return { data, torrents, queue, isLoading, error, isActivelyDownloading, totalCount };
}
