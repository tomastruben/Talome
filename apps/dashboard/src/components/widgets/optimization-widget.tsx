"use client";

import useSWR from "swr";
import {
  HugeiconsIcon,
  PauseIcon,
  PlayIcon,
  CheckmarkCircle02Icon,
} from "@/components/icons";
import { Progress } from "@/components/ui/progress";
import { formatBytes, relativeTime } from "@/lib/format";
import { CORE_URL } from "@/lib/constants";
import { Widget, WidgetHeader } from "./widget";
import { WidgetList } from "./list-widget";
import { useAssistant } from "@/components/assistant/assistant-context";
import type { OptimizationJob, OptimizationConfig, LibraryHealthSummary } from "@talome/types";

const fetcher = (url: string) => fetch(url, { credentials: "include" }).then((r) => r.json());

// ── Progress Ring ───────────────────────────────────────────────────────────

function ProgressRing({
  progress,
  size,
  paused,
}: {
  progress: number;
  size: number;
  paused?: boolean;
}) {
  const r = (size - 4) / 2;
  const circumference = 2 * Math.PI * r;
  const center = size / 2;
  const pct = Math.round(progress * 100);

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="block" style={{ width: size, height: size }}>
      <circle
        cx={center}
        cy={center}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.08}
        strokeWidth={2.5}
      />
      <circle
        cx={center}
        cy={center}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={paused ? 0.2 : 0.45}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={`${(progress) * circumference} ${circumference}`}
        transform={`rotate(-90 ${center} ${center})`}
        className="transition-all duration-1000 ease-linear"
      />
      <text
        x={center}
        y={center + 1}
        textAnchor="middle"
        dominantBaseline="middle"
        fill="currentColor"
        fillOpacity={paused ? 0.3 : 0.6}
        fontSize={size > 48 ? 14 : 10}
        fontWeight={500}
        className="tabular-nums"
      >
        {pct}
      </text>
    </svg>
  );
}

// ── Ask Talome Link ─────────────────────────────────────────────────────────

function AskTalomeLink({ failedCount }: { failedCount: number }) {
  const { openPaletteInChatMode } = useAssistant();

  return (
    <button
      onClick={() =>
        openPaletteInChatMode(
          `I have ${failedCount} failed media conversion${failedCount !== 1 ? "s" : ""}. Can you diagnose what went wrong and fix them?`,
        )
      }
      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      {failedCount} failed — Ask Talome
    </button>
  );
}

// ── Compact (1x1) ───────────────────────────────────────────────────────────

function CompactView({
  running,
  queued,
  health,
  failed,
  paused,
}: {
  running: OptimizationJob[];
  queued: OptimizationJob[];
  health: LibraryHealthSummary | null;
  failed: OptimizationJob[];
  paused: boolean;
}) {
  const isActive = running.length > 0 || queued.length > 0;
  const avgProgress = running.length > 0
    ? running.reduce((s, j) => s + j.progress, 0) / running.length
    : 0;

  // Only show active state when jobs are actually running/queued
  if (isActive) {
    const queueCount = running.length + queued.length;
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-1.5 px-4 py-3">
        <ProgressRing
          progress={avgProgress}
          size={56}
          paused={paused}
        />
        <p className="text-xs text-muted-foreground tabular-nums">
          {paused ? "Paused" : `${queueCount} in queue`}
        </p>
      </div>
    );
  }

  // Idle (including paused with empty queue) — show library health
  if (!health || health.totalFiles === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-1 px-4 py-3">
        <p className="text-2xl font-medium tabular-nums text-foreground">--</p>
        <p className="text-xs text-muted-foreground">Awaiting first scan</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-1.5 px-4 py-3">
      <ProgressRing progress={health.optimal / health.totalFiles} size={56} />
      <p className="text-xs text-muted-foreground tabular-nums">
        {health.needsOptimization > 0 ? (
          `${health.needsOptimization} need work`
        ) : (
          <span className="flex items-center gap-1">
            <HugeiconsIcon icon={CheckmarkCircle02Icon} size={12} className="text-status-healthy" />
            All optimal
          </span>
        )}
      </p>
    </div>
  );
}

// ── Summary (2x1) ───────────────────────────────────────────────────────────

