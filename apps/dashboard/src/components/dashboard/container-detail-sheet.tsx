"use client";

import { useEffect, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsDot } from "@/components/ui/tabs";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { CORE_URL } from "@/lib/constants";
import type { Container, ContainerStats } from "@talome/types";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  HugeiconsIcon,
  PlayIcon,
  StopIcon,
  RefreshDotIcon,
  Share04Icon,
} from "@/components/icons";
import { useSWRConfig } from "swr";
import { toast } from "sonner";
import { useQuickLook } from "@/components/quick-look/quick-look-context";

// ── Per-container stats history ──────────────────────────────────────────────

interface ContainerHistory {
  cpu: number[];
  mem: number[];
}

function useContainerStats(containerId: string | undefined, running: boolean) {
  const [history, setHistory] = useState<ContainerHistory>({ cpu: [], mem: [] });
  const [stats, setStats] = useState<ContainerStats | null>(null);

  useEffect(() => {
    if (!containerId || !running) return;

    let alive = true;
    const HISTORY = 30;

    async function poll() {
      while (alive) {
        try {
          const res = await fetch(`${CORE_URL}/api/containers/${containerId}/stats`);
          if (res.ok) {
            const s = (await res.json()) as ContainerStats;
            if (alive) {
              setStats(s);
              setHistory((prev) => ({
                cpu: [...prev.cpu, s.cpuPercent].slice(-HISTORY),
                mem: [...prev.mem, (s.memoryUsageMb / s.memoryLimitMb) * 100].slice(-HISTORY),
              }));
            }
          }
        } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    poll();
    return () => { alive = false; };
  }, [containerId, running]);

  return { stats, history };
}

// ── Subtle mini sparkline (Jony Ive rules) ───────────────────────────────────

function MiniSparkline({ data, warn }: { data: number[]; warn?: boolean }) {
  const chartData = data.map((v) => ({ v }));
  const strokeColor = warn
    ? "hsl(38 92% 50% / 0.35)"
    : "hsl(var(--foreground) / 0.14)";

  return (
    <ResponsiveContainer width="100%" height={40}>
      <AreaChart data={chartData} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`mini-${warn ? "warn" : "ok"}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity={0.08} />
            <stop offset="100%" stopColor={strokeColor} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="v"
          stroke={strokeColor}
          strokeWidth={1}
          fill={`url(#mini-${warn ? "warn" : "ok"})`}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── Stats tab ────────────────────────────────────────────────────────────────

function StatsTab({ container }: { container: Container }) {
  const isRunning = container.status === "running";
  const { stats, history } = useContainerStats(container.id, isRunning);

  if (!isRunning) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        Container is not running
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border p-4">
            <Skeleton className="h-3 w-16 mb-2" />
            <Skeleton className="h-6 w-24" />
          </div>
        ))}
      </div>
    );
  }

  const memPct = stats.memoryLimitMb > 0
    ? Math.round((stats.memoryUsageMb / stats.memoryLimitMb) * 100)
    : 0;

  const items = [
    { label: "CPU", value: `${stats.cpuPercent.toFixed(1)}%`, history: history.cpu, warn: stats.cpuPercent >= 70 },
    { label: "Memory", value: `${stats.memoryUsageMb.toFixed(0)} MB`, sub: `${memPct}% of ${stats.memoryLimitMb.toFixed(0)} MB`, history: history.mem, warn: memPct >= 70 },
    { label: "Net in",  value: `${(stats.networkRxBytes / 1024 / 1024).toFixed(1)} MB` },
    { label: "Net out", value: `${(stats.networkTxBytes / 1024 / 1024).toFixed(1)} MB` },
  ];

  return (
    <div className="grid grid-cols-2 gap-3">
      {items.map((item) => (
        <div key={item.label} className="relative rounded-xl border overflow-hidden p-4">
          {item.history && item.history.length > 3 && (
            <div className="absolute inset-0 pointer-events-none">
              <MiniSparkline data={item.history} warn={item.warn} />
            </div>
          )}
          <p className="text-xs text-muted-foreground relative">{item.label}</p>
          <p className="text-lg font-medium tabular-nums relative">{item.value}</p>
          {item.sub && <p className="text-xs text-muted-foreground relative">{item.sub}</p>}
        </div>
      ))}
    </div>
  );
}

