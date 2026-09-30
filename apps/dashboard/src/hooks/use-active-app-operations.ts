"use client";

import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";
import { isActiveOperationStatus, parseOperationHistory, type OperationRecord } from "@/lib/app-operations";

const ACTIVE_OPERATIONS_URL = `${CORE_URL}/api/operations?active=1&limit=50`;
const EMPTY: OperationRecord[] = [];

async function fetchActiveOperations(url: string): Promise<OperationRecord[]> {
  const res = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!res.ok) throw new Error(`Couldn't load app operations (${res.status})`);
  return parseOperationHistory(await res.json()).filter((op) => isActiveOperationStatus(op.status));
}

/**
 * App operations in flight (install, update, backup…), polled while
 * `enabled`. The desktop uses it so an app being recreated by an update reads
 * "Updating", not "Not installed".
 */
export function useActiveAppOperations(enabled: boolean, refreshInterval = 5_000): OperationRecord[] {
  const { data } = useSWR<OperationRecord[]>(enabled ? ACTIVE_OPERATIONS_URL : null, fetchActiveOperations, {
    refreshInterval,
    revalidateOnFocus: false,
  });
  return data ?? EMPTY;
}
