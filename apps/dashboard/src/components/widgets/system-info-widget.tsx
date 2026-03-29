"use client";

import { useSystemStats } from "@/hooks/use-system-stats";
import { ComputerTerminal01Icon } from "@/components/icons";
import { Widget, WidgetHeader } from "./widget";
import { WidgetList, WidgetListState, WidgetListSkeleton } from "./list-widget";

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function SystemInfoWidget() {
  const { stats, isConnecting } = useSystemStats();

  const rows = stats
    ? [
        { label: "Hostname",  value: stats.hostname },
        { label: "Platform",  value: `${stats.platform} ${stats.arch}` },
        { label: "Uptime",    value: formatUptime(stats.uptime) },
        { label: "CPU",       value: stats.cpu.model },
        { label: "Cores",     value: String(stats.cpu.cores) },
      ]
    : [];

  return (
    <Widget>
      <WidgetHeader title="System" />
      {isConnecting && rows.length === 0 ? (
        <WidgetList>
          <WidgetListSkeleton rows={5} />
        </WidgetList>
      ) : rows.length === 0 ? (
        <WidgetListState icon={ComputerTerminal01Icon} message="System details unavailable." />
      ) : (
        <WidgetList>
          <div className="divide-y divide-border/40">
            {rows.map(({ label, value }) => (
              <div key={label} className="flex items-center justify-between px-4 py-2.5">
                <span className="text-xs text-muted-foreground">{label}</span>
                <span className="text-sm font-medium truncate ml-4 text-right max-w-[60%]">{value}</span>
              </div>
            ))}
          </div>
        </WidgetList>
      )}
    </Widget>
  );
}
