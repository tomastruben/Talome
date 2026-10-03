"use client";

import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";
import { containerDisplayName } from "@/lib/container-label";
import { requestDesktopNavigation } from "@/lib/desktop-navigation";
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
  const open = useCallback((c: Container, selectedPort?: number) => {
    const params = new URLSearchParams({ id: c.id, name: containerDisplayName(c) });
    if (selectedPort !== undefined) params.set("port", String(selectedPort));
    if (requestDesktopNavigation(`/dashboard/containers/preview?${params}`)) return;
    setContainer(c);
    setPort(selectedPort);
  }, []);
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
