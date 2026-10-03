"use client";

import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";
import type { Container } from "@talome/types";

interface QuickLookContextValue {
  open: (container: Container, port?: number) => void;
  port: number | undefined;
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

  const [port, setPort] = useState<number | undefined>();
  const open = useCallback((c: Container, selectedPort?: number) => { setContainer(c); setPort(selectedPort); }, []);
  const close = useCallback(() => setContainer(null), []);

  const value = useMemo(
    () => ({ open, close, container, port, isOpen: container !== null }),
    [open, close, container, port]
  );

  return (
    <QuickLookContext.Provider value={value}>
      {children}
    </QuickLookContext.Provider>
  );
}
