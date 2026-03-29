"use client";

import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";

type CinemaTab = "movies" | "tv";

interface CinemaBrowserContextValue {
  isOpen: boolean;
  tab: CinemaTab;
  open: (tab?: CinemaTab) => void;
  close: () => void;
}

const CinemaBrowserContext = createContext<CinemaBrowserContextValue | null>(null);

export function useCinemaBrowser() {
  const ctx = useContext(CinemaBrowserContext);
  if (!ctx) throw new Error("useCinemaBrowser must be used inside CinemaBrowserProvider");
  return ctx;
}

export function CinemaBrowserProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<CinemaTab>("movies");

  const open = useCallback((t?: CinemaTab) => {
    // Cinema mode is designed for large screens — block on mobile/small viewports
    if (typeof window !== "undefined" && window.innerWidth < 768) return;
    if (t) setTab(t);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => setIsOpen(false), []);

  const value = useMemo(
    () => ({ isOpen, tab, open, close }),
    [isOpen, tab, open, close],
  );

  return (
    <CinemaBrowserContext.Provider value={value}>
      {children}
    </CinemaBrowserContext.Provider>
  );
}
