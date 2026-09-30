"use client";

import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";
import type { DownloadsData } from "@talome/types";
import { getDownloadActivity } from "@/lib/download-status";

export async function fetchDownloads(url: string): Promise<DownloadsData> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error("Download stats unavailable.");
  const data = await response.json();
  if (!Array.isArray(data?.queue) || !Array.isArray(data?.torrents)) throw new Error("Invalid download response.");
  return data;
}

export function useDownloads(refreshInterval = 5000) {
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
