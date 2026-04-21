"use client";

import { useRef, useEffect, useState, useMemo } from "react";
import { HugeiconsIcon, PlayIcon, Delete01Icon, Search01Icon } from "@/components/icons";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { getDirectCoreUrl } from "@/lib/constants";
import { toast } from "sonner";
import useSWR from "swr";
import type { SeasonData, EpisodeData } from "./media-detail-sheet";

interface EpisodeBrowserProps {
  seasons: SeasonData[];
  selectedSeason: number;
  onSeasonChange: (season: number) => void;
  currentEpisodeId: number | null;
  onPlayEpisode: (episode: EpisodeData) => void;
  onDeleteEpisode?: (episode: EpisodeData) => void;
  onSearchEpisode?: (episode: EpisodeData, seasonNumber: number) => void;
  /** Episode ID currently targeted by release search (for highlight). */
  searchingEpisodeId?: number | null;
}

const NON_OPTIMAL_EXT = /\.(mkv|avi|wmv|flv|ts|webm)$/i;
const OPTIMAL_CONTAINERS = new Set(["mp4", "m4v", "mov", "webm"]);
const BROWSER_VIDEO = new Set(["h264", "x264", "hevc", "h265", "x265"]);
const BROWSER_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

/** Check if an episode needs optimization using codec info when available, falling back to extension. */
function episodeNeedsOpt(ep: EpisodeData): boolean {
  if (!ep.hasFile || !ep.filePath) return false;
  // If we have codec info from Sonarr, use it for accurate detection
  if (ep.container || ep.codec || ep.audioCodec) {
    const container = (ep.container ?? "").toLowerCase();
    const codec = (ep.codec ?? "").toLowerCase();
    const audio = (ep.audioCodec ?? "").toLowerCase();
    const containerOk = !container || OPTIMAL_CONTAINERS.has(container);
    const videoOk = !codec || BROWSER_VIDEO.has(codec);
    const audioOk = !audio || BROWSER_AUDIO.has(audio);
    return !containerOk || !videoOk || !audioOk;
  }
  // Fallback: check file extension
  return NON_OPTIMAL_EXT.test(ep.filePath);
}

