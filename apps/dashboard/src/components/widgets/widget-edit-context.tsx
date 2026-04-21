"use client";

import { createContext, useContext, useMemo, useState } from "react";

interface WidgetEditContextValue {
  editMode: boolean;
  setEditMode: (v: boolean | ((prev: boolean) => boolean)) => void;
}

const WidgetEditContext = createContext<WidgetEditContextValue>({
  editMode: false,
  setEditMode: () => {},
});

export function WidgetEditProvider({ children }: { children: React.ReactNode }) {
  const [editMode, setEditMode] = useState(false);
  const value = useMemo(() => ({ editMode, setEditMode }), [editMode]);
  return (
    <WidgetEditContext.Provider value={value}>
      {children}
    </WidgetEditContext.Provider>
  );
}

export function useWidgetEdit() {
  return useContext(WidgetEditContext);
}