// ── Logs tab ─────────────────────────────────────────────────────────────────

function LogsTab({ container }: { container: Container }) {
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${CORE_URL}/api/containers/${container.id}/logs?tail=300`)
      .then((r) => r.text())
      .then((t) => { setLogs(t); setLoading(false); })
      .catch(() => { setLogs("Failed to fetch logs."); setLoading(false); });
  }, [container.id]);

  useEffect(() => {
    if (!loading) bottomRef.current?.scrollIntoView({ block: "end", behavior: "instant" });
  }, [loading]);

  if (loading) {
    return (
      <div className="space-y-1.5">
        {Array.from({ length: 12 }).map((_, i) => (
          <Skeleton key={i} className="h-3.5 w-full" style={{ opacity: 1 - i * 0.06 }} />
        ))}
      </div>
    );
  }

  return (
    <pre className="rounded-xl bg-muted/50 px-4 py-3 text-xs font-mono leading-relaxed text-muted-foreground whitespace-pre-wrap break-all overflow-hidden">
      {logs || "No logs available."}
      <div ref={bottomRef} />
    </pre>
  );
}

// ── Overview tab ──────────────────────────────────────────────────────────────

function containerKind(labels: Record<string, string>): "talome" | "compose" | "standalone" {
  if (labels["talome.managed"] === "true") return "talome";
  if (labels["com.docker.compose.project"]) return "compose";
  return "standalone";
}

function kindLabel(kind: "talome" | "compose" | "standalone"): string {
  if (kind === "talome") return "Managed by Talome";
  if (kind === "compose") return "Docker Compose";
  return "Standalone";
}

function OverviewTab({
  container,
  onOpenPreview,
}: {
  container: Container;
  onOpenPreview: () => void;
}) {
  const statusColors: Record<Container["status"], string> = {
    running:    "emerald",
    stopped:    "red",
    exited:     "red",
    restarting: "amber",
    paused:     "amber",
    created:    "muted",
  } as const;

  const kind = containerKind(container.labels);
  const composeProject = container.labels["com.docker.compose.project"];
  const rows: [string, string][] = [
    ["Image",   container.image],
    ["Created", new Date(container.created).toLocaleString()],
    ["Source",  kindLabel(kind) + (composeProject && kind === "compose" ? ` (${composeProject})` : "")],
  ];
  const tcpPorts = container.ports
    .filter((p) => p.protocol === "tcp" && p.host > 0)
    .filter((p, i, arr) => arr.findIndex((x) => x.host === p.host) === i);
  const isRunning = container.status === "running";

  return (
    <div className="rounded-xl border overflow-hidden">
      <table className="w-full text-sm">
        <tbody>
          <tr className="border-b">
            <td className="px-4 py-2.5 text-muted-foreground w-28 shrink-0">Status</td>
            <td className="px-4 py-2.5">
              <span className="inline-flex items-center gap-1.5">
                <TabsDot color={statusColors[container.status] as "emerald" | "red" | "amber" | "muted"} pulse={container.status === "running"} />
                <span className="capitalize">{container.status}</span>
              </span>
            </td>
          </tr>
          {rows.map(([key, val]) => (
            <tr key={key} className="border-b last:border-0">
              <td className="px-4 py-2.5 text-muted-foreground">{key}</td>
              <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground break-all">{val}</td>
            </tr>
          ))}
          {tcpPorts.length > 0 && (
            <tr className="border-b last:border-0">
              <td className="px-4 py-2.5 text-muted-foreground">Ports</td>
              <td className="px-4 py-2.5">
                <div className="flex flex-wrap gap-1">
                  {tcpPorts.map((p) =>
                    isRunning ? (
                      <button
                        key={p.host}
                        type="button"
                        onClick={onOpenPreview}
                        className="port-chip"
                      >
                        <HugeiconsIcon icon={Share04Icon} size={10} />
                        {p.host}
                      </button>
                    ) : (
                      <span key={p.host} className="port-chip port-chip-inactive">
                        {p.host}
                      </span>
                    )
                  )}
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Main Sheet ────────────────────────────────────────────────────────────────

interface ContainerDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container: Container | null;
  onAction?: () => void;
}

export function ContainerDetailSheet({ open, onOpenChange, container, onAction }: ContainerDetailSheetProps) {
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState("overview");
  const [actioning, setActioning] = useState(false);
  const [optimisticStatus, setOptimisticStatus] = useState<Container["status"] | null>(null);
  const { mutate } = useSWRConfig();
  const quickLook = useQuickLook();

  useEffect(() => {
    if (!container) return;
    setOptimisticStatus(container.status);
  }, [container]);

  function nextStatus(action: "start" | "stop" | "restart"): Container["status"] {
    if (action === "start") return "running";
    if (action === "stop") return "stopped";
    return "restarting";
  }

  async function doAction(action: "start" | "stop" | "restart") {
    if (!container) return;
    const optimistic = nextStatus(action);
    const key = `${CORE_URL}/api/containers`;
    setActioning(true);
    setOptimisticStatus(optimistic);
    await mutate(
      key,
      (current: Container[] = []) =>
        current.map((c) => (c.id === container.id ? { ...c, status: optimistic } : c)),
      { revalidate: false }
    );
    try {
      const res = await fetch(`${CORE_URL}/api/containers/${container.id}/${action}`, { method: "POST" });
      if (!res.ok) throw new Error(`Failed to ${action} container`);
      await mutate(key);
      onAction?.();
      toast.success(`Container ${action} requested`);
    } catch {
      setOptimisticStatus(container.status);
      await mutate(key);
      toast.error(`Failed to ${action} container`);
    } finally {
      setActioning(false);
    }
  }

  if (!container) return null;

  const effectiveStatus = optimisticStatus ?? container.status;
  const isRunning = effectiveStatus === "running";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={cn(
          "w-full flex flex-col p-0 gap-0 overflow-hidden",
          isMobile ? "h-[92svh] rounded-t-xl" : "sm:max-w-lg"
        )}
      >
        <SheetHeader className="px-4 sm:px-6 py-4 border-b border-border/60 shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <SheetTitle className="text-base font-medium truncate">{container.name}</SheetTitle>
              <SheetDescription className="text-xs font-mono truncate mt-0.5">{container.image}</SheetDescription>
            </div>
            {/* Action buttons */}
            <div className="flex items-center justify-end gap-1.5 shrink-0 flex-wrap">
              {isRunning ? (
                <>
                  <Button variant="outline" size="sm" className="h-8 sm:h-7 text-xs gap-1 px-2.5" disabled={actioning} onClick={() => doAction("restart")}>
                    <HugeiconsIcon icon={RefreshDotIcon} size={12} />
                    <span className="hidden sm:inline">Restart</span>
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 sm:h-7 text-xs gap-1 px-2.5 text-destructive hover:text-destructive" disabled={actioning} onClick={() => doAction("stop")}>
                    <HugeiconsIcon icon={StopIcon} size={12} />
                    <span className="hidden sm:inline">Stop</span>
                  </Button>
                </>
              ) : (
                <Button variant="outline" size="sm" className="h-8 sm:h-7 text-xs gap-1 px-2.5" disabled={actioning} onClick={() => doAction("start")}>
                  <HugeiconsIcon icon={PlayIcon} size={12} />
                  <span className="hidden sm:inline">Start</span>
                </Button>
              )}
            </div>
          </div>
        </SheetHeader>

        {/* Tabs */}
        <div className="px-4 sm:px-6 pt-3 shrink-0">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="overview" className="text-xs">Overview</TabsTrigger>
              <TabsTrigger value="stats" className="text-xs">Stats</TabsTrigger>
              <TabsTrigger value="logs" className="text-xs">Logs</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-4 sm:px-6 py-4">
            {activeTab === "overview" && (
              <OverviewTab
                container={{ ...container, status: effectiveStatus }}
                onOpenPreview={() => quickLook.open(container)}
              />
            )}
            {activeTab === "stats"    && <StatsTab key={`stats-${container.id}-${effectiveStatus}`} container={container} />}
            {activeTab === "logs"     && <LogsTab key={`logs-${container.id}`} container={container} />}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