function formatRuntime(runtime: string | null | undefined): string {
  if (!runtime) return "";
  // runtime comes as "HH:MM:SS" or "MM:SS" from mediaInfo
  const parts = runtime.split(":").map(Number);
  if (parts.length === 3) {
    const [h, m] = parts;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  if (parts.length === 2) {
    const [m] = parts;
    return `${m}m`;
  }
  return runtime;
}

export function EpisodeBrowser({
  seasons,
  selectedSeason,
  onSeasonChange,
  currentEpisodeId,
  onPlayEpisode,
  onDeleteEpisode,
  onSearchEpisode,
  searchingEpisodeId,
}: EpisodeBrowserProps) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const currentSeason = seasons.find((s) => s.seasonNumber === selectedSeason);
  const [optimizingSeason, setOptimizingSeason] = useState(false);
  const [optimizingEp, setOptimizingEp] = useState<number | null>(null);

  // Poll optimization jobs for episode progress
  const { data: jobsData, mutate: mutateJobs } = useSWR<{ jobs: Array<{ sourcePath: string; status: string; progress: number }> }>(
    `${getDirectCoreUrl()}/api/optimization/jobs?status=running,queued,completed`,
    (url: string) => fetch(url, { credentials: "include" }).then(r => r.json()),
    { refreshInterval: 3000 },
  );

  const jobByBasename = useMemo(() => {
    const map = new Map<string, { status: string; progress: number }>();
    for (const j of jobsData?.jobs ?? []) {
      const name = j.sourcePath.split("/").pop()?.toLowerCase() ?? "";
      const stem = name.lastIndexOf(".") > 0 ? name.substring(0, name.lastIndexOf(".")) : name;
      map.set(stem, { status: j.status, progress: j.progress });
    }
    return map;
  }, [jobsData]);

  // Count episodes that need optimization in current season
  const needsOptEpisodes = useMemo(() => {
    if (!currentSeason) return [];
    return currentSeason.episodes.filter(ep =>
      episodeNeedsOpt(ep) && !jobByBasename.has(stemOf(ep.filePath!))
    );
  }, [currentSeason, jobByBasename]);

  // Auto-scroll to currently playing episode
  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [currentEpisodeId]);

  const optimizeEpisode = async (ep: EpisodeData) => {
    if (!ep.filePath) return;
    setOptimizingEp(ep.id);
    try {
      const res = await fetch(`${getDirectCoreUrl()}/api/optimization/queue`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: [ep.filePath] }),
      });
      if (res.ok) void mutateJobs();
    } catch { /* ignore */ }
    finally { setOptimizingEp(null); }
  };

  const optimizeSeason = async () => {
    const paths = needsOptEpisodes.map(ep => ep.filePath).filter(Boolean) as string[];
    if (paths.length === 0) return;
    setOptimizingSeason(true);
    try {
      const res = await fetch(`${getDirectCoreUrl()}/api/optimization/queue`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths }),
      });
      if (res.ok) {
        void mutateJobs();
        toast(`${paths.length} episodes queued for conversion`);
      }
    } catch { toast.error("Failed to queue episodes"); }
    finally { setOptimizingSeason(false); }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Season selector */}
      <div className="flex items-center justify-between gap-3">
        {seasons.length > 1 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none flex-1 min-w-0">
            {seasons.map((s) => (
              <button
                key={s.seasonNumber}
                type="button"
                onClick={() => onSeasonChange(s.seasonNumber)}
                className={cn(
                  "shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition-colors",
                  s.seasonNumber === selectedSeason
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/40",
                )}
              >
                S{s.seasonNumber}
              </button>
            ))}
          </div>
        )}
        {needsOptEpisodes.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 shrink-0 text-xs h-7"
            disabled={optimizingSeason}
            onClick={() => void optimizeSeason()}
          >
            {optimizingSeason ? <Spinner className="h-3 w-3" /> : null}
            {optimizingSeason ? "Queuing..." : `Optimize ${needsOptEpisodes.length} episodes`}
          </Button>
        )}
      </div>

      {/* Episode list */}
      {currentSeason && (
        <ScrollArea className="max-h-[400px]">
          <div className="flex flex-col">
            {currentSeason.episodes.map((ep) => {
              const isPlaying = ep.id === currentEpisodeId;
              const isUnaired = ep.airDateUtc ? new Date(ep.airDateUtc) > new Date() : !ep.hasFile && !ep.monitored;
              const isAvailable = ep.hasFile && !!ep.filePath;
              const epStem = ep.filePath ? stemOf(ep.filePath) : null;
              const epJob = epStem ? jobByBasename.get(epStem) : undefined;
              const needsOpt = isAvailable && episodeNeedsOpt(ep) && !epJob;

              const isSearching = ep.id === searchingEpisodeId;

              return (
                <button
                  key={ep.id}
                  ref={isPlaying ? activeRef : undefined}
                  type="button"
                  disabled={!isAvailable && !onSearchEpisode}
                  onClick={() => isAvailable ? onPlayEpisode(ep) : onSearchEpisode?.(ep, currentSeason!.seasonNumber)}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 text-left transition-colors group",
                    isPlaying && "bg-muted/20 border-l-2 border-foreground",
                    isSearching && !isPlaying && "bg-primary/5 border-l-2 border-primary/40",
                    !isPlaying && !isSearching && "border-l-2 border-transparent",
                    isAvailable && !isPlaying && "hover:bg-muted/10",
                    !isAvailable && onSearchEpisode && "opacity-60 cursor-pointer hover:opacity-80 hover:bg-muted/10",
                    !isAvailable && !onSearchEpisode && "opacity-35 cursor-default",
                  )}
                >
                  {/* Episode number */}
                  <span className="text-sm text-muted-foreground tabular-nums w-6 shrink-0 text-right">
                    {ep.episodeNumber}
                  </span>

                  {/* Title */}
                  <span className={cn(
                    "text-sm truncate flex-1 min-w-0",
                    isPlaying && "font-medium",
                  )}>
                    {ep.title || `Episode ${ep.episodeNumber}`}
                  </span>

                  {/* Quality badge — color-coded by container format */}
                  {ep.quality && (
                    <span className={cn(
                      "text-xs shrink-0",
                      episodeNeedsOpt(ep)
                        ? "text-status-warning/60"
                        : "text-muted-foreground"
                    )}>
                      {ep.quality}
                    </span>
                  )}

                  {/* Optimization status */}
                  {epJob?.status === "running" && (
                    <span className="text-xs text-status-warning tabular-nums shrink-0">
                      {Math.round(epJob.progress * 100)}%
                    </span>
                  )}
                  {epJob?.status === "queued" && (
                    <span className="text-xs text-muted-foreground shrink-0">queued</span>
                  )}
                  {epJob?.status === "completed" && (
                    <span className="text-xs text-status-healthy shrink-0">MP4</span>
                  )}

                  {/* Optimize button (on hover, only for non-optimal episodes) */}
                  {needsOpt && (
                    <span
                      role="button"
                      tabIndex={0}
                      className="shrink-0 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity text-xs text-muted-foreground hover:text-foreground"
                      onClick={(e) => { e.stopPropagation(); void optimizeEpisode(ep); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); void optimizeEpisode(ep); } }}
                    >
                      {optimizingEp === ep.id ? "..." : "Optimize"}
                    </span>
                  )}

                  {/* Runtime */}
                  {ep.runtime && (
                    <span className="text-xs text-dim-foreground tabular-nums shrink-0">
                      {formatRuntime(ep.runtime)}
                    </span>
                  )}

                  {/* Play icon */}
                  {isAvailable && !needsOpt && !epJob && (
                    <span className={cn(
                      "shrink-0 transition-opacity",
                      isPlaying ? "opacity-100" : "opacity-0 group-hover:opacity-60",
                    )}>
                      <HugeiconsIcon icon={PlayIcon} size={14} />
                    </span>
                  )}

                  {/* Delete button */}
                  {isAvailable && onDeleteEpisode && (
                    <span
                      role="button"
                      tabIndex={0}
                      className="shrink-0 opacity-0 group-hover:opacity-40 hover:!opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                      onClick={(e) => { e.stopPropagation(); onDeleteEpisode(ep); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onDeleteEpisode(ep); } }}
                    >
                      <HugeiconsIcon icon={Delete01Icon} size={12} />
                    </span>
                  )}

                  {/* Search icon — always visible for missing, on hover for available */}
                  {onSearchEpisode && !isUnaired && (
                    <span
                      role="button"
                      tabIndex={0}
                      className={cn(
                        "shrink-0 transition-opacity",
                        !isAvailable
                          ? "opacity-70 hover:opacity-100 text-muted-foreground hover:text-foreground"
                          : "opacity-0 group-hover:opacity-50 hover:!opacity-100 text-muted-foreground hover:text-foreground",
                        isSearching && "!opacity-100 text-foreground",
                      )}
                      onClick={(e) => { e.stopPropagation(); onSearchEpisode(ep, currentSeason!.seasonNumber); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onSearchEpisode(ep, currentSeason!.seasonNumber); } }}
                    >
                      <HugeiconsIcon icon={Search01Icon} size={12} />
                    </span>
                  )}

                  {/* Status dot for unavailable (only when no search available) */}
                  {!isAvailable && !isUnaired && !onSearchEpisode && (
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/20 shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function stemOf(p: string): string {
  const name = p.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.substring(0, dot).toLowerCase() : name.toLowerCase();
}
