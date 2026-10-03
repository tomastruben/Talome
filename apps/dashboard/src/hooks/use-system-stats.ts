"use client";

import { useSyncExternalStore } from "react";
import type { SystemStats } from "@talome/types";
import { getDirectCoreUrl } from "@/lib/constants";

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

export function createSystemStatsStore(): SystemStatsStore {
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

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollController: AbortController | null = null;
  let polling = false;

  function receiveStats(stats: SystemStats) {
    // Validate the fields consumed by history before replacing the last good data.
    const history = pushHistory(stats, snapshot.history);
    setSnapshot({ stats, history, error: null, isConnecting: false });
  }

  function stopPolling() {
    polling = false;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    pollController?.abort();
    pollController = null;
  }

  async function poll() {
    if (!polling || !listeners.size || pollController) return;
    const controller = new AbortController();
    pollController = controller;
    const timeout = setTimeout(() => controller.abort(), FIRST_EVENT_TIMEOUT_MS);
    try {
      // Regular requests can still succeed when a proxy buffers the live stream.
      const response = await fetch("/api/system", {
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) throw new Error("Stats request failed");
      const stats: SystemStats = await response.json();
      if (pollController === controller && polling && listeners.size) receiveStats(stats);
    } catch {
      if (pollController === controller && polling && listeners.size) {
        setSnapshot({ ...snapshot, isConnecting: false,
          error: "Could not reach the Talome server. Retrying automatically." });
      }
    } finally {
      clearTimeout(timeout);
      if (pollController === controller) {
        pollController = null;
        if (polling && listeners.size) pollTimer = setTimeout(poll, 5000);
      }
    }
  }

  function recover() {
    closeStream();
    if (!listeners.size) return;
    if (!polling) {
      polling = true;
      void poll();
    }
    if (!reconnectTimer) reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 3000);
  }

  function watchStream(timeout: number) {
    clearFirstEventTimeout();
    firstEventTimeout = setTimeout(recover, timeout);
  }

  function connect() {
    if (eventSource || typeof window === "undefined" || !listeners.size) return;
    if (typeof EventSource === "undefined") {
      if (!polling) { polling = true; void poll(); }
      return;
    }
    const source = new EventSource(`${getDirectCoreUrl()}/api/stats/stream`, {
      withCredentials: true,
    });
    eventSource = source;
    watchStream(FIRST_EVENT_TIMEOUT_MS);
    source.addEventListener("stats", (event) => {
      if (eventSource !== source) return;
      try {
        receiveStats(JSON.parse(event.data));
        stopPolling();
        // Detect an open connection that silently stops delivering events.
        watchStream(15_000);
      } catch {
        // Keep the last good snapshot; the watchdog handles malformed streams.
      }
    });
    source.addEventListener("error", () => {
      if (eventSource === source) recover();
    });
  }

  function closeStream() {
    clearFirstEventTimeout();
    eventSource?.close();
    eventSource = null;
  }

  function disconnect() {
    closeStream();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stopPolling();
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
