"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { StackLayout } from "@/components/layout/stack-layout";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { SettingsLayoutContext } from "@/components/settings/settings-layout-context";

/** Width (px) at which Settings switches from a pushed list to sidebar + detail. */
const TWO_PANE_MIN_WIDTH = 900;

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [twoPane, setTwoPane] = useState(false);

  // Measure the space Settings actually has (a desktop window, or the page next
  // to the app sidebar), not the browser viewport.
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const update = () => setTwoPane(element.clientWidth >= TWO_PANE_MIN_WIDTH);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={rootRef} className="min-w-0">
      <SettingsLayoutContext.Provider value={{ twoPane }}>
        {twoPane ? (
          <div className="grid grid-cols-[15rem_minmax(0,1fr)]">
            <aside className="sticky top-0 self-start max-h-dvh overflow-y-auto border-r border-border/60 pb-6 pr-4">
              <SettingsSidebar />
            </aside>
            <div className="min-w-0 pl-8">{children}</div>
          </div>
        ) : (
          <StackLayout rootPath="/dashboard/settings">{children}</StackLayout>
        )}
      </SettingsLayoutContext.Provider>
    </div>
  );
}
