import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";

export type DepStatus = "not-installed" | "installed-not-configured" | "configured" | "error";

export interface DepStatusResult {
  appId: string;
  role: string;
  label: string;
  required: boolean;
  status: DepStatus;
  alternatives?: string[];
}

export interface StackStatusResult {
  id: string;
  name: string;
  description: string;
  readiness: number;
  dashboardPage: string;
  deps: DepStatusResult[];
}

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

export function useFeatureStacks() {
  const { data, error, isLoading, mutate } = useSWR<{ stacks: StackStatusResult[] }>(
    `${CORE_URL}/api/stacks/feature-status`,
    fetcher,
    { refreshInterval: 30_000 }
  );

  return {
    stacks: data?.stacks ?? [],
    isLoading,
    error,
    refresh: mutate,
  };
}

export function useFeatureStack(stackId: string) {
  const { stacks, isLoading, error, refresh } = useFeatureStacks();
  const stack = stacks.find(s => s.id === stackId);
  return { stack, isLoading, error, refresh };
}
