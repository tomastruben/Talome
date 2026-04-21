"use client";

import { useMemo } from "react";
import { Widget, WidgetHeader } from "./widget";
import { CORE_URL } from "@/lib/constants";
import useSWR from "swr";
import type { WidgetManifest } from "@/hooks/use-widget-manifests";

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("Data source unavailable");
  return res.json();
};

export function DeclarativeWidget({
  manifest,
}: {
  manifest: WidgetManifest;
}) {
  const sourcePath = useMemo(() => {
    if (manifest.dataSource.startsWith("/")) return `${CORE_URL}${manifest.dataSource}`;
    return `${CORE_URL}/api/${manifest.dataSource.replace(/^api\//, "")}`;
  }, [manifest.dataSource]);

  const { data, error } = useSWR(sourcePath, fetcher, { refreshInterval: 10000 });

  return (
    <Widget>
      <WidgetHeader title={manifest.title} />
      <div className="px-4 py-3 grid gap-2">
        <p className="text-xs text-muted-foreground">{manifest.description}</p>
        {error ? (
          <p className="text-xs text-destructive/70">Unable to load widget data.</p>
        ) : (
          <pre className="text-xs text-muted-foreground bg-muted/30 rounded-md p-2 overflow-x-auto">
            {JSON.stringify(data ?? { loading: true }, null, 2)}
          </pre>
        )}
      </div>
    </Widget>
  );
}
