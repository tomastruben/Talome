"use client";

import { createContext, useContext, useState } from "react";

interface AutomationContextValue {
  sheetOpen: boolean;
  openCreate: () => void;
  closeSheet: () => void;
}

const AutomationContext = createContext<AutomationContextValue>({
  sheetOpen: false,
  openCreate: () => {},
  closeSheet: () => {},
});

export function AutomationProvider({ children }: { children: React.ReactNode }) {
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <AutomationContext.Provider
      value={{
        sheetOpen,
        openCreate: () => setSheetOpen(true),
        closeSheet: () => setSheetOpen(false),
      }}
    >
      {children}
    </AutomationContext.Provider>
  );
}

export function useAutomation() {
  return useContext(AutomationContext);
}
