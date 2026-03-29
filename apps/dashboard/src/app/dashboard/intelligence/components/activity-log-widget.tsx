"use client";

import { useRef } from "react";
import {
  HugeiconsIcon,
  Activity01Icon,
  CpuIcon,
  Package01Icon,
  AiChipIcon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { InlineMarkdown } from "@/components/ui/inline-markdown";
import { Widget, WidgetHeader } from "@/components/widgets/widget";
import { relativeTime } from "@/lib/format";
import {
  type UnifiedTimelineItem,
  type FilterType,
  humanizeUnifiedItem,
} from "@/lib/humanize-activity";

interface TimelineGroup {
  label: string;
  items: UnifiedTimelineItem[];
}

interface ActivityLogWidgetProps {
  groupedTimeline: TimelineGroup[];
  deduped: UnifiedTimelineItem[];
  timeline: UnifiedTimelineItem[];
  filter: FilterType;
  timelineExpanded: boolean;
  timelineLimit: number;
  logsLoading: boolean;
  logsError: Error | undefined;
  getTimelineVisual: (item: UnifiedTimelineItem) => { icon: IconSvgElement; iconColor: string };
  onFilterChange: (filter: FilterType) => void;
  onExpandTimeline: () => void;
  onSelectItem: (item: UnifiedTimelineItem) => void;
  onRetryLogs: () => void;
}

/** Walk up the DOM to find the nearest scrollable ancestor */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

export function ActivityLogWidget({
  groupedTimeline,
  deduped,
  timeline,
  filter,
  timelineExpanded,
  timelineLimit,
  logsLoading,
  logsError,
  getTimelineVisual,
  onFilterChange,
  onExpandTimeline,
  onSelectItem,
  onRetryLogs,
}: ActivityLogWidgetProps) {
  const tabsRef = useRef<HTMLDivElement>(null);

  if (logsError) {
    return (
      <Widget className="h-auto">
        <WidgetHeader title="Activity Log" />
        <div className="px-4 py-6">
          <ErrorState
            title="Couldn't load activity"
            description="Check that the Talome server is reachable."
            onRetry={onRetryLogs}
          />
        </div>
      </Widget>
    );
  }

  if (logsLoading) {
    return (
      <Widget className="h-auto">
        <WidgetHeader title="Activity Log" />
        <div className="px-4 py-3 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 py-2">
              <Skeleton className="size-1.5 rounded-full" />
              <Skeleton className="h-3.5 flex-1 max-w-72" />
              <Skeleton className="h-3 w-12" />
            </div>
          ))}
        </div>
      </Widget>
    );
  }

  return (
    <Widget className="h-auto">
      <WidgetHeader title="Activity Log" />

      {/* Filter tabs */}
      <div ref={tabsRef} className="px-4 pt-3 pb-1">
        <Tabs
          value={filter}
          onValueChange={(v) => {
            const scrollEl = findScrollParent(tabsRef.current);
            const prevTop = scrollEl?.scrollTop ?? 0;
            onFilterChange(v as FilterType);
            requestAnimationFrame(() => {
              if (scrollEl) scrollEl.scrollTop = prevTop;
            });
          }}
        >
          <TabsList className="w-full">
            <TabsTrigger value="all" className="text-xs">
              <HugeiconsIcon icon={Activity01Icon} size={14} />
              All
            </TabsTrigger>
            <TabsTrigger value="system" className="text-xs">
              <HugeiconsIcon icon={CpuIcon} size={14} />
              System
            </TabsTrigger>
            <TabsTrigger value="apps" className="text-xs">
              <HugeiconsIcon icon={Package01Icon} size={14} />
              Apps
            </TabsTrigger>
            <TabsTrigger value="ai" className="text-xs">
              <HugeiconsIcon icon={AiChipIcon} size={14} />
              AI
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Timeline content */}
      <div className="px-4 pb-4">
        {deduped.length === 0 ? (
          <div className="py-8">
            <EmptyState
              icon={Activity01Icon}
              title={timeline.length === 0 ? "No activity yet" : "No entries match"}
              description={
                timeline.length === 0
                  ? "Actions you take will appear here."
                  : "Try a different filter."
              }
            />
          </div>
        ) : (
          <>
            {groupedTimeline.map((group) => (
              <div key={group.label}>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1 pt-4 pb-2">
                  {group.label}
                </p>
                {group.items.map((item) => {
                  const { text } = humanizeUnifiedItem(item);
                  const { icon, iconColor } = getTimelineVisual(item);
                  return (
                    <button
                      key={`${item.kind}-${item.data.id}`}
                      type="button"
                      onClick={() => onSelectItem(item)}
                      className="flex items-center gap-3 w-full px-1 py-2.5 text-left rounded-lg hover:bg-muted/10 transition-colors duration-150"
                    >
                      <div className="size-7 rounded-lg bg-muted/20 flex items-center justify-center shrink-0">
                        <HugeiconsIcon icon={icon} size={14} className={iconColor} />
                      </div>
                      <p className="flex-1 min-w-0 text-sm text-muted-foreground leading-snug line-clamp-2">
                        <InlineMarkdown text={text} />
                        {item.kind === "audit" && !item.data.approved && (
                          <span className="text-xs text-status-critical/70 ml-1.5">blocked</span>
                        )}
                      </p>
                      <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
                        {relativeTime(item.ts)}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}

            {!timelineExpanded && deduped.length > timelineLimit && (
              <button
                type="button"
                onClick={onExpandTimeline}
                className="w-full pt-4 pb-2 text-xs text-dim-foreground hover:text-muted-foreground transition-colors duration-150"
              >
                Show {deduped.length - timelineLimit} earlier
              </button>
            )}
          </>
        )}
      </div>
    </Widget>
  );
}
