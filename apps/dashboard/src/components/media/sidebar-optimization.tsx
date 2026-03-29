"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import {
  HugeiconsIcon,
  PlayIcon,
  PauseIcon,
  Cancel01Icon,
} from "@/components/icons";
import { SidebarMenuItem } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getDirectCoreUrl } from "@/lib/constants";
import type { OptimizationJob, OptimizationConfig } from "@talome/types";

/**
 * Compact optimization status widget in the sidebar footer.
 * Mirrors the audiobook mini-player pattern — appears when conversions
 * are active, disappears when idle. Shows current file + progress with
 * pause/resume control.
 */
export function SidebarOptimization() {
  const [jobs, setJobs] = useState<OptimizationJob[]>([]);
  const [config, setConfig] = useState<OptimizationConfig | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const apiBase = getDirectCoreUrl();

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/optimization/jobs?status=running,queued`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs ?? []);
      }
    } catch { /* server may not be running */ }
  }, [apiBase]);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/optimization/config`, { credentials: "include" });
      if (res.ok) setConfig(await res.json());
    } catch { /* ignore */ }
  }, [apiBase]);

  const running = jobs.filter(j => j.status === "running");
  const queued = jobs.filter(j => j.status === "queued");
  const totalActive = running.length + queued.length;

  useEffect(() => {
    void fetchJobs();
    void fetchConfig();
    const interval = setInterval(() => { void fetchJobs(); void fetchConfig(); }, 3000);
    return () => clearInterval(interval);
  }, [fetchJobs, fetchConfig]);

  // Reset dismissed when new jobs appear
  useEffect(() => {
    if (totalActive > 0 && dismissed) setDismissed(false);
  }, [totalActive, dismissed]);

  const avgProgress = running.length > 0
    ? running.reduce((s, j) => s + j.progress, 0) / running.length
    : 0;

  const togglePause = async () => {
    if (!config) return;
    try {
      await fetch(`${apiBase}/api/optimization/config`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: !config.paused }),
      });
      setConfig(prev => prev ? { ...prev, paused: !prev.paused } : prev);
    } catch { /* ignore */ }
  };

  const cancelCurrent = async () => {
    if (running.length === 0) return;
    try {
      await fetch(`${apiBase}/api/optimization/jobs/${running[0].id}/cancel`, {
        method: "POST", credentials: "include",
      });
      void fetchJobs();
    } catch { /* ignore */ }
  };

  const paused = config?.paused ?? false;
  const show = !dismissed && (totalActive > 0 || paused);
  const progressPct = avgProgress * 100;
  const statusText = running.length > 1
    ? `${running.length} converting`
    : running[0]?.sourcePath.split("/").pop() ?? "";

  return (
    <AnimatePresence>
      {show && (
        <SidebarMenuItem>
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
            className="overflow-hidden"
          >
            <div className="rounded-lg bg-foreground/[0.04] p-2 group-data-[collapsible=icon]:p-0">
              {/* Collapsed icon mode: progress ring */}
              <div className="hidden group-data-[collapsible=icon]:flex items-center justify-center">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link href="/dashboard/settings/media-player" className="relative">
                      <div className="size-8 rounded-md bg-muted overflow-hidden flex items-center justify-center">
                        <svg viewBox="0 0 28 28" className="size-6">
                          <circle
                            cx="14"
                            cy="14"
                            r="11"
                            fill="none"
                            stroke="currentColor"
                            strokeOpacity={0.1}
                            strokeWidth={2}
                          />
                          <circle
                            cx="14"
                            cy="14"
                            r="11"
                            fill="none"
                            stroke="currentColor"
                            strokeOpacity={paused ? 0.25 : 0.5}
                            strokeWidth={2}
                            strokeLinecap="round"
                            strokeDasharray={`${(progressPct / 100) * 69.1} 69.1`}
                            transform="rotate(-90 14 14)"
                            className="transition-all duration-1000 ease-linear"
                          />
                          <text
                            x="14"
                            y="15.5"
                            textAnchor="middle"
                            fill="currentColor"
                            fillOpacity={0.5}
                            fontSize="8"
                            fontWeight={500}
                            className="tabular-nums"
                          >
                            {totalActive}
                          </text>
                        </svg>
                      </div>
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {paused ? "Optimization paused" : `Optimizing ${totalActive} file${totalActive !== 1 ? "s" : ""}`}
                  </TooltipContent>
                </Tooltip>
              </div>

              {/* Expanded mode */}
              <div className="flex items-center gap-2.5 group-data-[collapsible=icon]:hidden">
                {/* Progress circle */}
                <Link href="/dashboard/settings/media-player" className="shrink-0">
                  <div className="size-9 rounded-md bg-muted/50 flex items-center justify-center">
                    <svg viewBox="0 0 28 28" className="size-6">
                      <circle
                        cx="14"
                        cy="14"
                        r="11"
                        fill="none"
                        stroke="currentColor"
                        strokeOpacity={0.1}
                        strokeWidth={2}
                      />
                      <circle
                        cx="14"
                        cy="14"
                        r="11"
                        fill="none"
                        stroke="currentColor"
                        strokeOpacity={paused ? 0.25 : 0.5}
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeDasharray={`${(progressPct / 100) * 69.1} 69.1`}
                        transform="rotate(-90 14 14)"
                        className="transition-all duration-1000 ease-linear"
                      />
                      <text
                        x="14"
                        y="15.5"
                        textAnchor="middle"
                        fill="currentColor"
                        fillOpacity={0.5}
                        fontSize="8"
                        fontWeight={500}
                        className="tabular-nums"
                      >
                        {Math.round(progressPct)}
                      </text>
                    </svg>
                  </div>
                </Link>

                <div className="flex-1 min-w-0">
                  <Link href="/dashboard/settings/media-player" className="block hover:opacity-80 transition-opacity">
                    <p className="text-xs font-medium truncate leading-tight">
                      {paused ? "Paused" : "Optimizing"}
                    </p>
                    <p className="text-xs text-muted-foreground truncate leading-tight mt-0.5">
                      {running.length > 0 ? statusText : totalActive > 0 ? `${queued.length} queued` : "Conversions frozen"}
                      {running.length > 0 && queued.length > 0 && ` +${queued.length}`}
                    </p>
                  </Link>
                </div>

                <div className="flex items-center shrink-0">
                  <button
                    onClick={() => void togglePause()}
                    className="size-7 rounded-full flex items-center justify-center hover:bg-foreground/[0.06] transition-colors"
                    aria-label={paused ? "Resume" : "Pause"}
                  >
                    <HugeiconsIcon
                      icon={paused ? PlayIcon : PauseIcon}
                      size={14}
                      className="text-muted-foreground"
                    />
                  </button>
                  <button
                    onClick={() => {
                      if (running.length > 0) void cancelCurrent();
                      setDismissed(true);
                    }}
                    className="size-7 rounded-full flex items-center justify-center hover:bg-foreground/[0.06] transition-colors text-dim-foreground hover:text-muted-foreground"
                    aria-label="Dismiss"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} size={12} />
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </SidebarMenuItem>
      )}
    </AnimatePresence>
  );
}
