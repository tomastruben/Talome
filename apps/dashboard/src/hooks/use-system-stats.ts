"use client";

import { useSyncExternalStore } from "react";
import type { SystemStats } from "@talome/types";
import { getHostUrl } from "@/lib/constants";

export interface MetricSample {
  ts: number;
  value: number;
}

export interface StatHistory {
  cpu: MetricSample[];
  memory: MetricSample[];
  networkRx: MetricSample[];
  networkTx: MetricSample[];
  disk: MetricSample[];
}

interface SystemStatsSnapshot {
  stats: SystemStats | null;
  error: string | null;
  isConnecting: boolean;
  history: StatHistory;
}

interface SystemStatsStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => SystemStatsSnapshot;
}

const HISTORY_LENGTH = 30;
const HISTORY_RETENTION_MS = 75_000;

// How long to wait for the first stats event before surfacing a clear error
// instead of leaving the widget stuck in skeleton limbo forever.
const FIRST_EVENT_TIMEOUT_MS = 8_000;

const EMPTY_HISTORY: StatHistory = {
  cpu: [],
  memory: [],
  networkRx: [],
  networkTx: [],
  disk: [],
};

const INITIAL_SNAPSHOT: SystemStatsSnapshot = {
  stats: null,
  error: null,
  isConnecting: true,
  history: EMPTY_HISTORY,
};

function createSystemStatsStore(): SystemStatsStore {
  let snapshot: SystemStatsSnapshot = INITIAL_SNAPSHOT;
  let eventSource: EventSource | null = null;
  let firstEventTimeout: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  function emit() {
    listeners.forEach((listener) => listener());
  }

  function setSnapshot(next: SystemStatsSnapshot) {
    snapshot = next;
    emit();
  }

  function clearFirstEventTimeout() {
    if (firstEventTimeout) {
      clearTimeout(firstEventTimeout);
      firstEventTimeout = null;
    }
  }

  function pruneHistory(samples: MetricSample[], now: number): MetricSample[] {
    const cutoff = now - HISTORY_RETENTION_MS;
    const next = samples.filter((sample) => sample.ts >= cutoff);
    return next.slice(-HISTORY_LENGTH * 2);
  }

  function pushHistory(stats: SystemStats, history: StatHistory): StatHistory {
    const now = Date.now();
    return {
      cpu: pruneHistory([...history.cpu, { ts: now, value: stats.cpu.usage }], now),
      memory: pruneHistory([...history.memory, { ts: now, value: stats.memory.percent }], now),
      networkRx: pruneHistory([...history.networkRx, { ts: now, value: Math.round(stats.network.rxBytesPerSec / 1024) }], now),
      networkTx: pruneHistory([...history.networkTx, { ts: now, value: Math.round(stats.network.txBytesPerSec / 1024) }], now),
      disk: pruneHistory([...history.disk, { ts: now, value: stats.disk.percent }], now),
    };
  }

  function connect() {
    if (eventSource || typeof window === "undefined") return;

    setSnapshot({
      ...snapshot,
      error: null,
      isConnecting: snapshot.stats === null,
    });

    eventSource = new EventSource(`${getHostUrl(4000)}/api/stats/stream`, {
      withCredentials: true,
    });

    firstEventTimeout = setTimeout(() => {
      if (eventSource) {
        setSnapshot({
          ...snapshot,
          isConnecting: false,
          error: "Could not reach the Talome server. Check that it is running.",
        });
      }
    }, FIRST_EVENT_TIMEOUT_MS);

    eventSource.addEventListener("stats", (event) => {
      try {
        const parsed: SystemStats = JSON.parse(event.data);
        clearFirstEventTimeout();
        setSnapshot({
          stats: parsed,
          error: null,
          isConnecting: false,
          history: pushHistory(parsed, snapshot.history),
        });
      } catch {
        // Ignore malformed SSE payloads and keep the last good snapshot.
      }
    });

    eventSource.addEventListener("error", () => {
      clearFirstEventTimeout();
      setSnapshot({
        ...snapshot,
        isConnecting: false,
        error: "Stats stream lost — retrying in the background.",
      });
      // Close dead connection and schedule reconnect
      disconnect();
      if (listeners.size > 0) {
        reconnectTimer = setTimeout(connect, 3000);
      }
    });
  }

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function disconnect() {
    clearFirstEventTimeout();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (!eventSource) return;
    eventSource.close();
    eventSource = null;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      connect();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) disconnect();
      };
    },
    getSnapshot() {
      return snapshot;
    },
  };
}

declare global {
  var __talomeSystemStatsStore: SystemStatsStore | undefined;
}

function getSystemStatsStore(): SystemStatsStore {
  if (!globalThis.__talomeSystemStatsStore) {
    globalThis.__talomeSystemStatsStore = createSystemStatsStore();
  }
  return globalThis.__talomeSystemStatsStore;
}

export function useSystemStats() {
  const store = getSystemStatsStore();
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
