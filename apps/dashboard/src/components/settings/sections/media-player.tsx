"use client";

import { useState, useEffect, useCallback } from "react";
import { HugeiconsIcon, Delete01Icon, Search01Icon } from "@/components/icons";
import { SettingsGroup, SettingsRow } from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { getDirectCoreUrl } from "@/lib/constants";
import { formatBytes } from "@/lib/format";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAssistant } from "@/components/assistant/assistant-context";
import type { TranscodingConfig, OptimizationConfig, OptimizationJob } from "@talome/types";

interface CacheStats {
  jobCount: number;
  runningCount: number;
  totalSize: number;
}

interface HealthSummary {
  totalFiles: number;
  optimal: number;
  needsOptimization: number;
  lastScanAt: string | null;
}

export function MediaPlayerSection() {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [config, setConfig] = useState<TranscodingConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [performanceMode, setPerformanceMode] = useState(false);

  // Optimization state
  const [optConfig, setOptConfig] = useState<OptimizationConfig | null>(null);
  const [optJobs, setOptJobs] = useState<OptimizationJob[]>([]);
  const [scanning, setScanning] = useState(false);
  const [optSaving, setOptSaving] = useState(false);
  const [health, setHealth] = useState<HealthSummary | null>(null);

  useEffect(() => {
    setPerformanceMode(localStorage.getItem("talome-cinema-render-mode") === "performance");
  }, []);

  const apiBase = getDirectCoreUrl();

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/files/hls-cache`, { credentials: "include" });
      if (res.ok) setStats(await res.json());
    } catch { /* server may not be running */ }
    finally { setLoading(false); }
  }, [apiBase]);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/files/transcode-config`, { credentials: "include" });
      if (res.ok) setConfig(await res.json());
    } catch { /* server may not be running */ }
    finally { setConfigLoading(false); }
  }, [apiBase]);

  const fetchOptConfig = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/optimization/config`, { credentials: "include" });
      if (res.ok) setOptConfig(await res.json());
    } catch { /* server may not be running */ }
  }, [apiBase]);

  const fetchOptJobs = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/optimization/jobs?status=running,queued,completed,failed`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setOptJobs(data.jobs ?? []);
      }
    } catch { /* ignore */ }
  }, [apiBase]);

  const fetchHealth = useCallback(async (mediaType?: string) => {
    try {
      const typeParam = mediaType && mediaType !== "all" ? `?type=${mediaType}` : "";
      const res = await fetch(`${apiBase}/api/optimization/health${typeParam}`, { credentials: "include" });
      if (res.ok) setHealth(await res.json());
    } catch { /* ignore */ }
  }, [apiBase]);

  const updateOptConfig = async (patch: Partial<OptimizationConfig>) => {
    setOptSaving(true);
    try {
      const res = await fetch(`${apiBase}/api/optimization/config`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        setOptConfig((prev) => prev ? { ...prev, ...patch } : prev);
        toast("Settings saved");
      }
    } catch { toast.error("Failed to save"); }
    finally { setOptSaving(false); }
  };

  useEffect(() => { void fetchStats(); void fetchConfig(); }, [fetchStats, fetchConfig]);
  // Tagged media root paths for filtering jobs by media type
  const [taggedPaths, setTaggedPaths] = useState<Array<{ path: string; source: string }>>([]);

  const fetchTaggedPaths = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/optimization/scan-paths`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setTaggedPaths(data.tagged ?? []);
      }
    } catch { /* ignore */ }
  }, [apiBase]);

  useEffect(() => { void fetchOptConfig(); void fetchTaggedPaths(); }, [fetchOptConfig, fetchTaggedPaths]);
  // Re-fetch health when media type filter changes
  useEffect(() => { void fetchHealth(optConfig?.mediaTypes); }, [fetchHealth, optConfig?.mediaTypes]);
  useEffect(() => {
    void fetchOptJobs();
    const interval = setInterval(() => void fetchOptJobs(), 3000);
    return () => clearInterval(interval);
  }, [fetchOptJobs]);

  // Filter jobs by selected media type using tagged root paths
  const mediaFilter = optConfig?.mediaTypes ?? "all";
  const filteredJobs = mediaFilter === "all"
    ? optJobs
    : optJobs.filter((job) => {
        const roots = taggedPaths.filter((t) => t.source === mediaFilter).map((t) => t.path);
        return roots.some((root) => job.sourcePath.startsWith(root));
      });

  const completed = filteredJobs.filter(j => j.status === "completed");
  const failed = filteredJobs.filter(j => j.status === "failed");

  const clearCache = async () => {
    setClearing(true);
    try {
      const res = await fetch(`${apiBase}/api/files/hls-cache/clear`, { method: "POST", credentials: "include" });
      const data = await res.json();
      if (data.ok) {
        toast(`Freed ${formatBytes(data.freedSize)}`);
        void fetchStats();
      } else {
        toast.error("Failed to clear cache");
      }
    } catch {
      toast.error("Failed to clear cache");
    } finally {
      setClearing(false);
    }
  };

  const updateConfig = async (patch: Partial<TranscodingConfig>) => {
    setSaving(true);
    try {
      const res = await fetch(`${apiBase}/api/files/transcode-config`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        setConfig((prev) => prev ? { ...prev, ...patch } : prev);
        toast("Settings saved");
      } else {
        toast.error("Failed to save settings");
      }
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  // Single action: scan + optimize (queue jobs if auto-optimize is off, scan-only if on)
  const runScanAndOptimize = async () => {
    setScanning(true);
    const shouldQueue = !optConfig?.autoOptimize;
    const mediaFilter = optConfig?.mediaTypes ?? "all";
    try {
      // Get scan paths from Radarr/Sonarr root folders
      const pathsRes = await fetch(`${apiBase}/api/optimization/scan-paths`, { credentials: "include" });
      const pathsData = pathsRes.ok ? await pathsRes.json() : { paths: [], tagged: [] };
      const tagged = (pathsData.tagged as Array<{ path: string; source: string }>) ?? [];
      // Filter paths by media type setting
      const filtered = mediaFilter === "all" ? tagged : tagged.filter((t) => t.source === mediaFilter);
      const scanPaths = filtered.map((t) => t.path);
      if (scanPaths.length === 0) { toast.error("No media directories found — configure Radarr or Sonarr first"); setScanning(false); return; }

      const res = await fetch(`${apiBase}/api/optimization/scan`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: scanPaths, queueJobs: shouldQueue }),
      });
      if (res.ok) {
        const data = await res.json();
        void fetchHealth(optConfig?.mediaTypes);
        if (shouldQueue && data.queued > 0) {
          void fetchOptJobs();
          toast(`${data.queued} files queued for conversion`);
        } else if (data.queued > 0) {
          toast(`Found ${data.queued} files needing conversion`);
        } else {
          toast("All files are already optimized");
        }
      }
    } catch { toast.error("Scan failed"); }
    finally { setScanning(false); }
  };

  const { openPaletteInChatMode } = useAssistant();

  const healthPct = health && health.totalFiles > 0
    ? Math.round((health.optimal / health.totalFiles) * 100)
    : 0;

  return (
    <div className="grid gap-6">

      {/* ── Library Optimization ─────────────────────────────────── */}
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Library Health
          </p>
        </SettingsRow>

        {/* ── Health bar + summary line ── */}
        <SettingsRow>
          <div className="w-full space-y-2.5">
            {health && health.totalFiles > 0 ? (
              <>
                <div className="h-[3px] w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-status-healthy rounded-full transition-all duration-500"
                    style={{ width: `${healthPct}%` }}
                  />
                </div>
                <p className="text-sm text-muted-foreground">
                  <span className="text-foreground font-medium tabular-nums">{healthPct}%</span> ready
                  {health.needsOptimization > 0 && (
                    <> · <span className="tabular-nums">{health.needsOptimization}</span> need conversion</>
                  )}
                  {failed.length > 0 && (
                    <>
                      {" · "}
                      <button
                        onClick={() =>
                          openPaletteInChatMode(
                            `I have ${failed.length} failed media conversion${failed.length !== 1 ? "s" : ""}. Can you diagnose what went wrong and fix them?`,
                          )
                        }
                        className="text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {failed.length} failed — Ask Talome
                      </button>
                    </>
                  )}
                </p>
              </>
            ) : health ? (
              <p className="text-sm text-muted-foreground">
                Scan your library to find files that can be optimized for browser playback.
              </p>
            ) : (
              <Skeleton className="h-4 w-48" />
            )}
          </div>
        </SettingsRow>

        {/* ── Recent activity one-liner ── */}
        {(completed.length > 0 || failed.length > 0) && (
          <SettingsRow>
            <p className="text-xs text-muted-foreground tabular-nums">
              {completed.length > 0 && <>{completed.length} converted</>}
              {completed.length > 0 && failed.length > 0 && " · "}
              {failed.length > 0 && (
                <>
                  <span className="text-status-critical">{failed.length} failed</span>
                  {" — "}
                  <button
                    onClick={() =>
                      openPaletteInChatMode(
                        `I have ${failed.length} failed media conversion${failed.length !== 1 ? "s" : ""}. Can you diagnose what went wrong and fix them?`,
                      )
                    }
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Ask Talome
                  </button>
                </>
              )}
            </p>
          </SettingsRow>
        )}

        {/* ── Scan action ── */}
        <SettingsRow className="bg-muted/30 py-3 flex-wrap sm:flex-nowrap gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground">
              {(optConfig?.mediaTypes ?? "all") === "movies"
                ? "Movies"
                : (optConfig?.mediaTypes ?? "all") === "tv"
                  ? "TV shows"
                  : "Movies & TV shows"}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 w-full sm:w-auto shrink-0"
            disabled={scanning}
            onClick={() => void runScanAndOptimize()}
          >
            {scanning ? <Spinner className="h-3 w-3" /> : <HugeiconsIcon icon={Search01Icon} size={14} />}
            {scanning ? "Scanning..." : "Scan library"}
          </Button>
        </SettingsRow>

        {/* ── Settings ── */}
        {optConfig && (
          <>
            <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm">Media to optimize</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Choose which libraries to scan and convert
                </p>
              </div>
              <div className="inline-flex rounded-lg bg-muted/40 p-0.5">
                {(["all", "movies", "tv"] as const).map((value) => {
                  const active = (optConfig.mediaTypes ?? "all") === value;
                  const label = value === "all" ? "All" : value === "movies" ? "Movies" : "TV Shows";
                  return (
                    <button
                      key={value}
                      disabled={optSaving}
                      onClick={() => void updateOptConfig({ mediaTypes: value })}
                      className={cn(
                        "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                        active
                          ? "bg-foreground/10 text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </SettingsRow>

            <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm">Keep original files</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Preserve originals after conversion
                </p>
              </div>
              <Switch
                checked={optConfig.keepOriginals}
                disabled={optSaving}
                onCheckedChange={(v) => void updateOptConfig({ keepOriginals: v })}
              />
            </SettingsRow>

            <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm">Auto-optimize</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Convert new downloads every 30 minutes
                </p>
              </div>
              <Switch
                checked={optConfig.autoOptimize}
                disabled={optSaving}
                onCheckedChange={(v) => void updateOptConfig({ autoOptimize: v })}
              />
            </SettingsRow>

            <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm">Max concurrent conversions</p>
              </div>
              <Input
                type="number"
                className="w-full sm:w-20 text-sm tabular-nums h-8"
                min={1}
                max={4}
                defaultValue={optConfig.maxConcurrentJobs}
                disabled={optSaving}
                onBlur={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (val >= 1 && val <= 4 && val !== optConfig.maxConcurrentJobs) {
                    void updateOptConfig({ maxConcurrentJobs: val });
                  }
                }}
              />
            </SettingsRow>
          </>
        )}
      </SettingsGroup>

      {/* ── Cinema Mode ─────────────────────────────────────────────── */}
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Cinema Mode
          </p>
        </SettingsRow>
        <SettingsRow>
          <div className="w-full space-y-3">
            <p className="text-sm">Rendering</p>
            <div className="grid grid-cols-2 gap-3">
              {([
                { value: false, label: "Quality", desc: "Desktops and powerful hardware" },
                { value: true, label: "Performance", desc: "Smart TVs and projectors" },
              ] as const).map(({ value, label, desc }) => {
                const active = performanceMode === value;
                return (
                  <button
                    key={label}
                    onClick={() => {
                      localStorage.setItem("talome-cinema-render-mode", value ? "performance" : "quality");
                      setPerformanceMode(value);
                      toast(`Cinema rendering: ${label}`);
                    }}
                    className={cn(
                      "flex flex-col items-start gap-1 rounded-lg px-4 py-3 text-left transition-colors",
                      active
                        ? "bg-foreground/10 ring-1 ring-foreground/20"
                        : "bg-muted/40 hover:bg-muted/60",
                    )}
                  >
                    <span className={cn("text-sm font-medium", active ? "text-foreground" : "text-muted-foreground")}>{label}</span>
                    <span className="text-xs text-muted-foreground">{desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </SettingsRow>
        <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm">Shareable link</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Bookmark this on your TV or projector
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 w-full sm:w-auto"
            onClick={() => {
              const url = `${window.location.origin}/dashboard/media?cinema=1`;
              if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(url).then(
                  () => toast("Link copied to clipboard"),
                  () => toast.error("Failed to copy"),
                );
              } else {
                const input = document.createElement("input");
                input.value = url;
                document.body.appendChild(input);
                input.select();
                document.execCommand("copy");
                document.body.removeChild(input);
                toast("Link copied to clipboard");
              }
            }}
          >
            Copy link
          </Button>
        </SettingsRow>
      </SettingsGroup>

      {/* ── Transcoding ──────────────────────────────────────────── */}
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Transcoding
          </p>
        </SettingsRow>

        {configLoading ? (
          <SettingsRow>
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
          </SettingsRow>
        ) : config ? (
          <>
            <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm">Smart detection</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Skip transcoding for browser-compatible codecs
                </p>
              </div>
              <Switch
                checked={config.enableSmartDetection}
                disabled={saving}
                onCheckedChange={(v) => void updateConfig({ enableSmartDetection: v })}
              />
            </SettingsRow>

            <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm">Transcode cache</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Cache for faster replay of the same content
                </p>
              </div>
              <Switch
                checked={config.enableTranscodeCache}
                disabled={saving}
                onCheckedChange={(v) => void updateConfig({ enableTranscodeCache: v })}
              />
            </SettingsRow>

            <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm">Source folder temp</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Write temp files to media drive instead of system drive
                </p>
              </div>
              <Switch
                checked={config.useSourceFolderTemp}
                disabled={saving}
                onCheckedChange={(v) => void updateConfig({ useSourceFolderTemp: v })}
              />
            </SettingsRow>

            <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm">HLS temp directory</p>
              </div>
              <Input
                className="w-full sm:w-64 text-xs font-mono h-8"
                defaultValue={config.hlsTempDirectory}
                disabled={saving}
                onBlur={(e) => {
                  const val = e.target.value.trim();
                  if (val && val !== config.hlsTempDirectory) {
                    void updateConfig({ hlsTempDirectory: val });
                  }
                }}
              />
            </SettingsRow>

            <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm">Transmux temp directory</p>
              </div>
              <Input
                className="w-full sm:w-64 text-xs font-mono h-8"
                defaultValue={config.transmuxTempDirectory}
                disabled={saving}
                onBlur={(e) => {
                  const val = e.target.value.trim();
                  if (val && val !== config.transmuxTempDirectory) {
                    void updateConfig({ transmuxTempDirectory: val });
                  }
                }}
              />
            </SettingsRow>

            <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm">Max concurrent jobs</p>
              </div>
              <Input
                type="number"
                className="w-full sm:w-20 text-sm tabular-nums h-8"
                min={1}
                max={20}
                defaultValue={config.maxConcurrentJobs}
                disabled={saving}
                onBlur={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (val >= 1 && val <= 20 && val !== config.maxConcurrentJobs) {
                    void updateConfig({ maxConcurrentJobs: val });
                  }
                }}
              />
            </SettingsRow>
          </>
        ) : (
          <SettingsRow>
            <p className="text-sm text-muted-foreground">Unable to load transcoding config.</p>
          </SettingsRow>
        )}
      </SettingsGroup>

      {/* ── HLS Cache ─────────────────────────────────────────────── */}
      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            HLS Cache
          </p>
        </SettingsRow>

        {loading ? (
          <SettingsRow>
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
          </SettingsRow>
        ) : stats ? (
          <>
            <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm">
                  {stats.jobCount} job{stats.jobCount !== 1 ? "s" : ""}
                  {stats.runningCount > 0 && (
                    <span className="text-muted-foreground"> ({stats.runningCount} active)</span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Auto-expires after 90s idle
                </p>
              </div>
              <p className="text-sm tabular-nums font-medium shrink-0">
                {formatBytes(stats.totalSize)}
              </p>
            </SettingsRow>

            {stats.totalSize > 0 && (
              <SettingsRow className="bg-muted/30 justify-end py-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 w-full sm:w-auto"
                  disabled={clearing}
                  onClick={() => void clearCache()}
                >
                  {clearing ? (
                    <Spinner className="h-3 w-3" />
                  ) : (
                    <HugeiconsIcon icon={Delete01Icon} size={14} />
                  )}
                  Clear cache
                </Button>
              </SettingsRow>
            )}
          </>
        ) : (
          <SettingsRow>
            <p className="text-sm text-muted-foreground">Unable to load cache stats.</p>
          </SettingsRow>
        )}
      </SettingsGroup>
    </div>
  );
}
