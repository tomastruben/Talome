"use client";

import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";
import type { Container } from "@talome/types";

interface QuickLookContextValue {
  open: (container: Container) => void;
  close: () => void;
  container: Container | null;
  isOpen: boolean;
}

const QuickLookContext = createContext<QuickLookContextValue | null>(null);

export function useQuickLook() {
  const ctx = useContext(QuickLookContext);
  if (!ctx) throw new Error("useQuickLook must be used inside QuickLookProvider");
  return ctx;
}

export function QuickLookProvider({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<Container | null>(null);

  const open = useCallback((c: Container) => setContainer(c), []);
  const close = useCallback(() => setContainer(null), []);

  const value = useMemo(
    () => ({ open, close, container, isOpen: container !== null }),
    [open, close, container]
  );

  return (
    <QuickLookContext.Provider value={value}>
      {children}
    </QuickLookContext.Provider>
  );
}
