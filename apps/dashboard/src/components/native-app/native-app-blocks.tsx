"use client";

import { useMemo } from "react";
import type {
  TalomeActivityListBlock,
  TalomeActionsBlock,
  TalomeAppAction,
  TalomeAppBlock,
  TalomeBudgetOverviewBlock,
  TalomeComparisonBarsBlock,
  TalomeListBlock,
  TalomeMarkdownBlock,
  TalomeProgressBlock,
  TalomeStatBlock,
  TalomeTableBlock,
  TalomeTimeSeriesBlock,
} from "@talome/types";
import { CartesianGrid, Line, LineChart, XAxis } from "recharts";
import { HugeiconsIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
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
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InlineMarkdown } from "@/components/ui/inline-markdown";
import { cn } from "@/lib/utils";
import { asRows, formatNativeValue, getValueAtPath } from "./native-app-values";
import { resolveNativeAppIcon } from "./native-app-icons";
import { EvilAreaChart } from "@/components/evilcharts/charts/area-chart";
import {
  ActivityListBlock,
  ComparisonBarsBlock,
  type NativeAppActionHandler,
} from "./native-app-premium-blocks";
import { BudgetOverviewBlock } from "./budget-overview-block";

const CHART_COLORS = [
  "var(--foreground)",
  "var(--muted-foreground)",
  "var(--primary)",
];

function blockData(
  data: Record<string, unknown>,
  block: { dataSource: string },
) {
  return data[block.dataSource];
}

function statusVariant(value: unknown): "default" | "secondary" | "destructive" | "outline" {
  const normalized = String(value ?? "").toLowerCase();
  if (["error", "failed", "critical", "stopped", "offline"].includes(normalized)) return "destructive";
  if (["running", "healthy", "active", "completed", "online"].includes(normalized)) return "default";
  return normalized ? "secondary" : "outline";
}

