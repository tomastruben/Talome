"use client";

import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";

export interface WidgetManifest {
  id: string;
  version: number;
  title: string;
  description: string;
  dataSource: string;
  sizePresets: Array<{ cols: 1 | 2 | 3 | 4; rows: 1 | 2 | 3 }>;
  status: "draft" | "pending_review" | "approved" | "disabled";
  createdAt: string;
  updatedAt: string;
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load widget manifests");
  return res.json();
};

export function useWidgetManifests() {
  const { data, isLoading, error, mutate } = useSWR<{ widgets: WidgetManifest[] }>(
    `${CORE_URL}/api/widgets`,
    fetcher,
    { refreshInterval: 15000 },
  );

  return {
    widgets: data?.widgets ?? [],
    isLoading,
    error,
    refresh: mutate,
  };
}
