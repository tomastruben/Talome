"use client";

import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";
import type { DownloadsData } from "@talome/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useDownloads(refreshInterval = 5000) {
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
