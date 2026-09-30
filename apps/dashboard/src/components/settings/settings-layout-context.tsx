"use client";

import { createContext, useContext } from "react";

/** Whether Settings is showing the sidebar + detail layout (wide windows). */
export const SettingsLayoutContext = createContext<{ twoPane: boolean }>({ twoPane: false });

export function useSettingsLayout() {
  return useContext(SettingsLayoutContext);
}