function SummaryView({
  running,
  queued,
  completed,
  failed,
  health,
  paused,
  onTogglePause,
}: {
  running: OptimizationJob[];
  queued: OptimizationJob[];
  completed: OptimizationJob[];
  failed: OptimizationJob[];
  health: LibraryHealthSummary | null;
  paused: boolean;
  onTogglePause: () => void;
}) {
  const isActive = running.length > 0 || queued.length > 0;
  const avgProgress = running.length > 0
    ? running.reduce((s, j) => s + j.progress, 0) / running.length
    : 0;
  const avgPct = Math.round(avgProgress * 100);

  if (isActive) {
    const label = running.length > 1
      ? `${running.length} files converting`
      : running[0]?.sourcePath.split("/").pop() ?? "Waiting...";

    return (
      <div className="flex-1 flex flex-col justify-center gap-2.5 px-4 py-3 min-h-0">
        <div className="flex items-center gap-3 min-w-0">
          <ProgressRing
            progress={avgProgress}
            size={36}
            paused={paused}
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">
              {paused ? "Paused" : label}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
              {running.length > 0 ? `${avgPct}%` : ""}{queued.length > 0 ? ` · ${queued.length} queued` : ""}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Idle — library health with bar
  if (!health || health.totalFiles === 0) {
    return (
      <div className="flex-1 flex flex-col justify-center gap-2 px-4 py-3">
        <p className="text-sm text-muted-foreground">Awaiting first scan.</p>
      </div>
    );
  }

  const healthPct = Math.round((health.optimal / health.totalFiles) * 100);

  return (
    <div className="flex-1 flex flex-col justify-center gap-2.5 px-4 py-3 min-h-0">
      <div className="flex items-baseline gap-1.5">
        <p className="text-2xl font-medium tabular-nums text-foreground">{healthPct}%</p>
        <p className="text-xs text-muted-foreground">ready</p>
      </div>
      <div className="w-full h-1 rounded-full bg-muted/50 overflow-hidden">
        <div
          className="h-full rounded-full bg-status-healthy transition-all duration-500"
          style={{ width: `${healthPct}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {health.needsOptimization > 0
          ? `${health.needsOptimization} need conversion`
          : "All files optimal"}
      </p>
      {failed.length > 0 && <AskTalomeLink failedCount={failed.length} />}
    </div>
  );
}

// ── Detail (2x2) ────────────────────────────────────────────────────────────

function DetailView({
  running,
  queued,
  completed,
  failed,
  health,
  paused,
  onTogglePause,
}: {
  running: OptimizationJob[];
  queued: OptimizationJob[];
  completed: OptimizationJob[];
  failed: OptimizationJob[];
  health: LibraryHealthSummary | null;
  paused: boolean;
  onTogglePause: () => void;
}) {
  const isActive = running.length > 0 || queued.length > 0;
  const avgProgress = running.length > 0
    ? running.reduce((s, j) => s + j.progress, 0) / running.length
    : 0;

  const spaceSaved = completed.reduce((sum, j) => {
    if (j.outputSize != null && j.fileSize > 0) {
      return sum + Math.max(0, j.fileSize - j.outputSize);
    }
    return sum;
  }, 0);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Running jobs */}
      {isActive && running.length > 0 ? (
        <div className="px-4 py-3 border-b border-border/40 space-y-2.5">
          {running.map((job, i) => (
            <div key={job.id} className="flex items-center gap-3 min-w-0">
              {i === 0 ? (
                <ProgressRing progress={avgProgress} size={40} paused={paused} />
              ) : (
                <div className="size-10 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className={`${i === 0 ? "text-sm font-medium" : "text-xs text-muted-foreground"} truncate`}>
                  {job.sourcePath.split("/").pop()}
                </p>
                <Progress value={Math.round(job.progress * 100)} className="h-1 mt-1" />
              </div>
              <span className="text-xs tabular-nums text-muted-foreground shrink-0">
                {Math.round(job.progress * 100)}%
              </span>
            </div>
          ))}
        </div>
      ) : isActive ? (
        <div className="px-4 py-3 border-b border-border/40">
          <p className="text-sm text-muted-foreground">
            {paused ? "Queue paused" : "Waiting to start..."}
          </p>
        </div>
      ) : null}

      {/* Queue list (when active) */}
      {isActive && queued.length > 0 && (
        <WidgetList>
          <div className="divide-y divide-border/40">
            {queued.slice(0, 4).map((job) => (
              <div key={job.id} className="px-4 py-2 flex items-center gap-2 min-w-0">
                <div className="size-1.5 rounded-full bg-muted-foreground/30 shrink-0" />
                <p className="text-xs text-muted-foreground truncate flex-1">
                  {job.sourcePath.split("/").pop()}
                </p>
                <span className="text-xs text-muted-foreground/60 tabular-nums shrink-0">
                  {formatBytes(job.fileSize)}
                </span>
              </div>
            ))}
            {queued.length > 4 && (
              <div className="px-4 py-2">
                <p className="text-xs text-muted-foreground/60 tabular-nums">
                  +{queued.length - 4} more
                </p>
              </div>
            )}
          </div>
        </WidgetList>
      )}

      {/* Library health (when idle or paused with empty queue) */}
      {health && health.totalFiles > 0 && !isActive && (() => {
        const healthPct = Math.round((health.optimal / health.totalFiles) * 100);
        return (
          <div className="px-4 py-3 space-y-3">
            <div className="flex items-baseline gap-2">
              <p className="text-3xl font-medium tabular-nums text-foreground">{healthPct}%</p>
              <p className="text-sm text-muted-foreground">ready for playback</p>
            </div>
            <div className="w-full h-1.5 rounded-full bg-muted/50 overflow-hidden">
              <div
                className="h-full rounded-full bg-status-healthy transition-all duration-500"
                style={{ width: `${healthPct}%` }}
              />
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>{health.totalFiles} files</span>
              {health.needsOptimization > 0 && (
                <span>{health.needsOptimization} need conversion</span>
              )}
              {failed.length > 0 && <AskTalomeLink failedCount={failed.length} />}
            </div>
            {health.lastScanAt && (
              <p className="text-xs text-muted-foreground/60 tabular-nums">
                Last scanned {relativeTime(health.lastScanAt)}
              </p>
            )}
          </div>
        );
      })()}

      {/* No data */}
      {(!health || health.totalFiles === 0) && !isActive && (
        <div className="flex-1 flex items-center justify-center px-4 py-3">
          <p className="text-xs text-muted-foreground">Awaiting first scan.</p>
        </div>
      )}

      {/* Bottom metrics bar */}
      <div className="mt-auto border-t border-border/40 px-4 py-2.5 flex items-center gap-4 text-xs text-muted-foreground tabular-nums">
        {completed.length > 0 && <span>Done: {completed.length}</span>}
        {failed.length > 0 && (
          <span className="text-status-critical">Failed: {failed.length}</span>
        )}
        {spaceSaved > 0 && <span>Saved: {formatBytes(spaceSaved)}</span>}
        {completed.length === 0 && failed.length === 0 && spaceSaved === 0 && (
          <span>No recent activity</span>
        )}
      </div>
    </div>
  );
}

// ── Main Widget ─────────────────────────────────────────────────────────────

export function OptimizationWidget({
  mode = "compact",
}: {
  mode?: "compact" | "summary" | "detail";
}) {
  // Active jobs — fast poll when active, slow when idle
  const { data: jobsData } = useSWR<{ jobs: OptimizationJob[] }>(
    `${CORE_URL}/api/optimization/jobs`,
    fetcher,
    { refreshInterval: 5000, dedupingInterval: 3000 },
  );

  const allJobs = jobsData?.jobs ?? [];
  const running = allJobs.filter((j) => j.status === "running");
  const queued = allJobs.filter((j) => j.status === "queued");
  const completed = allJobs.filter((j) => j.status === "completed");
  const failed = allJobs.filter((j) => j.status === "failed");
  const isActive = running.length > 0 || queued.length > 0;

  // Config for pause state + media type filter
  const { data: config, mutate: mutateConfig } = useSWR<OptimizationConfig>(
    `${CORE_URL}/api/optimization/config`,
    fetcher,
    { refreshInterval: 30_000 },
  );

  const mediaType = config?.mediaTypes ?? "all";
  const healthUrl = mediaType !== "all"
    ? `${CORE_URL}/api/optimization/health?type=${mediaType}`
    : `${CORE_URL}/api/optimization/health`;

  // Library health — slow poll, filtered by media type
  const { data: health } = useSWR<LibraryHealthSummary>(
    healthUrl,
    fetcher,
    { refreshInterval: 60_000 },
  );

  const paused = config?.paused ?? false;

  const togglePause = async () => {
    if (!config) return;
    try {
      await fetch(`${CORE_URL}/api/optimization/config`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: !config.paused }),
      });
      void mutateConfig({ ...config, paused: !config.paused }, false);
    } catch { /* ignore */ }
  };

  const activeCount = running.length + queued.length;

  const headerActions = mode !== "compact" ? (
    <button
      onClick={() => void togglePause()}
      className="size-6 rounded-md flex items-center justify-center hover:bg-foreground/[0.06] transition-colors"
      aria-label={paused ? "Resume" : "Pause"}
    >
      <HugeiconsIcon
        icon={paused ? PlayIcon : PauseIcon}
        size={12}
        className="text-muted-foreground"
      />
    </button>
  ) : undefined;

  return (
    <Widget>
      <WidgetHeader
        title="Media Health"
        href="/dashboard/settings/media-player"
        hrefLabel={isActive ? `${activeCount} active` : undefined}
        actions={headerActions}
      />
      {mode === "compact" && (
        <CompactView
          running={running}
          queued={queued}
          health={health ?? null}
          failed={failed}
          paused={paused}
        />
      )}
      {mode === "summary" && (
        <SummaryView
          running={running}
          queued={queued}
          completed={completed}
          failed={failed}
          health={health ?? null}
          paused={paused}
          onTogglePause={togglePause}
        />
      )}
      {mode === "detail" && (
        <DetailView
          running={running}
          queued={queued}
          completed={completed}
          failed={failed}
          health={health ?? null}
          paused={paused}
          onTogglePause={togglePause}
        />
      )}
    </Widget>
  );
}
