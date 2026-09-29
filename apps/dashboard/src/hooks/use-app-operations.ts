"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import useSWR from "swr";
import { CORE_URL, getDirectCoreUrl } from "@/lib/constants";
import { POLL_ACTIVE_MS, POLL_IDLE_MS, isDocumentVisible } from "@/lib/polling";
import {
  isActiveOperationStatus,
  liveOperationFrom,
  missedTerminalRecord,
  operationEventFromRecord,
  operationFromRecord,
  parseOperationEvent,
  parseOperationHistory,
  parseOperationRecord,
  reduceOperationEvent,
  type LiveOperation,
  type OperationEvent,
  type OperationRecord,
} from "@/lib/app-operations";

const HISTORY_LIMIT = 10;

type StreamAction =
  | { type: "event"; event: OperationEvent; appId: string }
  /**
   * A journal row learned out of band (409 conflict, or a terminal row for an
   * operation whose terminal event was missed); never overrides fresher
   * stream state unless it settles it.
   */
  | { type: "seed"; operation: LiveOperation };

function streamReducer(state: LiveOperation | null, action: StreamAction): LiveOperation | null {
  if (action.type === "event") return reduceOperationEvent(state, action.event, action.appId);
  const next = action.operation;
  if (state && state.operationId === next.operationId) {
    // A terminal journal row always settles a still-active streamed state.
    const settles = isActiveOperationStatus(state.status) && !isActiveOperationStatus(next.status);
    if (!settles && state.updatedAt >= next.updatedAt) return state;
  }
  return next;
}

async function historyFetcher(url: string): Promise<OperationRecord[]> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Failed to load operations (${res.status})`);
  return parseOperationHistory(await res.json());
}

export interface UseAppOperationsOptions {
  /** Default true. When false no stream is opened and nothing is fetched. */
  enabled?: boolean;
  /** Something on the page is in flight: poll the journal fast as an SSE fallback. */
  busy?: boolean;
  /** Called once per terminal stream event (succeeded / failed / rolled_back / interrupted). */
  onSettled?: (event: OperationEvent) => void;
}

/**
 * Live + recent operations for one app.
 *
 * Opens GET /api/operations/stream?appId= while the tab is visible (closed
 * when hidden and on unmount) and reconciles it with the persisted journal
 * (GET /api/apps/:appId/operations), which is also polled — fast while an
 * operation runs — so progress stays honest even if the stream is blocked.
 */
export function useAppOperations(appId: string | null | undefined, options: UseAppOperationsOptions = {}) {
  const { enabled = true, busy = false, onSettled } = options;
  const [streamed, dispatch] = useReducer(streamReducer, null);
  const onSettledRef = useRef(onSettled);
  const streamedRef = useRef(streamed);
  /** Operation ids already reported through onSettled (stream or journal). */
  const settledIdsRef = useRef(new Set<string>());

  useEffect(() => {
    streamedRef.current = streamed;
  }, [streamed]);

  useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);

  const key = enabled && appId ? `${CORE_URL}/api/apps/${encodeURIComponent(appId)}/operations?limit=${HISTORY_LIMIT}` : null;

  // Stable per (streamed, busy): polls fast while an operation is active.
  const refreshInterval = useCallback(
    (data: OperationRecord[] | undefined) => {
      if (!appId) return 0;
      const live = liveOperationFrom(streamed, data, appId);
      return busy || isActiveOperationStatus(live?.status) ? POLL_ACTIVE_MS : POLL_IDLE_MS;
    },
    [appId, streamed, busy],
  );

  // The journal finished an operation the stream still shows as active (its
  // terminal event was missed while hidden / reconnecting / unreachable):
  // settle the stream state and report it like a terminal event.
  const onHistory = useCallback((data: OperationRecord[]) => {
    const row = missedTerminalRecord(streamedRef.current, data);
    if (!row) return;
    dispatch({ type: "seed", operation: operationFromRecord(row) });
    if (settledIdsRef.current.has(row.id)) return;
    settledIdsRef.current.add(row.id);
    onSettledRef.current?.(operationEventFromRecord(row));
  }, []);

  const { data: history, error, isLoading, mutate } = useSWR<OperationRecord[]>(key, historyFetcher, {
    refreshInterval,
    revalidateOnFocus: true,
    onSuccess: onHistory,
  });

  const mutateRef = useRef(mutate);
  useEffect(() => {
    mutateRef.current = mutate;
  }, [mutate]);

  useEffect(() => {
    if (!enabled || !appId) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    let source: EventSource | null = null;

    const handleOperation = (message: MessageEvent<string>) => {
      let payload: unknown;
      try {
        payload = JSON.parse(message.data);
      } catch {
        return;
      }
      const event = parseOperationEvent(payload);
      if (!event || event.appId !== appId) return;
      dispatch({ type: "event", event, appId });
      if (!isActiveOperationStatus(event.status)) {
        void mutateRef.current();
        if (!settledIdsRef.current.has(event.operationId)) {
          settledIdsRef.current.add(event.operationId);
          onSettledRef.current?.(event);
        }
      }
    };

    // (Re)connected: catch up on anything that happened while disconnected.
    const handleReady = () => {
      void mutateRef.current();
    };

    const open = () => {
      if (source) return;
      source = new EventSource(
        `${getDirectCoreUrl()}/api/operations/stream?appId=${encodeURIComponent(appId)}`,
        { withCredentials: true },
      );
      source.addEventListener("operation", handleOperation as EventListener);
      source.addEventListener("ready", handleReady);
    };

    const close = () => {
      if (!source) return;
      source.removeEventListener("operation", handleOperation as EventListener);
      source.removeEventListener("ready", handleReady);
      source.close();
      source = null;
    };

    const onVisibilityChange = () => {
      if (isDocumentVisible()) open();
      else close();
    };

    if (isDocumentVisible()) open();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      close();
    };
  }, [enabled, appId]);

  /**
   * Show an operation we learned about out of band (e.g. the operationId in a
   * 409 conflict response). Returns the journal row, or null if unavailable.
   */
  const adopt = useCallback(
    async (operationId: string): Promise<OperationRecord | null> => {
      if (!appId) return null;
      try {
        const res = await fetch(`${CORE_URL}/api/operations/${encodeURIComponent(operationId)}`, {
          credentials: "include",
        });
        if (!res.ok) return null;
        const rec = parseOperationRecord(await res.json());
        if (!rec || rec.appId !== appId) return null;
        dispatch({ type: "seed", operation: operationFromRecord(rec) });
        return rec;
      } catch {
        return null;
      }
    },
    [appId],
  );

  const live = useMemo(
    () => (appId ? liveOperationFrom(streamed, history, appId) : null),
    [appId, streamed, history],
  );

  return {
    /** The current (or most recently streamed) operation for the app. */
    live,
    /** True while `live` is queued/running. */
    isActive: isActiveOperationStatus(live?.status),
    history: history ?? [],
    error: error as Error | undefined,
    isLoading,
    refresh: mutate,
    adopt,
  };
}
