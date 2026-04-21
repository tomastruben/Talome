"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";

interface AuditEntry {
  id: number;
  timestamp: string;
  action: string;
  tier: "read" | "modify" | "destructive";
  approved: boolean;
  details: string;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function fetcher(url: string): Promise<AuditEntry[]> {
  const res = await fetch(url);
  if (!res.ok) return [];
  return res.json();
}

export function useActivityCount() {
  const { data } = useSWR<AuditEntry[]>(
    `${CORE_URL}/api/audit-log/recent?limit=10`,
    fetcher,
    { refreshInterval: 10000 }
  );
  return data?.length ?? 0;
}

export function ActivityFeed() {
  const { data: items } = useSWR<AuditEntry[]>(
    `${CORE_URL}/api/audit-log/recent?limit=10`,
    fetcher,
    { refreshInterval: 10000 }
  );

  const entries = items ?? [];

  if (entries.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-medium">Recent Activity</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-0.5">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 border-l-2",
              entry.tier === "destructive" ? "border-l-status-critical/50" :
              entry.tier === "modify" ? "border-l-status-warning/30" :
              "border-l-transparent"
            )}
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm truncate text-muted-foreground">
                {entry.action}{" "}
                <span className="font-medium text-foreground">{entry.details}</span>
              </p>
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {timeAgo(entry.timestamp)}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
