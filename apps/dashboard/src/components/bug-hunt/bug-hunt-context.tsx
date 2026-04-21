"use client";

import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";
import type { BugContext } from "@/hooks/use-bug-context";

export type BugHuntMode = "bug" | "feature";

interface BugHuntOpenOptions {
  screenshot?: string;
  context?: BugContext;
  mode?: BugHuntMode;
}

interface BugHuntContextValue {
  open: (options?: BugHuntOpenOptions) => void;
  close: () => void;
  isOpen: boolean;
  screenshot: string | null;
  context: BugContext | null;
  mode: BugHuntMode;
}

const BugHuntCtx = createContext<BugHuntContextValue | null>(null);

export function useBugHunt() {
  const ctx = useContext(BugHuntCtx);
  if (!ctx) throw new Error("useBugHunt must be used inside BugHuntProvider");
  return ctx;
}

export function BugHuntProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [context, setContext] = useState<BugContext | null>(null);
  const [mode, setMode] = useState<BugHuntMode>("bug");

  const open = useCallback((options?: BugHuntOpenOptions) => {
    setScreenshot(options?.screenshot ?? null);
    setContext(options?.context ?? null);
    setMode(options?.mode ?? "bug");
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    // Delay clearing data so close animation completes
    setTimeout(() => {
      setScreenshot(null);
      setContext(null);
      setMode("bug");
    }, 200);
  }, []);

  const value = useMemo(
    () => ({ open, close, isOpen, screenshot, context, mode }),
    [open, close, isOpen, screenshot, context, mode],
  );

  return (
    <BugHuntCtx.Provider value={value}>
      {children}
    </BugHuntCtx.Provider>
  );
}
