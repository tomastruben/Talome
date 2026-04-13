"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSetAtom } from "jotai";
import useSWR from "swr";
import { HugeiconsIcon, PlayIcon, ComputerTerminal01Icon, ArrowDown01Icon } from "@/components/icons";
import { terminalSessionAtom, terminalCommandAtom } from "@/atoms/terminal";
import { Widget, WidgetHeader } from "@/components/widgets/widget";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";

interface AppHealthResult {
  appId: string;
  name: string;
  score: number;
  issues: string[];
}

interface HealthScore {
  overall: number;
  apps: AppHealthResult[];
  configured: number;
  total: number;
}

interface SetupEvent {
  type: string;
  runId?: string;
  message?: string;
  healthScore?: number;
  appScores?: Array<{ appId: string; name: string; score: number }>;
}

const fetcher = (url: string) => fetch(url, { credentials: "include" }).then((r) => r.json());

function HealthRing({ score, size = 56 }: { score: number; size?: number }) {
  const strokeWidth = 4;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;

  const color =
    score >= 90
      ? "text-status-healthy"
      : score >= 50
        ? "text-status-warning"
        : "text-status-critical";

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-muted/50"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className={cn("transition-all duration-700", color)}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-xs font-medium tabular-nums">
        {score}%
      </span>
    </div>
  );
}

function AppHealthDot({ score }: { score: number }) {
  const color =
    score === 100
      ? "bg-status-healthy"
      : score >= 40
        ? "bg-status-warning"
        : "bg-status-critical";
  return <span className={cn("size-1.5 rounded-full shrink-0", color)} />;
}

export function SetupWidget() {
  const router = useRouter();
  const setTerminalSession = useSetAtom(terminalSessionAtom);
  const setTerminalCommand = useSetAtom(terminalCommandAtom);
  const { data: health, mutate: mutateHealth } = useSWR<HealthScore>(
    `${CORE_URL}/api/setup/health-score`,
    fetcher,
    { refreshInterval: 30_000 },
  );

  const [starting, setStarting] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [liveScore, setLiveScore] = useState<number | null>(null);

  // SSE for live updates during a run
  useEffect(() => {
    if (!activeRunId) return;

    const es = new EventSource(`${CORE_URL}/api/setup/stream`);
    es.onmessage = (e) => {
      try {
        const event: SetupEvent = JSON.parse(e.data);
        if (event.healthScore != null) setLiveScore(event.healthScore);
        if (event.type === "completed" || event.type === "failed" || event.type === "paused") {
          setActiveRunId(null);
          setLiveScore(null);
          void mutateHealth();
          if (event.type === "completed") {
            toast.success("Setup complete — all apps configured");
          } else if (event.type === "paused") {
            toast.info(event.message ?? "Setup paused");
          }
        }
      } catch { /* ignore parse errors */ }
    };
    return () => es.close();
  }, [activeRunId, mutateHealth]);

  async function handleQuickStart() {
    setStarting(true);
    try {
      const res = await fetch(`${CORE_URL}/api/setup/start`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (data.runId) {
        setActiveRunId(data.runId);
        toast.success("Auto-configure started");
      } else {
        toast.error(data.error ?? "Failed to start");
      }
    } catch {
      toast.error("Failed to start setup");
    } finally {
      setStarting(false);
    }
  }

  async function handleDelegate() {
    setStarting(true);
    try {
      const res = await fetch(`${CORE_URL}/api/setup/delegate`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (data.sessionName && data.command) {
        // Set atoms so TerminalPage picks up the session + command
        setTerminalSession(data.sessionName);
        setTerminalCommand(data.command);
        toast.success("Opening Claude Code for setup");
        router.push("/dashboard/terminal");
      } else {
        toast.error(data.error ?? "Failed to delegate");
      }
    } catch {
      toast.error("Failed to start Claude Code session");
    } finally {
      setStarting(false);
    }
  }

  async function handlePause() {
    if (!activeRunId) return;
    await fetch(`${CORE_URL}/api/setup/pause/${activeRunId}`, {
      method: "POST",
      credentials: "include",
    });
  }

  if (!health || health.total === 0) return null;

  const displayScore = liveScore ?? health.overall;
  const isRunning = activeRunId !== null;
  const needsSetup = health.apps.some((a) => a.score < 100);
  const appsWithIssues = health.apps.filter((a) => a.score < 100).sort((a, b) => a.score - b.score);

  return (
    <Widget className="h-auto">
      <WidgetHeader
        title="Server Setup"
        actions={
          isRunning ? (
            <button
              onClick={handlePause}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Pause
            </button>
          ) : needsSetup ? (
            <div className="flex items-center">
              <Button
                size="sm"
                variant="ghost"
                onClick={handleQuickStart}
                disabled={starting}
                className="h-7 text-xs px-2.5 gap-1 rounded-r-none"
              >
                {starting ? <Spinner size="sm" /> : <HugeiconsIcon icon={PlayIcon} size={12} />}
                Auto-configure
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={starting}
                    className="h-7 px-1 rounded-l-none border-l border-border/50"
                  >
                    <HugeiconsIcon icon={ArrowDown01Icon} size={12} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem onClick={handleQuickStart}>
                    <HugeiconsIcon icon={PlayIcon} size={14} />
                    Quick (background)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleDelegate}>
                    <HugeiconsIcon icon={ComputerTerminal01Icon} size={14} />
                    Claude Code (terminal)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null
        }
      />

      <div className="px-4 pt-1 pb-4">
        <div className="flex items-center gap-4">
          <div className={isRunning ? "animate-pulse" : undefined}>
            <HealthRing score={displayScore} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">
              {health.configured}/{health.total} apps configured
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {displayScore === 100
                ? "All apps fully configured and wired"
                : isRunning
                  ? "Configuring apps..."
                  : `${appsWithIssues.length} app${appsWithIssues.length !== 1 ? "s" : ""} need${appsWithIssues.length === 1 ? "s" : ""} attention`}
            </p>
          </div>
        </div>

        {/* Only show apps that need attention — green-across-the-board is noise */}
        {appsWithIssues.length > 0 && (
          <div className="mt-3 space-y-2">
            {appsWithIssues.map((app) => (
              <div key={app.appId}>
                <div className="flex items-center gap-2">
                  <AppHealthDot score={app.score} />
                  <span className="text-xs font-medium flex-1 min-w-0 truncate">{app.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{app.score}%</span>
                </div>
                {app.issues.length > 0 && (
                  <p className="text-[11px] text-muted-foreground ml-3.5 mt-0.5">
                    {app.issues.join(" · ")}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Widget>
  );
}
