"use client";

import { DocsSearchDialog } from "@/components/docs/search";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";

export function DocsProvider({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      search={{ SearchDialog: DocsSearchDialog }}
      theme={{ defaultTheme: "dark", enabled: false }}
    >
      {children}
    </RootProvider>
  );
}
