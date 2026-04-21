import { HugeiconsIcon, ArrowRight01Icon } from "@/components/icons";
import { Widget, WidgetHeader } from "@/components/widgets/widget";
import { cn } from "@/lib/utils";
import { ZONE_LABELS, type BudgetZone } from "@/lib/cost-projection";

interface CostData {
  today: { cost: number; cap: number; zone?: BudgetZone };
  projectedMonthly: number;
}

interface AgentUsage {
  totalCostUsd: number;
}

interface AiOverviewWidgetProps {
  costData: CostData | undefined;
  eventsCount: number;
  criticalCount: number;
  remediationsCount: number;
  successfulRemediations: number;
  usage: AgentUsage | undefined;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0 px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums text-foreground">{value}</span>
      {sub && <span className="text-xs text-muted-foreground tabular-nums">{sub}</span>}
    </div>
  );
}

export function AiOverviewWidget({
  costData,
  eventsCount,
  criticalCount,
  remediationsCount,
  successfulRemediations,
  usage,
}: AiOverviewWidgetProps) {
  if (!costData && !usage) return null;

  const costRatio = costData && costData.today.cap > 0
    ? costData.today.cost / costData.today.cap
    : 0;

  const zone = costData?.today.zone;
  const zoneLabel = zone && zone !== "green" ? ZONE_LABELS[zone] : null;

  const barColor =
    costRatio > 0.8
      ? "bg-status-critical"
      : costRatio > 0.5
        ? "bg-status-warning"
        : "bg-status-healthy";

  return (
    <Widget className="h-auto">
      <WidgetHeader
        title="AI Overview"
        href="/dashboard/settings/ai-cost"
        hrefLabel="Settings"
      />

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-border/40">
        {costData && (
          <Stat
            label="Today"
            value={`$${costData.today.cost.toFixed(2)}`}
            sub={costData.today.cap > 0 ? `of $${costData.today.cap.toFixed(2)}` : undefined}
          />
        )}
        <Stat
          label="Events"
          value={String(eventsCount)}
          sub={criticalCount > 0 ? `${criticalCount} critical` : undefined}
        />
        <Stat
          label="Fixed"
          value={remediationsCount > 0 ? `${Math.round((successfulRemediations / remediationsCount) * 100)}%` : "—"}
          sub={remediationsCount > 0 ? `${successfulRemediations} of ${remediationsCount}` : undefined}
        />
        {usage && (
          <Stat
            label="30d cost"
            value={`$${usage.totalCostUsd.toFixed(2)}`}
            sub={costData?.projectedMonthly ? `~$${costData.projectedMonthly.toFixed(2)}/mo` : undefined}
          />
        )}
      </div>

      {/* Cost bar */}
      {costData && costData.today.cap > 0 && (
        <div className="flex items-center gap-3 px-4 pb-3">
          <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all", barColor)}
              style={{ width: `${Math.min(100, costRatio * 100)}%` }}
            />
          </div>
          {zoneLabel && (
            <span className={cn(
              "text-xs shrink-0",
              (zone === "yellow" || zone === "orange") && "text-status-warning",
              (zone === "red" || zone === "exhausted") && "text-status-critical",
            )}>
              {zoneLabel.label}
            </span>
          )}
        </div>
      )}
    </Widget>
  );
}
