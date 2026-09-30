"use client";

import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";
import { pickPollInterval, POLL_IDLE_MS } from "@/lib/polling";
import type { DownloadsData } from "@talome/types";
import { getDownloadActivity } from "@/lib/download-status";

export async function fetchDownloads(url: string): Promise<DownloadsData> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error("Download stats unavailable.");
  const data = await response.json();
  if (!Array.isArray(data?.queue) || !Array.isArray(data?.torrents)) throw new Error("Invalid download response.");
  return data;
}

/**
 * True when anything in the payload is actively transferring. Uses the same
 * activity classification as the widget, nav badge, and Control Center.
 */
export function isDownloadsDataActive(data: DownloadsData | undefined): boolean {
  if (!data) return false;
  const torrents = (data.torrents ?? []).filter(Boolean);
  const queue = (data.queue ?? []).filter(Boolean);
  return getDownloadActivity(queue, torrents).activeCount > 0;
}

/**
 * SWR refresh function for always-mounted badges (sidebar / mobile nav):
 * `activeMs` while something is downloading, POLL_IDLE_MS otherwise.
 */
export function adaptiveDownloadsInterval(activeMs: number) {
  return (data: DownloadsData | undefined) => pickPollInterval(isDownloadsDataActive(data), { fast: activeMs, slow: POLL_IDLE_MS });
}

export function useDownloads(refreshInterval: number | ((data: DownloadsData | undefined) => number) = 5000) {
  const { data, isLoading, error, mutate, isValidating } = useSWR<DownloadsData>(
    `${CORE_URL}/api/media/downloads`,
    fetchDownloads,
    { refreshInterval }
  );

  const torrents = (data?.torrents ?? []).filter(Boolean);
  const queue = (data?.queue ?? []).filter(Boolean);

  const activity = getDownloadActivity(queue, torrents);
  const isActivelyDownloading = activity.activeCount > 0;
  const totalCount = activity.pendingCount;

  return { data, torrents, queue, isLoading, error, isActivelyDownloading, totalCount, activity, retry: mutate, isValidating };
}
