"use client";

import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";
import { relativeTime } from "@/lib/format";
import { Activity01Icon } from "@/components/icons";
import { InlineMarkdown } from "@/components/ui/inline-markdown";
import { Widget, WidgetHeader } from "./widget";
import { WidgetList, WidgetListState, WidgetListSkeleton } from "./list-widget";

interface SummaryResponse {
  summary: string | null;
  generatedAt: string | null;
  source: "ai" | "raw" | "error";
}

const fetcher = (url: string) => fetch(url, { credentials: "include" }).then((r) => r.json());

export function ActivityWidget() {
  const { data, isLoading } = useSWR<SummaryResponse>(
    `${CORE_URL}/api/audit-log/summary`,
    fetcher,
    { refreshInterval: 60_000 }
  );

  if (isLoading) {
    return (
      <Widget>
        <WidgetHeader title="Recent Activity" href="/dashboard/intelligence" hrefLabel="View all" />
        <WidgetList>
          <WidgetListSkeleton rows={4} />
        </WidgetList>
      </Widget>
    );
  }

  if (!data || data.source === "error" || !data.summary) {
    return (
      <Widget>
        <WidgetHeader title="Recent Activity" href="/dashboard/intelligence" hrefLabel="View all" />
        <WidgetListState icon={Activity01Icon} message="No recent activity." />
      </Widget>
    );
  }

  // Parse bullet lines — AI returns "• line" format; raw is newline-separated
  const lines = data.summary
    .split("\n")
    .map((l) => l.replace(/^[•\-*]\s*/, "").trim())
    .filter(Boolean);

  return (
    <Widget>
      <WidgetHeader title="Recent Activity" href="/dashboard/intelligence" hrefLabel="View all" />
      <div className="min-h-0 flex-1 flex flex-col">
        <WidgetList className="px-4 pt-3">
          <div className="space-y-3 pb-3">
            {lines.map((line, i) => (
              <p key={i} className="text-sm text-muted-foreground leading-relaxed"><InlineMarkdown text={line} /></p>
            ))}
          </div>
        </WidgetList>
        <div className="border-t border-border/40 px-4 py-2">
          <p className="text-xs text-muted-foreground">
            Updated {data.generatedAt ? relativeTime(data.generatedAt) : "just now"}
          </p>
        </div>
      </div>
    </Widget>
  );
}
