"use client";

import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";
import { Activity01Icon } from "@/components/icons";
import { Widget, WidgetHeader } from "./widget";
import { Status, StatusIndicator } from "@/components/kibo-ui/status";
import { Pill } from "@/components/kibo-ui/pill";
import { WidgetList, WidgetListSkeleton, WidgetListState } from "./list-widget";

interface ArrService {
  name: string;
  ok: boolean;
  version?: string;
  url?: string;
  pendingRequests?: number;
}

interface ArrStatus {
  sonarr:    ArrService;
  radarr:    ArrService;
  prowlarr:  ArrService;
  overseerr: ArrService & { pendingRequests?: number };
}

const SERVICE_LABELS: Record<string, string> = {
  sonarr:    "Sonarr",
  radarr:    "Radarr",
  prowlarr:  "Prowlarr",
  overseerr: "Overseerr",
};

const fetcher = (url: string) => fetch(url, { credentials: "include" }).then((r) => r.json());

export function ArrStatusWidget({ mode = "full" }: { mode?: "compact" | "full" }) {
  const { data, isLoading } = useSWR<ArrStatus>(
    `${CORE_URL}/api/media/arr-status`,
    fetcher,
    { refreshInterval: 30000 }
  );

  const services = data
    ? [data.sonarr, data.radarr, data.prowlarr, data.overseerr].filter(Boolean)
    : [];
  const onlineCount = services.filter((svc) => svc.ok).length;

  if (mode === "compact") {
    return (
      <Widget>
        <WidgetHeader
          title="Media"
          actions={
            services.length > 0 ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                {onlineCount}/{services.length} online
              </span>
            ) : undefined
          }
        />
        {isLoading || services.length === 0 ? (
          isLoading ? (
            <WidgetList>
              <WidgetListSkeleton rows={4} />
            </WidgetList>
          ) : (
            <WidgetListState icon={Activity01Icon} message="No media service data." />
          )
        ) : (
          <WidgetList>
            <div className="divide-y divide-border/40">
              {services.map((svc) => (
                <div key={svc.name} className="flex items-center justify-between gap-2 px-4 py-2.5">
                  <span className="inline-flex items-center gap-1.5 min-w-0">
                    <span className={`size-1.5 rounded-full shrink-0 ${svc.ok ? "bg-status-healthy" : "bg-destructive"}`} />
                    <span className="text-sm truncate">{SERVICE_LABELS[svc.name] ?? svc.name}</span>
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {svc.ok ? "Online" : "Down"}
                  </span>
                </div>
              ))}
            </div>
          </WidgetList>
        )}
      </Widget>
    );
  }

  return (
    <Widget>
      <WidgetHeader title="Media Services" href="/dashboard/settings" hrefLabel="Configure" />
      {isLoading ? (
        <div className="divide-y divide-border/40">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <span className="size-2 rounded-full bg-muted animate-pulse" />
              <span className="h-3 w-20 rounded bg-muted animate-pulse" />
            </div>
          ))}
        </div>
      ) : (
        <div className="divide-y divide-border/40">
          {services.map((svc) => (
            <div key={svc.name} className="flex items-center gap-3 px-4 py-2.5">
              <Status
                status={svc.ok ? "online" : "offline"}
                className="text-xs px-2 py-0.5 gap-1.5 flex-1"
              >
                <StatusIndicator />
                <span className="text-sm font-medium text-foreground">
                  {SERVICE_LABELS[svc.name] ?? svc.name}
                </span>
                {svc.ok && svc.version && (
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    v{svc.version}
                  </span>
                )}
                {!svc.ok && (
                  <span className="ml-auto text-xs text-muted-foreground">Unreachable</span>
                )}
              </Status>
              {svc.name === "overseerr" && svc.ok && (svc as ArrService).pendingRequests != null && (svc as ArrService).pendingRequests! > 0 && (
                <Pill variant="secondary" className="text-xs py-0.5 px-2 shrink-0">
                  {(svc as ArrService).pendingRequests} pending
                </Pill>
              )}
            </div>
          ))}
        </div>
      )}
    </Widget>
  );
}
