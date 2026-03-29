"use client";

import { Widget, WidgetHeader } from "./widget";
import { useIsOnline } from "@/hooks/use-is-online";
import { formatUptime, relativeTime } from "@/lib/format";

type CheckStatus = "ok" | "error" | "unknown";

function statusText(s: CheckStatus): string {
  return s === "ok" ? "Online" : s === "error" ? "Issue" : "Unknown";
}

function statusDotClass(s: CheckStatus): string {
  if (s === "ok") return "bg-status-healthy";
  if (s === "error") return "bg-destructive";
  return "bg-muted-foreground/40";
}

interface CheckRowProps {
  label: string;
  status: CheckStatus;
}

function CheckRow({ label, status }: CheckRowProps) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-border/40 last:border-0">
      <span className="text-sm text-foreground">{label}</span>
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className={`size-1.5 rounded-full ${statusDotClass(status)}`} />
        {statusText(status)}
      </span>
    </div>
  );
}

export function SystemStatusWidget({ mode = "full" }: { mode?: "compact" | "full" }) {
  const { status, checks, uptime, checkedAt } = useIsOnline();

  const dbStatus: CheckStatus =
    checks.db === "ok" ? "ok" : checks.db === "error" ? "error" : "unknown";
  const dockerStatus: CheckStatus =
    checks.docker === "ok" ? "ok" : checks.docker === "error" ? "error" : "unknown";

  const overallStatus =
    status === "online"   ? "online"
    : status === "degraded" ? "degraded"
    : "offline";
  const overallCheckStatus: CheckStatus =
    overallStatus === "online" ? "ok" : overallStatus === "offline" ? "error" : "unknown";

  if (mode === "compact") {
    return (
      <Widget>
        <WidgetHeader
          title="System"
          actions={<span className={`size-1.5 rounded-full ${statusDotClass(overallCheckStatus)}`} />}
        />
        <div className="min-h-0 flex-1 flex flex-col px-4 py-3">
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-foreground">DB</span>
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className={`size-1.5 rounded-full ${statusDotClass(dbStatus)}`} />
                {statusText(dbStatus)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-foreground">Docker</span>
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className={`size-1.5 rounded-full ${statusDotClass(dockerStatus)}`} />
                {statusText(dockerStatus)}
              </span>
            </div>
          </div>
          <p className="mt-auto pt-3 text-xs text-muted-foreground">
            Up {uptime > 0 ? formatUptime(uptime) : "—"} · {relativeTime(checkedAt)}
          </p>
        </div>
      </Widget>
    );
  }

  return (
    <Widget>
      <WidgetHeader
        title="System Status"
        actions={
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={`size-1.5 rounded-full ${statusDotClass(overallCheckStatus)}`} />
            {overallStatus === "online" ? "Online" : overallStatus === "offline" ? "Offline" : "Degraded"}
          </span>
        }
      />
      <div className="min-h-0 flex-1 flex flex-col">
        <div className="px-4">
        <CheckRow label="Database" status={dbStatus} />
        <CheckRow label="Docker" status={dockerStatus} />
        </div>
        <div className="mt-auto border-t border-border/40 px-4 py-2 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Uptime: {uptime > 0 ? formatUptime(uptime) : "—"}
          </span>
          <span className="text-xs text-muted-foreground">
            Updated {relativeTime(checkedAt)}
          </span>
        </div>
      </div>
    </Widget>
  );
}
