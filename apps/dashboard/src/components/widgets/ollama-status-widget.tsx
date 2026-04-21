"use client";

import useSWR from "swr";
import Link from "next/link";
import { Widget, WidgetHeader } from "./widget";
import { CORE_URL } from "@/lib/constants";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface OllamaModel {
  name: string;
  size: number;
}

interface RunningModel {
  name: string;
  size: number;
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${bytes} B`;
}

export function OllamaStatusWidget() {
  const { data: settingsData } = useSWR<Record<string, string>>(
    `${CORE_URL}/api/settings`,
    fetcher,
  );
  const ollamaUrl = settingsData?.ollama_url ?? "";
  const isConfigured = !!ollamaUrl;

  const { data: modelsData } = useSWR<{ models: OllamaModel[] }>(
    isConfigured ? `${CORE_URL}/api/ollama/models` : null,
    fetcher,
    { refreshInterval: 30_000 },
  );
  const { data: psData } = useSWR<{ models: RunningModel[] }>(
    isConfigured ? `${CORE_URL}/api/ollama/ps` : null,
    fetcher,
    { refreshInterval: 10_000 },
  );

  const models = modelsData?.models ?? [];
  const running = psData?.models ?? [];

  return (
    <Widget>
      <WidgetHeader title="Local AI" />
      <Link href="/dashboard/settings/ai-provider" className="block min-h-0 flex-1 px-4 py-3 hover:bg-muted/20 transition-colors">
        {!isConfigured ? (
          <p className="text-xs text-muted-foreground">Not configured</p>
        ) : (
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Models</span>
              <span className="text-xs text-foreground">{models.length}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Active</span>
              <span className="text-xs text-foreground">
                {running.length > 0 ? (
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-status-healthy" />
                    {running.length} loaded
                  </span>
                ) : (
                  "none"
                )}
              </span>
            </div>
            {running.length > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">VRAM</span>
                <span className="text-xs text-foreground">
                  {formatSize(running.reduce((sum, m) => sum + m.size, 0))}
                </span>
              </div>
            )}
          </div>
        )}
      </Link>
    </Widget>
  );
}
