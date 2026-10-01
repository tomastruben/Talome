"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { announce } from "@/components/ui/live-announcer";
import { CORE_URL } from "@/lib/constants";
import { FetchJsonError, fetchErrorStatus, fetchJson } from "@/lib/fetch-json";
import {
  SEARCH_MIN_CHARS,
  countNoun,
  searchErrorCopy,
  type FileSearchResponse,
} from "@/components/files/file-helpers";

/** Typing pauses this long before a search starts; Enter starts it at once. */
export const SEARCH_DEBOUNCE_MS = 300;
/** Results asked for per search (the server's default). */
export const SEARCH_RESULT_LIMIT = 200;

export interface FileSearchError {
  /** HTTP status, or null when the server didn't answer */
  status: number | null;
  /** The server's own message, when its JSON body had one */
  message: string | null;
  /** The server's error code (ENOENT for a folder that's gone) */
  code: string | null;
}

/** A string field of the server's JSON error body, if it sent one. */
function bodyField(err: unknown, field: "error" | "code"): string | null {
  if (!(err instanceof FetchJsonError) || !err.body || typeof err.body !== "object") return null;
  const value = (err.body as Record<string, unknown>)[field];
  return typeof value === "string" && value ? value : null;
}

export interface FileSearch {
  /** The latest results. While a newer search runs they stay on screen, dimmed (`stale`). */
  result: FileSearchResponse | null;
  /** The query `result` answers */
  forQuery: string | null;
  /** True when `result` answers an older query, folder or hidden-files setting */
  stale: boolean;
  /** The current search failed */
  error: FileSearchError | null;
  /** A request is in flight */
  searching: boolean;
  /** Search now, without waiting for typing to pause (Enter, a scope switch, Retry) */
  runNow: () => void;
  /** Stop the request in flight (Clear, Escape) */
  cancel: () => void;
}

interface Options {
  /** Searching below the folder (deep scope); off while filtering one folder */
  enabled: boolean;
  /** The folder to search below, or null for every location */
  path: string | null;
  query: string;
  showHidden: boolean;
  /** For announcements: "Photos", "all locations" */
  locationName: string;
}

const keyOf = (path: string | null, query: string, showHidden: boolean) => `${path ?? ""}\u0000${showHidden ? 1 : 0}\u0000${query}`;

/**
 * Name search below a folder (GET /api/files/search). Debounced while typing;
 * every request has its own AbortController and is aborted when a newer one
 * starts, the folder or hidden-files setting changes, the search is cleared
 * or the page goes away. An aborted request is never an error.
 */
export function useFileSearch({ enabled, path, query, showHidden, locationName }: Options): FileSearch {
  const trimmed = query.trim();
  const active = enabled && trimmed.length >= SEARCH_MIN_CHARS;
  const key = keyOf(path, trimmed, showHidden);

  const [result, setResult] = useState<{ key: string; query: string; response: FileSearchResponse } | null>(null);
  const [failure, setFailure] = useState<{ key: string; error: FileSearchError } | null>(null);
  const [inFlight, setInFlight] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const immediateRef = useRef(false);
  const wasEnabledRef = useRef(enabled);
  const locationRef = useRef(locationName);

  const abortInFlight = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  useEffect(() => {
    if (!active) return;
    // Enter, Retry and switching to this scope search at once; typing waits for a pause.
    const immediate = immediateRef.current || !wasEnabledRef.current;
    immediateRef.current = false;
    const searchKey = key;
    const q = trimmed;
    const timer = window.setTimeout(() => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setInFlight(searchKey);

      const params = new URLSearchParams();
      if (path) params.set("path", path);
      params.set("q", q);
      params.set("limit", String(SEARCH_RESULT_LIMIT));
      params.set("showHidden", String(showHidden));

      fetchJson<FileSearchResponse>(`${CORE_URL}/api/files/search?${params.toString()}`, { signal: controller.signal })
        .then((response) => {
          if (controller.signal.aborted) return;
          controllerRef.current = null;
          setInFlight(null);
          setFailure(null);
          setResult({ key: searchKey, query: q, response });
          const count = response.items.length;
          announce(
            count === 0
              ? `No results for “${q}”`
              : response.truncated === "results"
                ? `First ${countNoun(count, "result", "results")}`
                : countNoun(count, "result", "results"),
          );
        })
        .catch((err: unknown) => {
          // A newer search, a cleared field or a closed page: not a failure.
          if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) return;
          controllerRef.current = null;
          setInFlight(null);
          const status = fetchErrorStatus(err);
          // The server's own words only: not a fallback like "Request failed (503)".
          const message = bodyField(err, "error");
          const code = bodyField(err, "code");
          setFailure({ key: searchKey, error: { status, message, code } });
          announce(searchErrorCopy(status, message, locationRef.current, code).title);
        });
    }, immediate ? 0 : SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      abortInFlight();
      setInFlight(null);
    };
  }, [active, key, trimmed, path, showHidden, nonce, abortInFlight]);

  // Read by the effect above on the next change, so they're updated after it.
  useEffect(() => {
    wasEnabledRef.current = enabled;
    locationRef.current = locationName;
  });

  // Unmount: nothing may answer a page that's gone.
  useEffect(() => abortInFlight, [abortInFlight]);

  const runNow = useCallback(() => {
    immediateRef.current = true;
    setNonce((n) => n + 1);
  }, []);

  const cancel = useCallback(() => {
    abortInFlight();
    setInFlight(null);
  }, [abortInFlight]);

  return {
    result: result?.response ?? null,
    forQuery: result?.query ?? null,
    stale: !!result && result.key !== key,
    error: active && failure?.key === key ? failure.error : null,
    searching: active && inFlight !== null,
    runNow,
    cancel,
  };
}
