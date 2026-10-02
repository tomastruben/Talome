"use client";

import { useMemo } from "react";
import type { TalomeAppAction, TalomeBudgetOverviewBlock } from "@talome/types";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  PolarAngleAxis,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import {
  EvilRadialChart,
  RadialBar,
} from "@/components/evilcharts/charts/radial-chart";
import {
  EvilSankeyChart,
  Link,
  Node,
  NodeLabel,
  Tooltip as SankeyTooltip,
} from "@/components/evilcharts/charts/sankey-chart";
import type { ChartConfig as EvilChartConfig } from "@/components/evilcharts/ui/chart";
import {
  AiMagicIcon,
  ArrowRight01Icon,
  ChartLineData01Icon,
  HugeiconsIcon,
  Target01Icon,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
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
import { cn } from "@/lib/utils";
import { asRows, formatNativeValue, getValueAtPath } from "./native-app-values";
import { resolveBudgetCategoryIcon } from "./native-app-icons";
import type { NativeAppActionHandler } from "./native-app-premium-blocks";

interface BudgetCategory {
  category: string;
  budget: number;
  spent: number;
  remaining: number;
  usage: number;
  status: string;
}

interface BudgetTransaction {
  id: string;
  date: string;
  dateLabel: string;
  description: string;
  category: string;
  kind: string;
  amount: number;
}

interface SpendingPacePoint {
  date: string;
  dateLabel: string;
  day: number;
  actual: number | null;
  plan: number;
  projected: number | null;
}

function sourceRecord(data: Record<string, unknown>, dataSource: string) {
  const value = data[dataSource];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberValue(source: Record<string, unknown>, path: string) {
  const value = Number(getValueAtPath(source, path));
  return Number.isFinite(value) ? value : 0;
}

function stringValue(source: Record<string, unknown>, path: string, fallback = "") {
  const value = getValueAtPath(source, path);
  return value === null || value === undefined ? fallback : String(value);
}

function money(value: unknown, currency: string) {
  return formatNativeValue(value, "currency", currency);
}

function findAction(actions: TalomeAppAction[], id?: string) {
  return id ? actions.find((action) => action.id === id) : undefined;
}

function normalizeCategories(source: Record<string, unknown>): BudgetCategory[] {
  return asRows(getValueAtPath(source, "categoryBudgets")).map((row) => ({
    category: stringValue(row, "category", "Other"),
    budget: numberValue(row, "budget"),
    spent: numberValue(row, "spent"),
    remaining: numberValue(row, "remaining"),
    usage: numberValue(row, "usage"),
    status: stringValue(row, "status", "On track"),
  }));
}

function normalizeTransactions(source: Record<string, unknown>): BudgetTransaction[] {
  return asRows(getValueAtPath(source, "recentTransactions")).map((row) => ({
    id: stringValue(row, "id"),
    date: stringValue(row, "date"),
    dateLabel: stringValue(row, "dateLabel"),
    description: stringValue(row, "description", "Transaction"),
    category: stringValue(row, "category", "Other"),
    kind: stringValue(row, "kind", "expense"),
    amount: numberValue(row, "amount"),
  }));
}

function normalizePace(source: Record<string, unknown>): SpendingPacePoint[] {
  return asRows(getValueAtPath(source, "spendingPace")).map((row) => ({
    date: stringValue(row, "date"),
    dateLabel: stringValue(row, "dateLabel"),
    day: numberValue(row, "day"),
    actual: getValueAtPath(row, "actual") === null ? null : numberValue(row, "actual"),
    plan: numberValue(row, "plan"),
    projected: getValueAtPath(row, "projected") === null ? null : numberValue(row, "projected"),
  }));
}

const PACE_CONFIG = {
  actual: { label: "Actual", color: "var(--status-healthy)" },
  plan: { label: "Plan", color: "var(--muted-foreground)" },
  projected: { label: "Projected", color: "var(--status-warning)" },
} satisfies ChartConfig;

function LeftInPlanCard({
  source,
  currency,
}: {
  source: Record<string, unknown>;
  currency: string;
}) {
  const remaining = numberValue(source, "budgetRemaining");
  const used = Math.max(0, Math.min(numberValue(source, "budgetUsage"), 100));
  const dailyRoom = numberValue(source, "dailyPlanRemaining");
  const spent = numberValue(source, "spent");
  const budget = numberValue(source, "budget");
  const daysRemaining = numberValue(source, "daysRemaining");
  const monthLabel = stringValue(source, "monthLabel", "This month");
  const paceLabel = stringValue(source, "paceLabel", "Waiting for spending data");
  const radialConfig = {
    budgetUsed: {
      label: "Budget used",
      colors: {
        light: ["var(--status-healthy)"],
        dark: ["var(--status-healthy)"],
      },
    },
  } satisfies EvilChartConfig;

  return (
    <Card className="min-h-[15rem] gap-3 @container/budget-card overflow-hidden bg-card/80 py-4">
      <CardHeader>
        <div className="flex items-center gap-2 text-muted-foreground">
          <HugeiconsIcon icon={Target01Icon} size={18} />
          <CardTitle>Left in your plan</CardTitle>
        </div>
        <CardDescription>{monthLabel} · after recorded spending</CardDescription>
        <CardAction>
          <Badge variant="outline" className="border-status-healthy/30 text-status-healthy">
            {paceLabel}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="grid min-w-0 items-center gap-4 @md/budget-card:grid-cols-[minmax(0,1fr)_10rem]">
        <div className="min-w-0 text-center @md/budget-card:text-left">
          <p className="text-xs font-medium text-muted-foreground">Available to spend</p>
          <p className="mt-1 text-2xl font-medium tabular-nums tracking-tight">
            {money(remaining, currency)}
          </p>
          <p className="mt-3 text-sm">
            <span className="font-medium tabular-nums">{money(dailyRoom, currency)}/day</span>
            <span className="text-muted-foreground"> for {daysRemaining} more days</span>
          </p>
          <div className="mt-5 grid grid-cols-2 gap-4 border-t pt-3">
            <div>
              <p className="text-xs text-muted-foreground">Spent</p>
              <p className="mt-1 text-sm font-medium tabular-nums">{money(spent, currency)}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Plan</p>
              <p className="mt-1 text-sm font-medium tabular-nums">{money(budget, currency)}</p>
            </div>
          </div>
        </div>
        <div className="relative size-40 shrink-0 justify-self-center" role="img" aria-label={`Budget used: ${used.toFixed(1)}%`}>
          <EvilRadialChart
            config={radialConfig}
            data={[{ name: "budgetUsed", value: used }]}
            nameKey="name"
            innerRadius="73%"
            outerRadius="100%"
            className="h-full aspect-square"
            chartProps={{ startAngle: 210, endAngle: -30, cy: "54%" }}
          >
            <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
            <RadialBar dataKey="value" barSize={18} cornerRadius={12} showBackground />
          </EvilRadialChart>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-2xl font-medium tabular-nums tracking-tight">{used.toFixed(1)}%</span>
            <span className="mt-1 text-xs text-muted-foreground">plan used</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MoneyFlowCard({
  categories,
  source,
  currency,
}: {
  categories: BudgetCategory[];
  source: Record<string, unknown>;
  currency: string;
}) {
  const income = numberValue(source, "income");
  const retained = Math.max(numberValue(source, "available"), 0);
  const activeCategories = categories
    .filter((category) => category.spent > 0)
    .sort((left, right) => right.spent - left.spent)
    .slice(0, 5);
  const coveredSpend = activeCategories.reduce((sum, category) => sum + category.spent, 0);
  const totalSpent = numberValue(source, "spent");
  const otherSpend = Math.max(totalSpent - coveredSpend, 0);
  const flowTargets = [
    ...activeCategories.map((category) => ({ name: category.category, value: category.spent })),
    ...(otherSpend > 0 ? [{ name: "Other", value: otherSpend }] : []),
    ...(retained > 0 ? [{ name: "Retained", value: retained }] : []),
  ];
  const nodes = [{ name: "Income" }, ...flowTargets.map((target) => ({ name: target.name }))];
  const links = flowTargets.map((target, index) => ({ source: 0, target: index + 1, value: target.value }));
  const config = Object.fromEntries(nodes.map((node) => [
    node.name,
    {
      label: node.name,
      colors: {
        light: [node.name === "Retained" || node.name === "Income" ? "var(--status-healthy)" : "var(--status-warning)"],
        dark: [node.name === "Retained" || node.name === "Income" ? "var(--status-healthy)" : "var(--status-warning)"],
      },
    },
  ])) as EvilChartConfig;

  return (
    <Card className="min-h-[15rem] gap-3 @container/budget-card overflow-hidden bg-card/80 py-4">
      <CardHeader>
        <CardTitle>Money flow</CardTitle>
        <CardDescription>Where recorded income moved this month</CardDescription>
        <CardAction>
          <Badge variant="secondary">{money(income, currency)} in</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {links.length ? (
          <>
            <div className="hidden h-44 @lg/budget-card:block" role="application" aria-label="Monthly money flow chart">
              <EvilSankeyChart
                data={{ nodes, links }}
                config={config}
                className="h-44 aspect-auto"
                nodeWidth={12}
                nodePadding={16}
                linkCurvature={0.62}
                sankeyProps={{ margin: { top: 14, right: 88, bottom: 14, left: 64 } }}
              >
                <Node radius={6} glow={["Retained"]}>
                  <NodeLabel />
                </Node>
                <Link variant="gradient" verticalPadding={1} />
                <SankeyTooltip variant="frosted-glass" roundness="lg" />
              </EvilSankeyChart>
            </div>
            <div className="flex flex-col gap-4 @lg/budget-card:hidden">
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-lg border bg-muted/50 p-4">
                <div>
                  <p className="text-xs text-muted-foreground">Income</p>
                  <p className="mt-1 font-medium tabular-nums">{money(income, currency)}</p>
                </div>
                <HugeiconsIcon icon={ArrowRight01Icon} size={18} className="text-muted-foreground" />
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Retained</p>
                  <p className="mt-1 font-medium tabular-nums text-status-healthy">{money(retained, currency)}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {flowTargets.filter((target) => target.name !== "Retained").map((target) => (
                  <Badge key={target.name} variant="outline">
                    {target.name} · {money(target.value, currency)}
                  </Badge>
                ))}
              </div>
            </div>
          </>
        ) : <p className="py-20 text-center text-sm text-muted-foreground">Add a transaction to reveal your money flow.</p>}
      </CardContent>
    </Card>
  );
}

function SpendingPaceCard({
  source,
  pace,
  currency,
}: {
  source: Record<string, unknown>;
  pace: SpendingPacePoint[];
  currency: string;
}) {
  const today = numberValue(source, "daysElapsed");
  const projected = numberValue(source, "projectedSpend");
  const budget = numberValue(source, "budget");
  const paceDelta = numberValue(source, "paceDelta");

  return (
    <Card className="gap-4 @container/budget-card overflow-hidden bg-card/80 py-4">
      <CardHeader>
        <div className="flex items-center gap-2">
          <HugeiconsIcon icon={ChartLineData01Icon} size={18} className="text-muted-foreground" />
          <CardTitle>Spending pace</CardTitle>
        </div>
        <CardDescription>Actual spending, your monthly plan, and a clearly marked estimate</CardDescription>
        <CardAction>
          <Badge variant="outline" className={cn(
            paceDelta >= 0 ? "border-status-healthy/30 text-status-healthy" : "border-status-warning/30 text-status-warning",
          )}>
            {paceDelta >= 0 ? "Under pace" : "Ahead of pace"}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={PACE_CONFIG}
          className="h-[10rem] w-full aspect-auto"
          role="application"
          aria-label="Spending pace chart"
        >
          <AreaChart data={pace} margin={{ left: 4, right: 8, top: 12, bottom: 0 }}>
            <defs>
              <linearGradient id="budget-actual-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-actual)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--color-actual)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 5" />
            <XAxis
              dataKey="day"
              tickLine={false}
              axisLine={false}
              minTickGap={24}
              tickFormatter={(value) => String(value).padStart(2, "0")}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(value) => value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(value)}
            />
            <ChartTooltip
              content={<ChartTooltipContent formatter={(value, name) => (
                <div className="flex min-w-36 items-center justify-between gap-4">
                  <span className="text-muted-foreground">{(PACE_CONFIG as ChartConfig)[String(name)]?.label ?? String(name)}</span>
                  <span className="font-medium tabular-nums">{money(value, currency)}</span>
                </div>
              )} />}
            />
            {today ? <ReferenceLine x={today} stroke="var(--border)" strokeDasharray="3 4" label={{ value: "Today", fill: "var(--muted-foreground)", fontSize: 11 }} /> : null}
            <Area
              type="monotone"
              dataKey="actual"
              stroke="var(--color-actual)"
              fill="url(#budget-actual-fill)"
              strokeWidth={2.5}
              connectNulls={false}
            />
            <Line
              type="monotone"
              dataKey="plan"
              stroke="var(--color-plan)"
              strokeWidth={1.5}
              strokeDasharray="5 5"
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="projected"
              stroke="var(--color-projected)"
              strokeWidth={2}
              strokeDasharray="4 5"
              dot={false}
              connectNulls={false}
            />
          </AreaChart>
        </ChartContainer>
        <Separator className="my-3" />
        <div className="grid gap-4 @lg/budget-card:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">Actual</p>
            <p className="mt-1 font-medium tabular-nums">{money(numberValue(source, "spent"), currency)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Full-month plan</p>
            <p className="mt-1 font-medium tabular-nums">{money(budget, currency)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Projected estimate</p>
            <p className="mt-1 font-medium tabular-nums text-status-warning">{money(projected, currency)}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CategoriesCard({ categories, currency }: { categories: BudgetCategory[]; currency: string }) {
  const prioritized = [...categories]
    .sort((left, right) => right.usage - left.usage)
    .slice(0, 6);

  return (
    <Card className="overflow-hidden bg-card/80">
      <CardHeader>
        <CardTitle>Categories</CardTitle>
        <CardDescription>Most important plans first</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col">
        {prioritized.map((category, index) => {
          const icon = resolveBudgetCategoryIcon(category.category);
          const tone = category.usage >= 100 ? "text-status-warning" : "text-foreground";
          return (
            <div key={category.category}>
              {index ? <Separator /> : null}
              <div className="flex items-center gap-3 py-2">
                <div className={cn(
                  "flex size-11 shrink-0 items-center justify-center rounded-xl border bg-muted/60",
                  category.usage >= 100 && "border-status-warning/30 bg-status-warning/10",
                )}>
                  <HugeiconsIcon icon={icon} size={25} className={tone} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate text-sm font-medium">{category.category}</p>
                    <p className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {money(category.spent, currency)} / {money(category.budget, currency)}
                    </p>
                  </div>
                  <Progress
                    value={Math.min(Math.max(category.usage, 0), 100)}
                    className={cn("mt-2 h-1.5", category.usage >= 100 && "[&_[data-slot=progress-indicator]]:bg-status-warning")}
                    aria-label={`${category.category}: ${Math.round(category.usage)}% used`}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function RecentTransactionsCard({
  transactions,
  currency,
}: {
  transactions: BudgetTransaction[];
  currency: string;
}) {
  return (
    <Card className="overflow-hidden bg-card/80">
      <CardHeader>
        <CardTitle>Recent transactions</CardTitle>
        <CardDescription>Your latest recorded activity</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col">
        {transactions.slice(0, 6).map((transaction, index) => {
          const icon = resolveBudgetCategoryIcon(transaction.kind === "income" ? "Income" : transaction.category);
          return (
            <div key={transaction.id || `${transaction.description}-${index}`}>
              {index ? <Separator /> : null}
              <div className="flex items-center gap-3 py-2">
                <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border bg-muted/60">
                  <HugeiconsIcon icon={icon} size={24} className={transaction.kind === "income" ? "text-status-healthy" : "text-muted-foreground"} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{transaction.description}</p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {transaction.dateLabel || formatNativeValue(transaction.date, "date")} · {transaction.category}
                  </p>
                </div>
                <p className={cn(
                  "shrink-0 text-sm font-medium tabular-nums",
                  transaction.kind === "income" && "text-status-healthy",
                )}>
                  {money(transaction.amount, currency)}
                </p>
              </div>
            </div>
          );
        })}
        {!transactions.length ? <p className="py-8 text-center text-sm text-muted-foreground">No transactions yet.</p> : null}
      </CardContent>
    </Card>
  );
}

function InsightCard({
  source,
  action,
  pendingActionId,
  onAction,
}: {
  source: Record<string, unknown>;
  action?: TalomeAppAction;
  pendingActionId?: string;
  onAction: NativeAppActionHandler;
}) {
  const title = stringValue(source, "insight.title", "Your plan is ready for review");
  const body = stringValue(source, "insight.body", "Talome can review this month using only your recorded data.");
  const tone = stringValue(source, "insight.tone", "healthy");

  return (
    <Card className={cn(
      "@container/budget-card gap-3 overflow-hidden border-status-healthy/25 bg-status-healthy/5 py-4",
      tone === "watch" && "border-status-warning/30 bg-status-warning/5",
    )}>
      <CardContent className="flex flex-col gap-3 pt-0 @2xl/budget-card:flex-row @2xl/budget-card:items-center @2xl/budget-card:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <div className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-xl border border-status-healthy/25 bg-status-healthy/10",
            tone === "watch" && "border-status-warning/30 bg-status-warning/10",
          )}>
            <HugeiconsIcon icon={AiMagicIcon} size={27} className={tone === "watch" ? "text-status-warning" : "text-status-healthy"} />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Talome noticed</p>
            <h2 className="mt-1 text-lg font-medium">{title}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{body}</p>
          </div>
        </div>
        {action ? (
          <Button className="shrink-0" disabled={Boolean(pendingActionId)} onClick={() => onAction(action)}>
            <HugeiconsIcon icon={AiMagicIcon} size={16} data-icon="inline-start" />
            {pendingActionId === action.id ? "Working…" : action.label}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function BudgetOverviewBlock({
  block,
  data,
  actions,
  pendingActionId,
  onAction,
}: {
  block: TalomeBudgetOverviewBlock;
  data: Record<string, unknown>;
  actions: TalomeAppAction[];
  pendingActionId?: string;
  onAction: NativeAppActionHandler;
}) {
  const source = sourceRecord(data, block.dataSource);
  const currency = block.currency || stringValue(source, "currency", "CHF");
  const categories = useMemo(() => normalizeCategories(source), [source]);
  const transactions = useMemo(() => normalizeTransactions(source), [source]);
  const pace = useMemo(() => normalizePace(source), [source]);
  const reviewAction = findAction(actions, block.reviewActionId);

  return (
    <section aria-label={block.title} className="grid min-w-0 gap-4 @5xl/block:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="@container/budget-main flex min-w-0 flex-col gap-4">
        <div className="grid min-w-0 gap-4 @3xl/budget-main:grid-cols-[minmax(20rem,0.85fr)_minmax(27rem,1.15fr)]">
          <LeftInPlanCard source={source} currency={currency} />
          <MoneyFlowCard categories={categories} source={source} currency={currency} />
        </div>
        <SpendingPaceCard source={source} pace={pace} currency={currency} />
        <InsightCard
          source={source}
          action={reviewAction}
          pendingActionId={pendingActionId}
          onAction={onAction}
        />
      </div>
      <aside className=" flex min-w-0 flex-col gap-4">
        <CategoriesCard categories={categories} currency={currency} />
        <RecentTransactionsCard transactions={transactions} currency={currency} />
      </aside>
    </section>
  );
}
