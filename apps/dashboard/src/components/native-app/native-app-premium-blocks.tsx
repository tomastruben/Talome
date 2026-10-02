"use client";

import { useState } from "react";
import type {
  TalomeActivityListBlock,
  TalomeAppAction,
  TalomeComparisonBarsBlock,
} from "@talome/types";
import {
  AiMagicIcon,
  Delete01Icon,
  HugeiconsIcon,
  MoreVerticalIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SearchField } from "@/components/ui/search-field";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { asRows, formatNativeValue, getValueAtPath } from "./native-app-values";
import { resolveBudgetCategoryIcon, resolveNativeAppIcon } from "./native-app-icons";

export type NativeAppActionHandler = (
  action: TalomeAppAction,
  values?: Record<string, string | number | boolean>,
) => void;

function blockData(data: Record<string, unknown>, dataSource: string) {
  return data[dataSource];
}

function findAction(actions: TalomeAppAction[], id?: string) {
  return id ? actions.find((action) => action.id === id) : undefined;
}

function money(value: unknown, currency?: string) {
  return formatNativeValue(value, "currency", currency);
}

export function ComparisonBarsBlock({
  block,
  data,
  actions,
  pendingActionId,
  onAction,
}: {
  block: TalomeComparisonBarsBlock;
  data: Record<string, unknown>;
  actions: TalomeAppAction[];
  pendingActionId?: string;
  onAction: NativeAppActionHandler;
}) {
  const source = blockData(data, block.dataSource);
  const rows = asRows(block.rowsPath ? getValueAtPath(source, block.rowsPath) : source)
    .slice(0, block.limit ?? 20);
  const action = findAction(actions, block.actionId);
  const totals = [
    ["Planned", block.plannedTotalPath],
    ["Spent", block.actualTotalPath],
    ["Remaining", block.remainingTotalPath],
  ] as const;

  return (
    <Card className="h-full min-w-0 overflow-hidden rounded-xl @container/comparison">
      <CardHeader>
        <CardTitle>{block.title}</CardTitle>
        {block.description ? <CardDescription>{block.description}</CardDescription> : null}
        {action ? (
          <CardAction>
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(pendingActionId)}
              onClick={() => onAction(action)}
            >
              <HugeiconsIcon icon={AiMagicIcon} size={16} data-icon="inline-start" />
              {pendingActionId === action.id ? "Working…" : action.label}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>

      {!block.compact && totals.some(([, path]) => path) ? (
        <div className="grid grid-cols-1 border-y @lg/comparison:grid-cols-3">
          {totals.map(([label, path], index) => path ? (
            <div key={label} className={cn("px-6 py-4", index && "border-t @lg/comparison:border-l @lg/comparison:border-t-0")}>
              <p className="text-lg font-medium tabular-nums">{money(getValueAtPath(source, path), block.currency)}</p>
              <p className="text-sm text-muted-foreground">{label.toLowerCase()}</p>
            </div>
          ) : null)}
        </div>
      ) : null}

      <CardContent className={cn("flex flex-col", !block.compact && "pt-2")}>
        {!block.compact ? (
          <div className="hidden grid-cols-[minmax(7rem,1fr)_minmax(7rem,.7fr)_minmax(13rem,2fr)_minmax(8rem,.8fr)] gap-5 border-b py-3 text-sm font-medium text-muted-foreground @2xl/comparison:grid">
            <span>Category</span>
            <span>Planned</span>
            <span>Spent</span>
            <span className="text-right">Remaining</span>
          </div>
        ) : null}

        {rows.length ? rows.map((row, index) => {
          const label = formatNativeValue(getValueAtPath(row, block.labelPath));
          const planned = Number(getValueAtPath(row, block.plannedPath)) || 0;
          const actual = Number(getValueAtPath(row, block.actualPath)) || 0;
          const remaining = block.remainingPath ? getValueAtPath(row, block.remainingPath) : planned - actual;
          const status = block.statusPath ? String(getValueAtPath(row, block.statusPath) ?? "") : "";
          const percentage = planned > 0 ? Math.min(100, Math.max(0, actual / planned * 100)) : actual > 0 ? 100 : 0;
          const isCritical = status.toLowerCase().includes("over") || status.toLowerCase().includes("unbudgeted");
          const categoryIcon = resolveBudgetCategoryIcon(label);

          if (block.compact) {
            return (
              <div key={`${label}-${index}`} className="flex flex-col gap-2 border-b py-3 last:border-b-0">
                <div className="flex items-center justify-between gap-4 text-sm">
                  <span className="flex min-w-0 items-center gap-3 font-medium">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-muted/60">
                      <HugeiconsIcon icon={categoryIcon} size={23} className="text-muted-foreground" />
                    </span>
                    <span className="truncate">{label}</span>
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {money(actual, block.currency)} / {money(planned, block.currency)}
                  </span>
                </div>
                <Progress
                  value={percentage}
                  className="h-1.5"
                  aria-label={`${label}: ${Math.round(percentage)}% used`}
                />
              </div>
            );
          }

          return (
            <div
              key={`${label}-${index}`}
              className="grid grid-cols-1 gap-2 border-b py-4 last:border-b-0 @2xl/comparison:grid-cols-[minmax(7rem,1fr)_minmax(7rem,.7fr)_minmax(13rem,2fr)_minmax(8rem,.8fr)] @2xl/comparison:items-center @2xl/comparison:gap-5"
            >
              <span className="flex min-w-0 items-center gap-3 text-sm font-medium">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-muted/60">
                  <HugeiconsIcon icon={categoryIcon} size={23} className="text-muted-foreground" />
                </span>
                <span className="truncate">{label}</span>
              </span>
              <span className="text-sm tabular-nums text-muted-foreground">{money(planned, block.currency)}</span>
              <div className="flex min-w-0 items-center gap-4">
                <Progress
                  value={percentage}
                  className="min-w-20 flex-1"
                  aria-label={`${label}: ${Math.round(percentage)}% used`}
                />
                <span className="w-24 text-right text-sm tabular-nums">{money(actual, block.currency)}</span>
              </div>
              <span className={cn("text-sm tabular-nums @2xl/comparison:text-right", isCritical && "text-status-critical")}>
                {money(remaining, block.currency)}
              </span>
            </div>
          );
        }) : <p className="py-6 text-sm text-muted-foreground">No category budgets yet.</p>}
      </CardContent>
    </Card>
  );
}

export function ActivityListBlock({
  block,
  data,
  actions,
  pendingActionId,
  onAction,
}: {
  block: TalomeActivityListBlock;
  data: Record<string, unknown>;
  actions: TalomeAppAction[];
  pendingActionId?: string;
  onAction: NativeAppActionHandler;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const itemLabel = block.valueFormat === "currency" ? "transactions" : block.title.toLowerCase();
  const source = blockData(data, block.dataSource);
  const allRows = asRows(block.rowsPath ? getValueAtPath(source, block.rowsPath) : source);
  const rows = allRows.filter((row) => {
    const matchesQuery = !query.trim() || (block.searchPaths ?? [block.titlePath, block.descriptionPath].filter(Boolean) as string[])
      .some((path) => String(getValueAtPath(row, path) ?? "").toLowerCase().includes(query.trim().toLowerCase()));
    const matchesFilter = filter === "all" || !block.filterPath || String(getValueAtPath(row, block.filterPath)) === filter;
    return matchesQuery && matchesFilter;
  }).slice(0, block.limit ?? 100);
  const footerAction = findAction(actions, block.footerActionId);
  const rowAction = findAction(actions, block.rowAction?.actionId);
  const hasStarterData = block.starterFlagPath
    ? Boolean(getValueAtPath(source, block.starterFlagPath))
    : false;

  return (
    <Card className="h-full min-w-0 overflow-hidden rounded-xl @container/activity">
      <CardHeader className={cn(!block.compact && "gap-4 @4xl/activity:grid-cols-[minmax(0,1fr)_auto]")}>
        <div className="min-w-0">
          <CardTitle>{block.title}</CardTitle>
          {block.description ? <CardDescription className="mt-2">{block.description}</CardDescription> : null}
        </div>
        {!block.compact && (block.searchPaths?.length || block.filters?.length) ? (
          <div className="flex flex-col gap-2 @4xl/activity:flex-row @4xl/activity:items-center">
            {block.searchPaths?.length ? (
              <SearchField
                type="search"
                aria-label={`Search ${itemLabel}`}
                placeholder={`Search ${itemLabel}`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                containerClassName="w-full @4xl/activity:w-72"
              />
            ) : null}
            {block.filters?.length ? (
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={filter}
                onValueChange={(value) => setFilter(value || "all")}
                aria-label={`Filter ${itemLabel}`}
                className="max-w-full overflow-x-auto"
              >
                <ToggleGroupItem value="all">All</ToggleGroupItem>
                {block.filters.map((item) => (
                  <ToggleGroupItem key={item.value} value={item.value}>{item.label}</ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : null}
          </div>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-col">
        {rows.length ? rows.map((row, index) => {
          const title = formatNativeValue(getValueAtPath(row, block.titlePath));
          const description = block.descriptionPath ? formatNativeValue(getValueAtPath(row, block.descriptionPath)) : "";
          const date = formatNativeValue(getValueAtPath(row, block.datePath), "date");
          const kind = block.kindPath ? formatNativeValue(getValueAtPath(row, block.kindPath)) : "";
          const value = getValueAtPath(row, block.valuePath);
          const actionValue = block.rowAction ? getValueAtPath(row, block.rowAction.valuePath) : undefined;
          const categoryIcon = block.valueFormat === "currency"
            ? resolveBudgetCategoryIcon(kind.toLowerCase() === "income" ? "Income" : description)
            : resolveNativeAppIcon(block.icon);

          return (
            <div key={`${title}-${date}-${index}`}>
              {index ? <Separator /> : null}
              <div className={cn(
                "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-3",
                !block.compact && "@3xl/activity:grid-cols-[7rem_minmax(10rem,1.4fr)_minmax(7rem,1fr)_6rem_minmax(8rem,.9fr)]",
              )}>
                {!block.compact ? <span className="hidden text-sm text-muted-foreground @3xl/activity:block">{date}</span> : null}
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-muted/60">
                    <HugeiconsIcon
                      icon={categoryIcon}
                      size={23}
                      className={kind.toLowerCase() === "income" ? "text-status-healthy" : "text-muted-foreground"}
                    />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{title}</p>
                    <p className={cn("truncate text-sm text-muted-foreground", !block.compact && "@3xl/activity:hidden")}>
                      {[date, description].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                </div>
                {!block.compact ? <span className="hidden truncate text-sm text-muted-foreground @3xl/activity:block">{description}</span> : null}
                {!block.compact ? <span className="hidden text-sm text-muted-foreground @3xl/activity:block">{kind}</span> : null}
                <div className="flex items-center justify-end gap-2">
                  <span className="text-right text-sm font-medium tabular-nums">
                    {formatNativeValue(value, block.valueFormat, block.currency)}
                  </span>
                  {!block.compact && rowAction && block.rowAction && actionValue !== undefined ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${title}`}>
                          <HugeiconsIcon icon={MoreVerticalIcon} size={16} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuGroup>
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => onAction(rowAction, { [block.rowAction!.inputId]: String(actionValue) })}
                          >
                            <HugeiconsIcon icon={Delete01Icon} size={16} />
                            {rowAction.label}
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
              </div>
            </div>
          );
        }) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {query || filter !== "all" ? `No ${itemLabel} match these filters.` : `No ${itemLabel} yet.`}
          </p>
        )}
      </CardContent>

      {!block.compact && footerAction && hasStarterData ? (
        <CardFooter className="justify-between gap-4 border-t py-4">
          <p className="text-sm text-muted-foreground">These starter entries help you explore Budget Compass.</p>
          <Button
            variant="ghost"
            size="sm"
            disabled={Boolean(pendingActionId)}
            onClick={() => onAction(footerAction)}
          >
            {pendingActionId === footerAction.id ? "Working…" : footerAction.label}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
