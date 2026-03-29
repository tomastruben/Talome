"use client";

import Image from "next/image";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSetAtom } from "jotai";
import { pageTitleAtom } from "@/atoms/page-title";
import { pageBackAtom } from "@/atoms/page-back";
import { CORE_URL, getDirectCoreUrl, resolvePosterUrl, resolveBackdropUrl } from "@/lib/constants";
import { VideoPlayer } from "@/components/files/media-player";
import { EpisodeBrowser } from "@/components/media/episode-browser";
import {
  type MediaItem,
  type SeasonData,
  type EpisodeData,
  type LibraryData,
  formatSize,
  deriveContainerFromPath,
} from "@/components/media/media-detail-sheet";
import { QUALITY_TIERS, matchProfile } from "@talome/types";
import { ReleaseSearchPanel } from "@/components/media/release-search-panel";
import { useMediaManagement, type SearchTarget } from "@/hooks/use-media-management";
import {
  HugeiconsIcon,
  PlayIcon,
  Tv01Icon,
  Film01Icon,
  StarIcon,
  Delete01Icon,
  ArrowDown01Icon,
  Download01Icon,
  Tick01Icon,
  Cancel01Icon,
  PlayListRemoveIcon,
  SearchReplaceIcon,
} from "@/components/icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAssistant } from "@/components/assistant/assistant-context";
import { cn } from "@/lib/utils";
import useSWR from "swr";
import type { DownloadQueueItem } from "@talome/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRuntime(runtime: string | null | undefined): string {
  if (!runtime) return "";
  const parts = runtime.split(":").map(Number);
  if (parts.length === 3) {
    const [h, m] = parts;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  return runtime;
}

