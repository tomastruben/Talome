"use client";

import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";
import { Widget, WidgetHeader } from "./widget";
import { HugeiconsIcon, Film01Icon, Tv01Icon, Notification01Icon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { WidgetList, WidgetListSkeleton, WidgetListState } from "./list-widget";

interface OverseerrRequest {
  id: number;
  type: "movie" | "tv";
  status: number;
  title: string;
  requestedBy: string;
  createdAt: string;
}

interface RequestsData {
  results: OverseerrRequest[];
}

// Overseerr status codes
const STATUS_MAP: Record<number, { label: string; color: string }> = {
  1: { label: "Pending",   color: "text-status-warning" },
  2: { label: "Approved",  color: "text-status-info" },
  3: { label: "Declined",  color: "text-destructive" },
  4: { label: "Available", color: "text-status-healthy" },
  5: { label: "Processing", color: "text-status-info" },
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const fetcher = (url: string) => fetch(url, { credentials: "include" }).then((r) => r.json());

export function OverseerrRequestsWidget() {
  const { data, isLoading } = useSWR<RequestsData>(
    `${CORE_URL}/api/media/requests`,
    fetcher,
    { refreshInterval: 60000 }
  );

  const requests = data?.results ?? [];

  return (
    <Widget>
      <WidgetHeader title="Requests" href="/dashboard/media" hrefLabel="Media" />
      {isLoading ? (
        <WidgetList>
          <WidgetListSkeleton rows={5} />
        </WidgetList>
      ) : requests.length === 0 ? (
        <WidgetListState icon={Notification01Icon} message="No recent requests." />
      ) : (
        <WidgetList>
          <div className="divide-y divide-border/40">
            {requests.map((req) => {
              const status = STATUS_MAP[req.status] ?? { label: String(req.status), color: "text-muted-foreground" };
              return (
                <div key={req.id} className="flex items-center gap-3 px-4 py-2.5">
                  <HugeiconsIcon
                    icon={req.type === "movie" ? Film01Icon : Tv01Icon}
                    size={13}
                    className="text-dim-foreground shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{req.title}</p>
                    <p className="text-xs text-muted-foreground">{req.requestedBy}</p>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 shrink-0">
                    <span className={cn("text-xs font-medium", status.color)}>{status.label}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{timeAgo(req.createdAt)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </WidgetList>
      )}
    </Widget>
  );
}
