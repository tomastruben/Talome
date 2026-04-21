"use client";

import { useEffect, useRef, useCallback } from "react";
import { usePathname } from "next/navigation";

// ── Console error buffer (global singleton) ─────────────────────────────────

interface ConsoleEntry {
  level: "error" | "warn";
  message: string;
  timestamp: string;
}

const MAX_ENTRIES = 50;
const consoleBuffer: ConsoleEntry[] = [];
let patched = false;

function patchConsole() {
  if (patched || typeof window === "undefined") return;
  patched = true;

  const originalError = console.error;
  const originalWarn = console.warn;

  console.error = (...args: unknown[]) => {
    consoleBuffer.push({
      level: "error",
      message: args.map(String).join(" ").slice(0, 500),
      timestamp: new Date().toISOString(),
    });
    if (consoleBuffer.length > MAX_ENTRIES) consoleBuffer.shift();
    originalError.apply(console, args);
  };

  console.warn = (...args: unknown[]) => {
    consoleBuffer.push({
      level: "warn",
      message: args.map(String).join(" ").slice(0, 500),
      timestamp: new Date().toISOString(),
    });
    if (consoleBuffer.length > MAX_ENTRIES) consoleBuffer.shift();
    originalWarn.apply(console, args);
  };
}

// ── Network error tracking ──────────────────────────────────────────────────

interface NetworkError {
  url: string;
  status: number;
  method: string;
  timestamp: string;
}

const networkErrors: NetworkError[] = [];
let fetchPatched = false;

function patchFetch() {
  if (fetchPatched || typeof window === "undefined") return;
  fetchPatched = true;

  const originalFetch = window.fetch;
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await originalFetch(...args);
    if (!res.ok) {
      const url = typeof args[0] === "string" ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]);
      const method = (args[1]?.method ?? "GET").toUpperCase();
      networkErrors.push({
        url: url.replace(/https?:\/\/[^/]+/, ""), // strip host
        status: res.status,
        method,
        timestamp: new Date().toISOString(),
      });
      if (networkErrors.length > MAX_ENTRIES) networkErrors.shift();
    }
    return res;
  };
}

// ── Unhandled error tracking ────────────────────────────────────────────────

const uncaughtErrors: string[] = [];
let errorListenerAdded = false;

function addErrorListener() {
  if (errorListenerAdded || typeof window === "undefined") return;
  errorListenerAdded = true;

  window.addEventListener("error", (e) => {
    uncaughtErrors.push(`${e.message} at ${e.filename}:${e.lineno}`);
    if (uncaughtErrors.length > 20) uncaughtErrors.shift();
  });

  window.addEventListener("unhandledrejection", (e) => {
    uncaughtErrors.push(`Unhandled rejection: ${String(e.reason).slice(0, 300)}`);
    if (uncaughtErrors.length > 20) uncaughtErrors.shift();
  });
}

// ── Hook ────────────────────────────────────────────────────────────────────

export interface BugContext {
  route: string;
  viewport: { width: number; height: number };
  userAgent: string;
  consoleErrors: ConsoleEntry[];
  networkErrors: NetworkError[];
  uncaughtErrors: string[];
  timestamp: string;
}

export function useBugContext() {
  const pathname = usePathname();
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current) {
      patchConsole();
      patchFetch();
      addErrorListener();
      initialized.current = true;
    }
  }, []);

  const captureContext = useCallback((): BugContext => {
    return {
      route: pathname,
      viewport: {
        width: typeof window !== "undefined" ? window.innerWidth : 0,
        height: typeof window !== "undefined" ? window.innerHeight : 0,
      },
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      consoleErrors: [...consoleBuffer],
      networkErrors: [...networkErrors],
      uncaughtErrors: [...uncaughtErrors],
      timestamp: new Date().toISOString(),
    };
  }, [pathname]);

  return { captureContext };
}