function formatRuntimeMinutes(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return "—";
  const mbps = bytesPerSec / 1048576;
  return mbps >= 1 ? `${mbps.toFixed(1)} MB/s` : `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
}

function formatEta(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0 || seconds > 86400 * 7) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ── Format badge (optimization-aware) ────────────────────────────────────────

function FormatBadge({ format, filePath }: { format: string | null | undefined; filePath?: string | null }) {
  const [optimizing, setOptimizing] = useState(false);
  const { openPaletteInChatMode } = useAssistant();

  // Poll optimization jobs to detect completed conversions
  const { data: jobsData, mutate: mutateJobs } = useSWR<{ jobs: Array<{ id: string; sourcePath: string; status: string; progress: number; priority: number; error: string | null }> }>(
    filePath ? `${getDirectCoreUrl()}/api/optimization/jobs` : null,
    (url: string) => fetch(url, { credentials: "include" }).then(r => r.json()),
    { refreshInterval: 3000 },
  );
  const fileBasename = filePath?.split("/").pop()?.toLowerCase() ?? null;
  const fileJob = jobsData?.jobs?.find((j) => {
    if (j.status !== "running" && j.status !== "queued" && j.status !== "completed" && j.status !== "failed") return false;
    if (j.sourcePath === filePath) return true;
    const jobBasename = j.sourcePath?.split("/").pop()?.toLowerCase();
    return !!(jobBasename && fileBasename && jobBasename === fileBasename);
  });

  const handleOptimize = async () => {
    if (!filePath || optimizing) return;
    setOptimizing(true);
    try {
      const res = await fetch(`${getDirectCoreUrl()}/api/optimization/queue`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: [filePath], priority: 10 }),
      });
      if (res.ok) {
        toast.success("Conversion queued");
        void mutateJobs();
      } else {
        toast.error("Failed to queue conversion");
      }
    } catch {
      toast.error("Failed to queue conversion");
    } finally { setOptimizing(false); }
  };

  // Show conversion progress
  if (fileJob?.status === "running") {
    return (
      <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-status-warning/10 text-status-warning tabular-nums">
        MP4 {Math.round(fileJob.progress * 100)}%
      </span>
    );
  }
  if (fileJob?.status === "queued") {
    return (
      <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
        Queued
      </span>
    );
  }
  if (fileJob?.status === "failed") {
    const filename = filePath?.split("/").pop() ?? "this file";
    const errorLine = fileJob.error?.split("\n")[0] ?? "unknown error";
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-status-critical/10 text-status-critical">
          Failed
        </span>
        <button
          onClick={() => openPaletteInChatMode(`The optimization of ${filename} failed with: ${errorLine}. Can you diagnose and fix this?`)}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Ask Talome
        </button>
      </span>
    );
  }
  if (fileJob?.status === "completed") {
    return (
      <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-status-healthy/10 text-status-healthy">
        MP4
      </span>
    );
  }

  if (!format) return null;
  const upper = format.toUpperCase();
  const isMp4 = upper === "MP4" || upper === "M4V";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn(
        "text-xs font-medium px-1.5 py-0.5 rounded",
        isMp4 ? "bg-status-healthy/10 text-status-healthy" : "bg-status-warning/10 text-status-warning"
      )}>
        {upper}
      </span>
      {!isMp4 && filePath && (
        <button
          onClick={handleOptimize}
          disabled={optimizing}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {optimizing ? "Queuing..." : "Convert to MP4"}
        </button>
      )}
    </span>
  );
}

// ── Download progress ────────────────────────────────────────────────────────

function DownloadProgressCard({
  item,
  onRemove,
}: {
  item: DownloadQueueItem;
  onRemove?: (id: number) => void;
}) {
  const pct = Math.round((item.progress ?? 0) * 100);
  const isActive = item.status === "downloading" || (item.dlspeed ?? 0) > 0;
  const isFailed = item.status === "failed" || item.status === "warning";
  const isCompleted = item.status === "completed" || pct >= 100;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium truncate">{item.title}</p>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={cn(
            "text-xs tabular-nums",
            isFailed ? "text-destructive" : isCompleted ? "text-status-healthy" : "text-muted-foreground",
          )}>
            {isFailed ? "Failed" : isCompleted ? "Complete" : `${pct}%`}
          </span>
          {onRemove && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded text-dim-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  onClick={() => onRemove(item.id)}
                  aria-label="Remove from queue"
                >
                  <HugeiconsIcon icon={Delete01Icon} size={12} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">Remove from queue</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      <Progress
        value={pct}
        className={cn(
          "h-1",
          isFailed && "[&>[data-slot=progress-indicator]]:bg-destructive",
          isCompleted && "[&>[data-slot=progress-indicator]]:bg-status-healthy",
        )}
      />

      {isActive && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <HugeiconsIcon icon={ArrowDown01Icon} size={10} />
            {formatSpeed(item.dlspeed ?? 0)}
          </span>
          <span>ETA {formatEta(item.eta)}</span>
          {item.size > 0 && (
            <span className="ml-auto">{formatSize(item.size - (item.sizeleft ?? 0))} / {formatSize(item.size)}</span>
          )}
        </div>
      )}

      {isFailed && item.errorMessage && (
        <p className="text-xs text-destructive/80">{item.errorMessage}</p>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MediaDetailPage() {
  const params = useParams<{ type: string; id: string }>();
  const router = useRouter();
  const type = params.type as "movie" | "tv";
  const id = Number(params.id);

  const setPageTitle = useSetAtom(pageTitleAtom);
  const setPageBack = useSetAtom(pageBackAtom);

  const [item, setItem] = useState<MediaItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [seasons, setSeasons] = useState<SeasonData[] | null>(null);
  const [selectedSeason, setSelectedSeason] = useState(1);

  // Player state
  const [playingFilePath, setPlayingFilePath] = useState<string | null>(null);
  const [playingEpisodeId, setPlayingEpisodeId] = useState<number | null>(null);
  const [playingFileName, setPlayingFileName] = useState("");

  // Pre-fetched quality options from Jellyfin (before playback starts)
  const [preQuality, setPreQuality] = useState<{
    qualities: Array<{ label: string; height: number; bitrate: number }>;
    hasDirectPlay: boolean;
  } | null>(null);
  const [selectedPreQuality, setSelectedPreQuality] = useState<string>("original");

  // Fetch Jellyfin quality options when item loads
  useEffect(() => {
    if (!item?.filePath || type !== "movie") return;
    let cancelled = false;
    const api = `${getDirectCoreUrl()}/api/media`;
    void (async () => {
      try {
        const res = await fetch(`${api}/jellyfin-playback`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: item.filePath }),
        });
        if (!res.ok || cancelled) return;
        const jf = await res.json();
        if (cancelled) return;
        if (jf.available) {
          setPreQuality({
            qualities: jf.transcodeQualities ?? [],
            hasDirectPlay: !!jf.directPlayUrl,
          });
        } else {
          // Jellyfin doesn't have this file — offer direct + local HLS
          setPreQuality({ qualities: [], hasDirectPlay: true });
        }
      } catch {
        // Jellyfin unreachable — offer direct + local HLS
        setPreQuality({ qualities: [], hasDirectPlay: true });
      }
    })();
    return () => { cancelled = true; };
  }, [item?.filePath, type]);

  // Auto-advance countdown
  const [nextCountdown, setNextCountdown] = useState<number | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval>>(null);
  const [imgFailed, setImgFailed] = useState(false);

  // Delete file dialog
  const [deleteTarget, setDeleteTarget] = useState<{ type: "movie" | "episode"; id: number; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Remove from library dialog
  const [showRemoveDialog, setShowRemoveDialog] = useState(false);
  const [removeDeleteFiles, setRemoveDeleteFiles] = useState(false);
  const [removeExcludeImport, setRemoveExcludeImport] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Inline management (replaces the old drawer)
  const mgmt = useMediaManagement(item);

  // Show acquisition controls only when needed
  const [showReplace, setShowReplace] = useState(false);
  const hasFile = type === "movie" ? !!item?.hasFile : false;
  const isDownloading = mgmt.activeDownloads.length > 0;
  const showAcquisition = !hasFile || isDownloading || showReplace;
  const releasePanelRef = useRef<HTMLDivElement>(null);

  // Episode → release search: one tap to scope + search + scroll
  const handleSearchEpisode = useCallback((ep: EpisodeData, seasonNumber: number) => {
    mgmt.selectSearchTarget({
      scope: "episode",
      seasonNumber,
      episodeNumber: ep.episodeNumber,
      episodeId: ep.id,
    });
  }, [mgmt]);

  // Auto-trigger search + scroll when an episode is targeted
  const prevEpisodeTarget = useRef<number | null>(null);
  useEffect(() => {
    if (mgmt.searchTarget.scope !== "episode") { prevEpisodeTarget.current = null; return; }
    const epId = mgmt.searchTarget.episodeId;
    if (epId === prevEpisodeTarget.current) return;
    prevEpisodeTarget.current = epId;
    mgmt.searchReleases();
    releasePanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mgmt.searchTarget]);

  const baseUrl = getDirectCoreUrl();
  const mediaApiBase = `${baseUrl}/api/media`;

  // Set page title + back button in the site header
  const backPath = type === "tv" ? "/dashboard/media?tab=tv" : "/dashboard/media";
  useEffect(() => {
    if (item) {
      setPageTitle(item.title);
      setPageBack(() => () => router.push(backPath));
    }
    return () => { setPageTitle(null); setPageBack(null); };
  }, [item, setPageTitle, setPageBack, router, backPath]);

  // Fetch media item from library
  useEffect(() => {
    setLoading(true);
    fetch(`${CORE_URL}/api/media/library`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: LibraryData) => {
        const list = type === "tv" ? data.tv : data.movies;
        const found = list.find((m) => m.id === id) ?? null;
        setItem(found);
      })
      .catch(() => setItem(null))
      .finally(() => setLoading(false));
  }, [type, id]);

  // Fetch episodes for TV shows
  useEffect(() => {
    if (type !== "tv" || !id) return;
    fetch(`${CORE_URL}/api/media/episodes?seriesId=${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        const s = (data.seasons ?? []) as SeasonData[];
        setSeasons(s);
        if (s.length > 0) setSelectedSeason(s[0].seasonNumber);
      })
      .catch(() => setSeasons(null));
  }, [type, id]);

  // Default search target for single-season shows
  useEffect(() => {
    if (type === "tv" && seasons && seasons.length === 1) {
      mgmt.selectSearchTarget({ scope: "season", seasonNumber: seasons[0].seasonNumber });
    }
  }, [seasons, type]);

  // Find next playable episode for auto-advance
  const nextEpisode = useMemo(() => {
    if (!seasons || !playingEpisodeId) return null;
    const allEps = seasons.flatMap((s) => s.episodes);
    const idx = allEps.findIndex((e) => e.id === playingEpisodeId);
    if (idx < 0) return null;
    for (let i = idx + 1; i < allEps.length; i++) {
      if (allEps[i].hasFile && allEps[i].filePath) return allEps[i];
    }
    return null;
  }, [seasons, playingEpisodeId]);

  const playEpisode = useCallback((ep: EpisodeData) => {
    if (!ep.filePath) return;
    if (countdownRef.current) clearInterval(countdownRef.current);
    setNextCountdown(null);
    setPlayingFilePath(ep.filePath);
    setPlayingEpisodeId(ep.id);
    setPlayingFileName(ep.filePath.split("/").pop() ?? "");
    if (seasons) {
      const s = seasons.find((s) => s.episodes.some((e) => e.id === ep.id));
      if (s) setSelectedSeason(s.seasonNumber);
    }
  }, [seasons]);

  const playMovie = useCallback(() => {
    if (!item?.filePath) return;
    setPlayingFilePath(item.filePath);
    setPlayingFileName(item.filePath.split("/").pop() ?? "");
  }, [item]);

  const handleVideoEnded = useCallback(() => {
    if (!nextEpisode) return;
    setNextCountdown(8);
    const interval = setInterval(() => {
      setNextCountdown((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval);
          playEpisode(nextEpisode);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    countdownRef.current = interval;
  }, [nextEpisode, playEpisode]);

  const cancelAutoAdvance = useCallback(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    setNextCountdown(null);
  }, []);

  // Delete file via arr API
  const handleDelete = useCallback(async () => {
    if (!deleteTarget || !item) return;
    setDeleting(true);
    try {
      if (deleteTarget.type === "movie") {
        const res = await fetch(`${CORE_URL}/api/media/movie-file/${item.id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Failed to delete");
      } else {
        const res = await fetch(`${CORE_URL}/api/media/episode-file/${deleteTarget.id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Failed to delete");
      }
      if (playingFilePath) {
        setPlayingFilePath(null);
        setPlayingEpisodeId(null);
      }
      if (type === "movie") {
        setItem((prev) => prev ? { ...prev, hasFile: false, filePath: null } : null);
      } else {
        const epRes = await fetch(`${CORE_URL}/api/media/episodes?seriesId=${id}`);
        if (epRes.ok) {
          const data = await epRes.json();
          setSeasons((data.seasons ?? []) as SeasonData[]);
        }
      }
    } catch {
      toast.error("Failed to delete file");
    }
    setDeleting(false);
    setDeleteTarget(null);
  }, [deleteTarget, item, type, id, playingFilePath]);

  // Remove entire entry from Sonarr/Radarr
  const handleRemoveFromLibrary = useCallback(async () => {
    if (!item) return;
    setRemoving(true);
    try {
      const endpoint = type === "movie"
        ? `${CORE_URL}/api/media/movie/${item.id}`
        : `${CORE_URL}/api/media/series/${item.id}`;
      const params = new URLSearchParams();
      if (removeDeleteFiles) params.set("deleteFiles", "true");
      if (removeExcludeImport) params.set("addImportExclusion", "true");
      const res = await fetch(`${endpoint}?${params}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.success(`Removed "${item.title}" from library`);
      router.replace("/dashboard/media");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to remove from library");
      setRemoving(false);
      setShowRemoveDialog(false);
    }
  }, [item, type, removeDeleteFiles, removeExcludeImport, router]);

  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="aspect-video w-full rounded-lg" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (!item) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-12 min-h-[60vh]">
        <p className="text-muted-foreground">Media not found</p>
        <Button variant="ghost" onClick={() => router.push(backPath)}>
          Back to library
        </Button>
      </div>
    );
  }

  const streamSrc = playingFilePath
    ? `${mediaApiBase}/stream?path=${encodeURIComponent(playingFilePath)}`
    : null;
  const canPlay = type === "movie" ? !!item.filePath : false;

  return (
    <div className="flex flex-col gap-6">
      {/* Player area */}
      <div className="relative rounded-lg overflow-hidden bg-black aspect-video">
        {streamSrc && playingFilePath ? (
          <>
            <VideoPlayer
              src={streamSrc}
              fileName={playingFileName}
              filePath={playingFilePath}
              apiBase={mediaApiBase}
              onEnded={handleVideoEnded}
              preferOriginal={selectedPreQuality === "original"}
            />

            {/* Auto-advance overlay */}
            {nextCountdown !== null && nextEpisode && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-20">
                <div className="flex flex-col items-center gap-4 text-center">
                  <p className="text-sm text-muted-foreground">Next episode in</p>
                  <p className="text-2xl font-medium tabular-nums">{nextCountdown}</p>
                  <p className="text-sm font-medium truncate max-w-[300px]">
                    {nextEpisode.title || `Episode ${nextEpisode.episodeNumber}`}
                  </p>
                  <div className="flex items-center gap-3 mt-2">
                    <Button variant="ghost" size="sm" onClick={cancelAutoAdvance} className="text-muted-foreground">
                      Cancel
                    </Button>
                    <Button size="sm" onClick={() => playEpisode(nextEpisode)}>
                      Play now
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="absolute inset-0">
            {/* Backdrop or poster-blur background */}
            {resolveBackdropUrl(item.backdrop, 1280) && !imgFailed ? (
              <Image
                src={resolveBackdropUrl(item.backdrop, 1280)!}
                alt=""
                className="object-cover"
                fill
                priority
                sizes="100vw"
                onError={() => setImgFailed(true)}
              />
            ) : item.poster && !imgFailed ? (
              <Image
                src={resolvePosterUrl(item.poster, 240) ?? ""}
                alt=""
                className="object-cover opacity-15 blur-2xl scale-110"
                fill
                priority
                sizes="100vw"
                onError={() => setImgFailed(true)}
              />
            ) : null}

            {/* Gradient overlays */}
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/50 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-r from-black/60 via-transparent to-transparent" />

            {/* Quality — top right, quiet until tapped */}
            {preQuality && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="absolute z-10 top-3 right-3 px-2 py-0.5 rounded bg-black/40 backdrop-blur-sm text-[11px] text-white/50 hover:text-white/80 transition-colors tabular-nums tracking-wide">
                    {selectedPreQuality === "original"
                      ? "Original"
                      : selectedPreQuality === "local"
                        ? "Local"
                        : selectedPreQuality}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={4} className="min-w-36">
                  <DropdownMenuRadioGroup value={selectedPreQuality} onValueChange={setSelectedPreQuality}>
                    {preQuality.hasDirectPlay && (
                      <DropdownMenuRadioItem value="original">Original</DropdownMenuRadioItem>
                    )}
                    {preQuality.qualities.map((q) => (
                      <DropdownMenuRadioItem key={q.label} value={q.label}>
                        {q.label}
                        <span className="ml-1.5 text-muted-foreground">{(q.bitrate / 1_000_000).toFixed(0)} Mbps</span>
                      </DropdownMenuRadioItem>
                    ))}
                    <DropdownMenuRadioItem value="local">
                      Local
                      <span className="ml-1.5 text-muted-foreground">Talome</span>
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Play button — bottom right */}
            {canPlay && (
              <button
                type="button"
                onClick={playMovie}
                className="absolute z-10 right-4 bottom-4 lg:right-6 lg:bottom-6 shrink-0 flex items-center justify-center w-14 h-14 lg:w-16 lg:h-16 rounded-full bg-white/10 backdrop-blur-sm hover:bg-white/20 transition-colors"
              >
                <HugeiconsIcon icon={PlayIcon} size={24} className="text-white ml-0.5" />
              </button>
            )}
            {!canPlay && type === "tv" && (
              <div className="absolute z-10 right-4 bottom-4 lg:right-6 lg:bottom-6 shrink-0 flex flex-col items-center gap-1 text-muted-foreground">
                <HugeiconsIcon icon={Tv01Icon} size={24} className="opacity-60" />
                <p className="text-xs opacity-70">Select episode</p>
              </div>
            )}

            {/* Bottom metadata overlay — minimal on mobile, richer on desktop */}
            <div className="absolute bottom-0 left-0 right-0 p-4 lg:p-6 pr-20 lg:pr-24">
              <h2 className="text-lg lg:text-2xl font-medium text-white mb-1.5 lg:mb-2 line-clamp-2 lg:line-clamp-1">{item.title}</h2>
              <div className="flex items-center gap-1.5 lg:gap-2 flex-wrap">
                {item.rating != null && item.rating > 0 && (
                  <span className="flex items-center gap-1 text-xs lg:text-sm text-amber-400">
                    <HugeiconsIcon icon={StarIcon} size={12} />
                    {item.rating.toFixed(1)}
                  </span>
                )}
                {item.year && <span className="text-xs lg:text-sm text-white/80">{item.year}</span>}
                {item.runtime && (
                  <span className="text-xs lg:text-sm text-white/70">{formatRuntimeMinutes(item.runtime)}</span>
                )}
                {(item.studio || item.network) && (
                  <span className="hidden lg:inline text-sm text-white/70">{item.studio || item.network}</span>
                )}
                {item.genres && item.genres.length > 0 && (
                  <span className="hidden lg:inline text-sm text-white/60">{item.genres.slice(0, 3).join(" · ")}</span>
                )}
              </div>
              {/* Overview: hidden on narrow containers (shown below hero instead), visible when wide enough */}
              {item.overview && (
                <p className="hidden lg:block text-sm text-white/70 mt-2 line-clamp-2 max-w-[60%] leading-relaxed">{item.overview}</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Mobile overview — lives below the hero with room to breathe */}
      {item.overview && (
        <MobileOverview item={item} type={type} />
      )}

      {/* File info + actions — right after overview, before content */}
      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground -mt-2">
        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
          {item.quality?.name && <span className="truncate">{item.quality.name}</span>}
          {item.quality?.codec && (
            <>
              <span className="text-dim-foreground shrink-0">·</span>
              <span className="shrink-0">{item.quality.codec}</span>
            </>
          )}
          {item.quality?.audioCodec && (
            <>
              <span className="text-dim-foreground shrink-0">·</span>
              <span className="shrink-0">{item.quality.audioCodec}</span>
            </>
          )}
          {(item.sizeOnDisk ?? 0) > 0 && (
            <>
              <span className="text-dim-foreground shrink-0">·</span>
              <span className="shrink-0 tabular-nums">{formatSize(item.sizeOnDisk!)}</span>
            </>
          )}
          {(item.quality?.container || item.filePath) && (
            <>
              <span className="text-dim-foreground shrink-0">·</span>
              <FormatBadge format={item.quality?.container ?? deriveContainerFromPath(item.filePath)} filePath={item.filePath} />
            </>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {hasFile && !isDownloading && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn("h-7 w-7", showReplace ? "text-foreground" : "text-dim-foreground hover:text-muted-foreground")}
                  onClick={() => setShowReplace((v) => !v)}
                >
                  <HugeiconsIcon icon={SearchReplaceIcon} size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{showReplace ? "Hide upgrade options" : "Replace file"}</TooltipContent>
            </Tooltip>
          )}
          {type === "movie" && item.filePath && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-dim-foreground hover:text-destructive"
                  onClick={() => setDeleteTarget({ type: "movie", id: item.id, title: item.title })}
                >
                  <HugeiconsIcon icon={Delete01Icon} size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete file</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-dim-foreground hover:text-destructive"
                onClick={() => setShowRemoveDialog(true)}
              >
                <HugeiconsIcon icon={PlayListRemoveIcon} size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Remove from library</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Episodes (TV only) */}
      {type === "tv" && seasons && (
        <EpisodeBrowser
          seasons={seasons}
          selectedSeason={selectedSeason}
          onSeasonChange={setSelectedSeason}
          currentEpisodeId={playingEpisodeId}
          onPlayEpisode={playEpisode}
          onDeleteEpisode={(ep) => setDeleteTarget({ type: "episode", id: ep.id, title: ep.title })}
          onSearchEpisode={handleSearchEpisode}
          searchingEpisodeId={mgmt.searchTarget.scope === "episode" ? mgmt.searchTarget.episodeId : null}
        />
      )}

      {/* ── Acquisition: Quality + Releases + Downloads ─────────────── */}
      {showAcquisition && (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <p className="text-xs text-muted-foreground shrink-0">Quality</p>
              <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">
                {mgmt.applyState === "loading" ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <HugeiconsIcon
                    icon={Tick01Icon}
                    size={14}
                    className={cn(
                      "text-status-healthy transition-opacity duration-150",
                      mgmt.applyState === "done" ? "opacity-100" : "opacity-0"
                    )}
                  />
                )}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {QUALITY_TIERS.map((tier) => {
                const resolved = matchProfile(mgmt.qualityProfiles, tier.id);
                const isActive = !mgmt.isManualProfile && mgmt.qualityTier === tier.id;
                return (
                  <button
                    key={tier.id}
                    type="button"
                    onClick={() => {
                      mgmt.setQualityTier(tier.id);
                      mgmt.applyQualityProfile(String(resolved.profileId));
                    }}
                    disabled={mgmt.qualityProfiles.length === 0 || mgmt.applyState === "loading"}
                    className={cn(
                      "flex flex-col items-center gap-0.5 rounded-lg px-3 py-2 transition-colors",
                      isActive
                        ? "bg-muted text-foreground"
                        : mgmt.isManualProfile
                        ? "text-dim-foreground hover:text-muted-foreground hover:bg-muted/10"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/20"
                    )}
                  >
                    <span className="text-xs font-medium">{tier.label}</span>
                    <span className="text-[10px] text-muted-foreground">{tier.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>
          {mgmt.applyError && <p className="text-xs text-destructive">{mgmt.applyError}</p>}

          <div ref={releasePanelRef}>
            <ReleaseSearchPanel
              loading={mgmt.releaseLoading}
              error={mgmt.releaseError}
              releases={mgmt.releases}
              submittingTitle={mgmt.grabbingTitle}
              submittedTitles={mgmt.grabbedTitles}
              queueByTitle={mgmt.queueByTitle}
              onSearch={mgmt.searchReleases}
              onGrab={mgmt.grabRelease}
              searchLabel={mgmt.searchLabel}
              onClearFilter={mgmt.searchTarget.scope !== "series" ? () => mgmt.selectSearchTarget({ scope: "series" }) : undefined}
              totalFromIndexer={mgmt.totalFromIndexer}
              preferMp4={mgmt.preferMp4}
              onToggleMp4={mgmt.setPreferMp4}
              showAll={mgmt.showAllReleases}
              onShowAll={mgmt.showAll}
            />
          </div>

          {/* Active downloads — collapsible below releases */}
          {mgmt.activeDownloads.length > 0 && (
            <details open className="group">
              <summary className="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground select-none list-none [&::-webkit-details-marker]:hidden">
                <HugeiconsIcon icon={Download01Icon} size={12} />
                <span>{mgmt.activeDownloads.length} active download{mgmt.activeDownloads.length > 1 ? "s" : ""}</span>
                <span className="text-dim-foreground group-open:rotate-180 transition-transform duration-150">▾</span>
              </summary>
              <div className="space-y-3 mt-3">
                {mgmt.activeDownloads.map((dl) => (
                  <DownloadProgressCard key={dl.id} item={dl} onRemove={mgmt.removeFromQueue} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* ── More like this ────────────────────────────────────────── */}
      <RelatedRail type={type} id={item.id} />

      {/* Delete file confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete file</DialogTitle>
            <DialogDescription>
              This will delete the media file from disk and mark it as missing in {type === "movie" ? "Radarr" : "Sonarr"}.
              The item will remain in your library for re-download.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? <Spinner className="size-3.5" /> : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove from library confirmation dialog */}
      <Dialog
        open={showRemoveDialog}
        onOpenChange={(open) => {
          if (!open && !removing) {
            setShowRemoveDialog(false);
            setRemoveDeleteFiles(false);
            setRemoveExcludeImport(false);
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remove from library</DialogTitle>
            <DialogDescription>
              This will remove &ldquo;{item.title}&rdquo; from {type === "movie" ? "Radarr" : "Sonarr"}.
              It will no longer appear in your library.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-1">
            <label className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Delete files from disk</p>
                <p className="text-xs text-muted-foreground">Permanently remove media files from disk</p>
              </div>
              <Switch checked={removeDeleteFiles} onCheckedChange={setRemoveDeleteFiles} />
            </label>
            <label className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Prevent re-import</p>
                <p className="text-xs text-muted-foreground">Add to exclusion list so it won&apos;t be re-added automatically</p>
              </div>
              <Switch checked={removeExcludeImport} onCheckedChange={setRemoveExcludeImport} />
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowRemoveDialog(false)} disabled={removing}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRemoveFromLibrary} disabled={removing}>
              {removing ? <Spinner className="size-3.5" /> : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Scope button for TV search targeting ─────────────────────────────────────

// ── Mobile overview — the story below the hero ───────────────────────────────

function MobileOverview({ item, type }: { item: MediaItem; type: "movie" | "tv" }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const [isClamped, setIsClamped] = useState(false);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    // Check if the text is actually truncated
    setIsClamped(el.scrollHeight > el.clientHeight + 2);
  }, [item.overview]);

  return (
    <div className="lg:hidden -mt-2 space-y-3">
      {/* Overview text — tap to expand */}
      <div>
        <p
          ref={textRef}
          className={cn(
            "text-sm text-muted-foreground leading-relaxed transition-all duration-150",
            !expanded && "line-clamp-3",
          )}
        >
          {item.overview}
        </p>
        {isClamped && !expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="text-xs text-muted-foreground mt-1"
          >
            more
          </button>
        )}
      </div>

      {/* Studio/network + genre pills */}
      <div className="flex items-center gap-2 flex-wrap">
        {(item.studio || item.network) && (
          <span className="text-xs text-muted-foreground">{item.studio || item.network}</span>
        )}
        {(item.genres?.length ?? 0) > 0 && item.genres!.slice(0, 4).map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => router.push(`/dashboard/media?tab=${type === "tv" ? "tv" : "movies"}&genre=${encodeURIComponent(g)}`)}
            className="text-xs border border-border/40 rounded-full px-2 py-0.5 text-muted-foreground active:bg-muted/40 transition-colors"
          >
            {g}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Shared metadata ───────────────────────────────────────────────────────────

const relatedFetcher = (url: string) => fetch(url).then((r) => r.json());

function RelatedRail({ type, id }: { type: string; id: number }) {
  const router = useRouter();
  const { data } = useSWR<{ results: MediaItem[] }>(
    `${CORE_URL}/api/media/related?type=${type}&id=${id}&limit=12`,
    relatedFetcher,
  );

  const items = data?.results;
  if (!items || items.length === 0) return null;

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">More like this</p>
      <div className="flex gap-3 overflow-x-auto scrollbar-none pb-2 snap-x snap-mandatory">
        {items.map((item) => {
          const poster = resolvePosterUrl(item.poster, 240);
          return (
            <button
              key={`${item.type}-${item.id}`}
              type="button"
              className="shrink-0 w-[120px] snap-start group text-left"
              onClick={() => router.push(`/dashboard/media/${item.type}/${item.id}`)}
            >
              <div className="relative aspect-[2/3] rounded-lg overflow-hidden bg-muted/40 mb-1.5">
                {poster ? (
                  <Image
                    src={poster}
                    alt={item.title}
                    fill
                    className="object-cover group-hover:scale-102 transition-transform duration-150"
                    sizes="120px"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <HugeiconsIcon
                      icon={item.type === "tv" ? Tv01Icon : Film01Icon}
                      size={20}
                      className="text-dim-foreground"
                    />
                  </div>
                )}
              </div>
              <p className="text-xs font-medium truncate">{item.title}</p>
              <p className="text-xs text-muted-foreground truncate">
                {item.year}
                {item.rating ? ` · ${item.rating.toFixed(1)}` : ""}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