function StatBlock({ block, data }: { block: TalomeStatBlock; data: Record<string, unknown> }) {
  const source = blockData(data, block);
  const value = getValueAtPath(source, block.valuePath);
  const detail = block.detailPath ? getValueAtPath(source, block.detailPath) : undefined;
  const progressValue = block.progressValuePath ? Number(getValueAtPath(source, block.progressValuePath)) : undefined;
  const progressMax = block.progressMaxPath ? Number(getValueAtPath(source, block.progressMaxPath)) : undefined;
  const progressPercentage = progressValue !== undefined && progressMax !== undefined && progressMax > 0
    ? Math.max(0, Math.min(100, progressValue / progressMax * 100))
    : undefined;
  const progressDetail = block.progressDetailPath ? getValueAtPath(source, block.progressDetailPath) : undefined;
  const isHero = block.emphasis === "hero";
  const icon = resolveNativeAppIcon(block.icon);
  return (
    <Card className={cn("relative h-full overflow-hidden rounded-lg", isHero && "min-h-52")}>
      <CardHeader>
        <div className="flex items-center gap-2">
          {block.icon ? <HugeiconsIcon icon={icon} size={16} className="text-muted-foreground" /> : null}
          <CardTitle>{block.title}</CardTitle>
        </div>
        {block.description ? <CardDescription>{block.description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="relative">
        <p className="text-2xl font-medium tabular-nums tracking-tight">
          {formatNativeValue(value, block.format, block.currency)}
        </p>
        {detail !== undefined ? (
          <p className="mt-3 text-sm text-muted-foreground">{formatNativeValue(detail)}</p>
        ) : null}
      </CardContent>
      {progressPercentage !== undefined ? (
        <CardFooter className="mt-auto flex-col items-stretch gap-2">
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="text-muted-foreground">Budget used</span>
            <span className="font-medium tabular-nums">{Math.round(progressPercentage)}%</span>
          </div>
          <Progress value={progressPercentage} aria-label={`Budget used: ${Math.round(progressPercentage)}%`} />
          {progressDetail !== undefined ? (
            <p className="text-sm text-muted-foreground">{formatNativeValue(progressDetail)}</p>
          ) : null}
        </CardFooter>
      ) : null}
    </Card>
  );
}

function ListBlock({ block, data }: { block: TalomeListBlock; data: Record<string, unknown> }) {
  const source = blockData(data, block);
  const rows = asRows(block.itemsPath ? getValueAtPath(source, block.itemsPath) : source)
    .slice(0, block.limit ?? 20);
  return (
    <Card className="h-full rounded-lg">
      <CardHeader>
        <CardTitle>{block.title}</CardTitle>
        {block.description ? <CardDescription>{block.description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {rows.length ? rows.map((row, index) => {
          const title = getValueAtPath(row, block.titlePath);
          const description = block.descriptionPath ? getValueAtPath(row, block.descriptionPath) : undefined;
          const meta = block.metaPath ? getValueAtPath(row, block.metaPath) : undefined;
          const status = block.statusPath ? getValueAtPath(row, block.statusPath) : undefined;
          return (
            <div key={`${String(title)}-${index}`} className="flex flex-col gap-3">
              {index ? <Separator /> : null}
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{formatNativeValue(title)}</p>
                  {description !== undefined ? (
                    <p className="line-clamp-2 text-sm text-muted-foreground">{formatNativeValue(description)}</p>
                  ) : null}
                </div>
                {status !== undefined ? <Badge variant={statusVariant(status)}>{formatNativeValue(status)}</Badge> : null}
              </div>
              {meta !== undefined ? <p className="text-sm text-muted-foreground">{formatNativeValue(meta)}</p> : null}
            </div>
          );
        }) : (
          <p className="text-sm text-muted-foreground">No items yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

function TableBlock({ block, data }: { block: TalomeTableBlock; data: Record<string, unknown> }) {
  const source = blockData(data, block);
  const rows = asRows(block.rowsPath ? getValueAtPath(source, block.rowsPath) : source)
    .slice(0, block.limit ?? 50);
  return (
    <Card className="h-full rounded-lg">
      <CardHeader>
        <CardTitle>{block.title}</CardTitle>
        {block.description ? <CardDescription>{block.description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              {block.columns.map((column) => <TableHead key={column.id}>{column.label}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length ? rows.map((row, index) => (
              <TableRow key={index}>
                {block.columns.map((column) => (
                  <TableCell key={column.id}>
                    {formatNativeValue(getValueAtPath(row, column.path), column.format, column.currency)}
                  </TableCell>
                ))}
              </TableRow>
            )) : (
              <TableRow>
                <TableCell colSpan={block.columns.length} className="text-center text-muted-foreground">
                  No rows yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ProgressBlock({ block, data }: { block: TalomeProgressBlock; data: Record<string, unknown> }) {
  const source = blockData(data, block);
  const rawValue = Number(getValueAtPath(source, block.valuePath));
  const rawMax = Number(block.maxPath ? getValueAtPath(source, block.maxPath) : block.max ?? 100);
  const value = Number.isFinite(rawValue) ? rawValue : 0;
  const max = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 100;
  const percentage = Math.max(0, Math.min(100, value / max * 100));
  return (
    <Card className="h-full rounded-lg">
      <CardHeader>
        <CardTitle>{block.title}</CardTitle>
        {block.description ? <CardDescription>{block.description}</CardDescription> : null}
        <CardAction><Badge variant="secondary">{Math.round(percentage)}%</Badge></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Progress value={percentage} aria-label={`${block.title}: ${Math.round(percentage)}%`} />
        <p className="text-sm text-muted-foreground">
          {formatNativeValue(value, block.valueFormat, block.currency)} of {formatNativeValue(max, block.valueFormat, block.currency)}
        </p>
      </CardContent>
    </Card>
  );
}

function TimeSeriesBlock({ block, data }: { block: TalomeTimeSeriesBlock; data: Record<string, unknown> }) {
  const source = blockData(data, block);
  const chartData = asRows(block.rowsPath ? getValueAtPath(source, block.rowsPath) : source)
    .slice(-(block.limit ?? 100))
    .map((row) => Object.fromEntries([
      ["x", formatNativeValue(getValueAtPath(row, block.xPath))],
      ...block.series.map((series) => [series.id, Number(getValueAtPath(row, series.valuePath)) || 0]),
    ]));
  const config = useMemo<ChartConfig>(() => Object.fromEntries(
    block.series.map((series, index) => [series.id, {
      label: series.label,
      color: CHART_COLORS[index % CHART_COLORS.length],
    }]),
  ), [block.series]);
  return (
    <Card className="h-full rounded-lg">
      <CardHeader>
        <CardTitle>{block.title}</CardTitle>
        {block.description ? <CardDescription>{block.description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        {chartData.length ? (
          block.variant === "area" ? (
            <EvilAreaChart
              data={chartData}
              series={block.series}
              label={block.title}
              valueFormat={block.valueFormat}
              currency={block.currency}
            />
          ) : <ChartContainer config={config} className="min-h-52 w-full">
            <LineChart
              accessibilityLayer
              aria-label={`${block.title} chart`}
              data={chartData}
              margin={{ left: 8, right: 8 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis dataKey="x" tickLine={false} axisLine={false} minTickGap={24} />
              <ChartTooltip content={<ChartTooltipContent />} />
              {block.series.map((series) => (
                <Line
                  key={series.id}
                  dataKey={series.id}
                  type="monotone"
                  stroke={`var(--color-${series.id})`}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ChartContainer>
        ) : <p className="text-sm text-muted-foreground">No history yet.</p>}
      </CardContent>
    </Card>
  );
}

function MarkdownBlock({ block, data }: { block: TalomeMarkdownBlock; data: Record<string, unknown> }) {
  const source = block.dataSource ? data[block.dataSource] : undefined;
  const content = block.content ?? (block.contentPath ? getValueAtPath(source, block.contentPath) : "");
  return (
    <Card className="h-full rounded-lg">
      <CardHeader>
        <CardTitle>{block.title}</CardTitle>
        {block.description ? <CardDescription>{block.description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
          <InlineMarkdown text={formatNativeValue(content)} />
        </p>
      </CardContent>
    </Card>
  );
}

function ActionsBlock({
  block,
  actions,
  pendingActionId,
  onAction,
}: {
  block: TalomeActionsBlock;
  actions: TalomeAppAction[];
  pendingActionId?: string;
  onAction: NativeAppActionHandler;
}) {
  const visibleActions = block.actionIds.flatMap((id) => {
    const action = actions.find((candidate) => candidate.id === id);
    return action ? [action] : [];
  });
  return (
    <Card className="h-full rounded-lg">
      <CardHeader>
        <CardTitle>{block.title}</CardTitle>
        {block.description ? <CardDescription>{block.description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {visibleActions.map((action, index) => (
          <Button
            key={action.id}
            variant={index ? "outline" : "default"}
            disabled={Boolean(pendingActionId)}
            onClick={() => onAction(action)}
          >
            {pendingActionId === action.id ? "Working…" : action.label}
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}

export function NativeAppBlockRenderer({
  block,
  data,
  actions,
  pendingActionId,
  onAction,
}: {
  block: TalomeAppBlock;
  data: Record<string, unknown>;
  actions: TalomeAppAction[];
  pendingActionId?: string;
  onAction: NativeAppActionHandler;
}) {
  switch (block.component) {
    case "stat": return <StatBlock block={block} data={data} />;
    case "list": return <ListBlock block={block} data={data} />;
    case "table": return <TableBlock block={block} data={data} />;
    case "progress": return <ProgressBlock block={block} data={data} />;
    case "time-series": return <TimeSeriesBlock block={block} data={data} />;
    case "budget-overview": return (
      <BudgetOverviewBlock
        block={block as TalomeBudgetOverviewBlock}
        data={data}
        actions={actions}
        pendingActionId={pendingActionId}
        onAction={onAction}
      />
    );
    case "comparison-bars": return (
      <ComparisonBarsBlock
        block={block as TalomeComparisonBarsBlock}
        data={data}
        actions={actions}
        pendingActionId={pendingActionId}
        onAction={onAction}
      />
    );
    case "activity-list": return (
      <ActivityListBlock
        block={block as TalomeActivityListBlock}
        data={data}
        actions={actions}
        pendingActionId={pendingActionId}
        onAction={onAction}
      />
    );
    case "markdown": return <MarkdownBlock block={block} data={data} />;
    case "actions": return (
      <ActionsBlock
        block={block}
        actions={actions}
        pendingActionId={pendingActionId}
        onAction={onAction}
      />
    );
  }
}
