import { HugeiconsIcon, AlertCircleIcon } from "@/components/icons";
import { Widget, WidgetHeader } from "@/components/widgets/widget";
import { relativeTime } from "@/lib/format";
import { humanizeEventMessage } from "@/lib/humanize-activity";
import { cn } from "@/lib/utils";
import type { AgentEvent, AgentRemediation } from "@/lib/humanize-activity";

interface ProblemsWidgetProps {
  problems: { event: AgentEvent; count: number }[];
  remediationByEvent: Map<string, AgentRemediation>;
}

export function ProblemsWidget({ problems, remediationByEvent }: ProblemsWidgetProps) {
  if (problems.length === 0) return null;

  return (
    <Widget className="h-auto">
      <WidgetHeader title="Problems" />
      <div className="divide-y divide-border/40">
        {problems.map(({ event, count }) => {
          const remediation = remediationByEvent.get(event.id);
          return (
            <div
              key={`${event.source}:${event.type}`}
              className="flex items-start gap-4 px-4 py-3.5"
            >
              <div className="size-7 rounded-lg bg-status-critical/10 flex items-center justify-center shrink-0 mt-0.5">
                <HugeiconsIcon icon={AlertCircleIcon} size={14} className="text-status-critical" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground">
                  {humanizeEventMessage(event)}
                  {count > 1 && <span className="text-muted-foreground ml-1.5">&times;{count}</span>}
                </p>
                {remediation ? (
                  <p className={cn(
                    "text-sm mt-1",
                    remediation.outcome === "success" ? "text-status-healthy/70" :
                    remediation.outcome === "failure" ? "text-status-critical/70" :
                    "text-muted-foreground"
                  )}>
                    {remediation.action}
                    {remediation.outcome === "success" && " · completed"}
                    {remediation.outcome === "failure" && " · failed"}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground mt-1">No action taken</p>
                )}
              </div>
              <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
                {relativeTime(event.createdAt)}
              </span>
            </div>
          );
        })}
      </div>
    </Widget>
  );
}
