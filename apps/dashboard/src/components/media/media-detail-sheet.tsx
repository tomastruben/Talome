"use client";

import Image from "next/image";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import {
  HugeiconsIcon,
  Tv01Icon,
  Film01Icon,
  StarIcon,
  Download01Icon,
  Tick01Icon,
  ArrowDown01Icon,
  Delete01Icon,
} from "@/components/icons";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { CORE_URL, getDirectCoreUrl, resolvePosterUrl } from "@/lib/constants";
import { useIsMobile } from "@/hooks/use-mobile";
import { useDownloads } from "@/hooks/use-downloads";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { DownloadQueueItem } from "@talome/types";

// ── Shared types ──────────────────────────────────────────────────────────────

export interface MediaItem {
  id: number;
  title: string;
  year?: number;
  tmdbId?: number | null;
  tvdbId?: number | null;
  type: "movie" | "tv";
  poster?: string;
  backdrop?: string;
  hasFile?: boolean;
  filePath?: string | null;
  seasonCount?: number;
  episodeCount?: number;
  sizeOnDisk?: number;
  monitored?: boolean;
  status?: string;
  overview?: string;
  genres?: string[];
  rating?: number | null;
  network?: string | null;
  studio?: string | null;
  added?: string;
  runtime?: number | null;
  quality?: {
    name?: string | null;
    resolution?: number | null;
    codec?: string | null;
    audioCodec?: string | null;
    runtime?: string | null;
    container?: string | null;
  } | null;
}

// A lookup result for titles not yet in the library (from Radarr/Sonarr metadata search)
export interface LookupItem {
  tmdbId?: number | null;
  tvdbId?: number | null;
  title: string;
  year?: number | null;
  type: "movie" | "tv";
  poster?: string | null;
  overview?: string;
  genres?: string[];
  rating?: number | null;
  network?: string | null;
  studio?: string | null;
  runtime?: number | null;
  seasonCount?: number | null;
  inLibrary: false;
}

export interface LibraryData {
  tv: MediaItem[];
  movies: MediaItem[];
  totals: { tvShows: number; movies: number };
  sonarrAvailable?: boolean;
  radarrAvailable?: boolean;
}

export interface EpisodeData {
  id: number;
  episodeNumber: number;
  title: string;
  hasFile: boolean;
  monitored: boolean;
  airDateUtc: string | null;
  quality: string | null;
  filePath?: string | null;
  runtime?: string | null;
  container?: string | null;
  codec?: string | null;
  audioCodec?: string | null;
}

export interface SeasonData {
  seasonNumber: number;
  totalEpisodes: number;
  downloadedEpisodes: number;
  episodes: EpisodeData[];
}

// ── Unified sheet item type ──────────────────────────────────────────────────

export type SheetItem =
  | { kind: "library"; data: MediaItem; watchStatus?: "watched" | "in-progress" }
  | { kind: "lookup"; data: LookupItem }
  | { kind: "loading"; pendingTitle: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

export function formatSize(bytes: number): string {
  if (!bytes) return "—";
  const gb = bytes / 1073741824;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1048576).toFixed(0)} MB`;
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

/** Derive the container format from a file path extension when mediaInfo is unavailable. */
export function deriveContainerFromPath(filePath?: string | null): string | null {
  if (!filePath) return null;
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext || ext.length > 5) return null;
  const known = new Set(["mp4", "mkv", "avi", "m4v", "webm", "ts", "mov", "wmv", "flv"]);
  return known.has(ext) ? ext : null;
}

function getExternalLinks(item: Pick<MediaItem | LookupItem, "type" | "tmdbId" | "tvdbId">): Array<{ label: string; href: string }> {
  const links: Array<{ label: string; href: string }> = [];
  if (item.tmdbId) {
    links.push({
      label: "TMDB",
      href: `https://www.themoviedb.org/${item.type === "movie" ? "movie" : "tv"}/${item.tmdbId}`,
    });
  }
  if (item.tvdbId) {
    links.push({
      label: "TVDB",
      href: `https://thetvdb.com/dereferrer/series/${item.tvdbId}`,
    });
  }
  return links;
}

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (!value && value !== 0) return null;
  return (
    <div className="flex items-center justify-between px-4 py-2.5 text-sm border-b last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-right max-w-[60%] truncate">{value}</span>
    </div>
  );
}

function FormatStatRow({ container, filePath, codec, audioCodec }: {
  container?: string | null;
  filePath?: string | null;
  codec?: string | null;
  audioCodec?: string | null;
}) {
  const format = container ?? deriveContainerFromPath(filePath);
  const [optimizing, setOptimizing] = useState(false);

  // Poll for optimization job status for this specific file
  const { data: jobsData, mutate: mutateJobs } = useSWR<{ jobs: Array<{ id: string; sourcePath: string; targetPath?: string; status: string; progress: number; priority: number; error?: string | null }> }>(
    filePath ? `${getDirectCoreUrl()}/api/optimization/jobs` : null,
    (url: string) => fetch(url, { credentials: "include" }).then(r => r.json()),
    { refreshInterval: 3000 },
  );
  // Match by basename — host paths (stored in job) differ from container paths (from Radarr)
  const fileBasename = filePath?.split("/").pop()?.toLowerCase() ?? null;
  const fileJob = jobsData?.jobs?.find((j) => {
    if (j.status !== "running" && j.status !== "queued" && j.status !== "completed" && j.status !== "failed") return false;
    // Try exact match first, then fall back to basename match
    if (j.sourcePath === filePath) return true;
    const jobBasename = j.sourcePath?.split("/").pop()?.toLowerCase();
    return !!(jobBasename && fileBasename && jobBasename === fileBasename);
  });

  if (!format) return null;
  const upper = format.toUpperCase();
  const isMp4 = upper === "MP4" || upper === "M4V";

  const BROWSER_VIDEO = new Set(["h264", "x264", "hevc", "h265", "x265"]);
  const BROWSER_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
  const OPTIMAL_CONTAINERS = new Set(["MP4", "M4V", "MOV", "WEBM"]);
  const vOk = !codec || BROWSER_VIDEO.has(codec.toLowerCase());
  const aOk = !audioCodec || BROWSER_AUDIO.has(audioCodec.toLowerCase());
  const needsOpt = !OPTIMAL_CONTAINERS.has(upper) || !vOk || !aOk;

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

  // Show progress if conversion is active
  if (fileJob?.status === "running") {
    return (
      <div className="px-4 py-2.5 text-sm border-b last:border-b-0 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Converting to MP4</span>
          <span className="text-xs tabular-nums text-muted-foreground">{Math.round(fileJob.progress * 100)}%</span>
        </div>
        <div className="h-1 bg-muted rounded-full overflow-hidden">
          <div className="h-full bg-status-healthy/80 transition-all duration-1000 ease-out rounded-full" style={{ width: `${fileJob.progress * 100}%` }} />
        </div>
      </div>
    );
  }

  const [prioritizing, setPrioritizing] = useState(false);
  const [starting, setStarting] = useState(false);

  const handlePrioritize = async () => {
    if (!fileJob?.id || prioritizing) return;
    setPrioritizing(true);
    try {
      const res = await fetch(`${getDirectCoreUrl()}/api/optimization/jobs/${fileJob.id}/prioritize`, {
        method: "POST", credentials: "include",
      });
      if (res.ok) {
        toast.success("Moved to front of queue");
        void mutateJobs();
      } else {
        toast.error("Failed to prioritize");
      }
    } catch {
      toast.error("Failed to prioritize");
    } finally { setPrioritizing(false); }
  };

  const handleForceStart = async () => {
    if (!fileJob?.id || starting) return;
    setStarting(true);
    try {
      const res = await fetch(`${getDirectCoreUrl()}/api/optimization/jobs/${fileJob.id}/start`, {
        method: "POST", credentials: "include",
      });
      if (res.ok) {
        toast.success("Converting now");
        void mutateJobs();
      } else {
        toast.error("Failed to start conversion");
      }
    } catch {
      toast.error("Failed to start conversion");
    } finally { setStarting(false); }
  };

  if (fileJob?.status === "queued") {
    const isUpNext = fileJob.priority > 0;
    return (
      <div className="flex items-center justify-between px-4 py-2.5 text-sm border-b last:border-b-0">
        <span className="text-muted-foreground">Format</span>
        <div className="flex items-center gap-2">
          <span className={cn(
            "text-xs font-medium px-1.5 py-0.5 rounded",
            isUpNext ? "bg-status-healthy/10 text-status-healthy" : "bg-muted text-muted-foreground"
          )}>
            {isUpNext ? "Up next" : "Queued"}
          </span>
          {!isUpNext && (
            <button
              onClick={handlePrioritize}
              disabled={prioritizing}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              {prioritizing ? "Moving..." : "Move to front"}
            </button>
          )}
          {isUpNext && (
            <button
              onClick={handleForceStart}
              disabled={starting}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              {starting ? "Starting..." : "Convert now"}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (fileJob?.status === "completed") {
    return (
      <div className="flex items-center justify-between px-4 py-2.5 text-sm border-b last:border-b-0">
        <span className="text-muted-foreground">Format</span>
        <span className={cn("text-xs font-medium px-1.5 py-0.5 rounded bg-status-healthy/10 text-status-healthy")}>MP4</span>
      </div>
    );
  }

  if (fileJob?.status === "failed") {
    return (
      <div className="px-4 py-2.5 text-sm border-b last:border-b-0 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Format</span>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-status-critical/10 text-status-critical">
              Failed
            </span>
            <button
              onClick={handleOptimize}
              disabled={optimizing}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {optimizing ? "Queuing..." : "Retry"}
            </button>
          </div>
        </div>
        {fileJob.error && (
          <p className="text-xs text-status-critical/70 leading-relaxed line-clamp-3">
            {fileJob.error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between px-4 py-2.5 text-sm border-b last:border-b-0">
      <span className="text-muted-foreground">Format</span>
      <div className="flex items-center gap-2">
        <span className={cn(
          "text-xs font-medium px-1.5 py-0.5 rounded",
          isMp4 && vOk && aOk ? "bg-status-healthy/10 text-status-healthy" : needsOpt ? "bg-status-warning/10 text-status-warning" : "bg-muted text-muted-foreground"
        )}>
          {upper}
        </span>
        {needsOpt && filePath && (
          <button
            onClick={handleOptimize}
            disabled={optimizing}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {optimizing ? "Queuing..." : "Optimize"}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Poster + identity hero ────────────────────────────────────────────────────

function MediaHero({
  title,
  year,
  type,
  poster,
  rating,
  genres,
  badge,
  onGenreSelect,
  externalLinks,
}: {
  title: string;
  year?: number | null;
  type: "movie" | "tv";
  poster?: string | null;
  rating?: number | null;
  genres?: string[];
  badge?: React.ReactNode;
  onGenreSelect?: (genre: string) => void;
  externalLinks?: Array<{ label: string; href: string }>;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <div className="flex gap-4 p-5 pb-4">
      <div className="relative w-[120px] h-[180px] shrink-0 rounded-lg bg-muted overflow-hidden">
        {poster && !imgFailed ? (
          <Image
            src={resolvePosterUrl(poster, 240) ?? ""}
            alt={title}
            className="object-cover"
            fill
            priority
            sizes="120px"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <HugeiconsIcon
              icon={type === "tv" ? Tv01Icon : Film01Icon}
              size={28}
              className="text-dim-foreground"
            />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0 py-1">
        <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
          {type === "tv" ? "TV Show" : "Movie"}
        </p>
        <h2 className="text-base font-medium leading-snug">{title}</h2>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {year && <span className="text-sm text-muted-foreground">{year}</span>}
          {rating && (
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <HugeiconsIcon icon={StarIcon} size={11} />
              {rating.toFixed(1)}
            </span>
          )}
        </div>
        {externalLinks && externalLinks.length > 0 && (
          <div className="mt-2 flex items-center gap-1.5 flex-wrap">
            {externalLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
              >
                {link.label}
              </a>
            ))}
          </div>
        )}
        {(genres?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1 mt-3">
            {genres!.slice(0, 5).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => onGenreSelect?.(g)}
                className={cn(
                  "text-xs border border-border rounded-full px-2 py-0.5 leading-tight whitespace-nowrap transition-colors",
                  onGenreSelect
                    ? "text-muted-foreground hover:text-foreground hover:border-foreground/20 hover:bg-muted/40"
                    : "text-muted-foreground"
                )}
              >
                {g}
              </button>
            ))}
          </div>
        )}
        {badge && <div className="mt-3">{badge}</div>}
      </div>
    </div>
  );
}

// ── Download progress inline ─────────────────────────────────────────────────

function DownloadProgress({
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

// Quality types — imported for local use and re-exported for backwards compat
import { type QualityTier, QUALITY_TIERS, matchProfile } from "@talome/types";
export { type QualityTier, QUALITY_TIERS, matchProfile };

// ── Unified media sheet ──────────────────────────────────────────────────────

type AddState = "idle" | "loading" | "done" | "error";

export function UnifiedMediaSheet({
  item,
  onClose,
  onRemoved,
  onAdded,
}: {
  item: SheetItem | null;
  onClose: () => void;
  onRemoved?: (item: MediaItem) => void;
  onAdded?: () => void;
}) {
  const router = useRouter();
  const isMobile = useIsMobile();

  // Remove-from-library state
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [removeDeleteFiles, setRemoveDeleteFiles] = useState(false);
  const [removeState, setRemoveState] = useState<"idle" | "loading">("idle");

  // Lookup-specific state
  const [addState, setAddState] = useState<AddState>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [qualityTier, setQualityTier] = useState<QualityTier>("standard");
  const [qualityProfiles, setQualityProfiles] = useState<Array<{ id: number; name: string }>>([]);
  const [qualityProfileId, setQualityProfileId] = useState<string>("auto");

  // Library-specific: download polling
  const libraryData = item?.kind === "library" ? item.data : null;
  const watchStatus = item?.kind === "library" ? item.watchStatus : undefined;
  const { queue } = useDownloads(libraryData ? 3000 : 0);

  const activeDownloads = useMemo(() => {
    if (!libraryData) return [];
    return queue.filter((q) => {
      if (libraryData.type === "movie" && q.movieId === libraryData.id) return true;
      if (libraryData.type === "tv" && q.seriesId === libraryData.id) return true;
      if (q.title && libraryData.title) {
        const qLower = q.title.toLowerCase();
        const itemLower = libraryData.title.toLowerCase();
        if (qLower.includes(itemLower) || itemLower.includes(qLower)) return true;
      }
      return false;
    });
  }, [libraryData, queue]);

  const removeFromQueue = useCallback(async (queueId: number) => {
    if (!libraryData) return;
    const app = libraryData.type === "tv" ? "sonarr" : "radarr";
    try {
      await fetch(`${CORE_URL}/api/media/queue/${queueId}?app=${app}&removeFromClient=true`, {
        method: "DELETE",
      });
    } catch { /* ignore */ }
  }, [libraryData]);

  // Fetch quality profiles when a lookup item opens
  const lookupData = item?.kind === "lookup" ? item.data : null;
  useEffect(() => {
    if (!lookupData) return;
    const app = lookupData.type === "tv" ? "sonarr" : "radarr";
    fetch(`${CORE_URL}/api/media/quality-profiles?app=${app}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((data) => setQualityProfiles((data.qualityProfiles ?? []) as Array<{ id: number; name: string }>))
      .catch(() => setQualityProfiles([]));
  }, [lookupData]);

  const isOpen = !!item;

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      onClose();
      setAddState("idle");
      setErrorMsg("");
      setQualityProfileId("auto");
      setQualityTier("standard");
      setQualityProfiles([]);
      setShowRemoveConfirm(false);
      setRemoveDeleteFiles(false);
      setRemoveState("idle");
    }
  };

  const handleRemoveFromLibrary = useCallback(async () => {
    if (!libraryData) return;
    setRemoveState("loading");
    try {
      const endpoint = libraryData.type === "movie"
        ? `${CORE_URL}/api/media/movie/${libraryData.id}`
        : `${CORE_URL}/api/media/series/${libraryData.id}`;
      const params = new URLSearchParams();
      if (removeDeleteFiles) params.set("deleteFiles", "true");
      const res = await fetch(`${endpoint}?${params}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.success(`Removed "${libraryData.title}" from library`);
      onRemoved?.(libraryData);
      onClose();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to remove");
    }
    setRemoveState("idle");
    setShowRemoveConfirm(false);
    setRemoveDeleteFiles(false);
  }, [libraryData, removeDeleteFiles, onRemoved, onClose]);

  // Shared: genre navigation
  const itemData = item?.kind === "library" ? item.data : item?.kind === "lookup" ? item.data : null;
  const handleGenreSelect = useCallback((genre: string) => {
    if (!itemData) return;
    const params = new URLSearchParams();
    params.set("tab", itemData.type === "movie" ? "movies" : "tv");
    params.append("genre", genre);
    onClose();
    setAddState("idle");
    setErrorMsg("");
    router.push(`/dashboard/media?${params.toString()}`);
  }, [itemData, onClose, router]);

  // Library: navigate to detail page
  const handleViewDetails = useCallback(() => {
    if (!libraryData) return;
    onClose();
    router.push(`/dashboard/media/${libraryData.type}/${libraryData.id}`);
  }, [libraryData, onClose, router]);

  // Lookup: add to library
  const handleAdd = useCallback(async () => {
    if (!lookupData) return;
    setAddState("loading");
    try {
      const res = await fetch(`${CORE_URL}/api/media/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: lookupData.type,
          title: lookupData.title,
          tmdbId: lookupData.tmdbId ?? undefined,
          tvdbId: lookupData.tvdbId ?? undefined,
          qualityTier,
          qualityProfileId: qualityProfileId === "auto" ? undefined : Number(qualityProfileId),
        }),
      });
      if (!res.ok) {
        const j: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setAddState("done");
      onAdded?.();
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to add");
      setAddState("error");
    }
  }, [lookupData, qualityTier, qualityProfileId, onAdded]);

  if (!isOpen) return null;

  const sheetTitle = item.kind === "loading"
    ? `Loading ${item.pendingTitle}`
    : item.kind === "library"
    ? item.data.title
    : item.data.title;

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange} modal={false}>
      <div
        className="fixed inset-0 z-50 bg-black/50 animate-in fade-in-0"
        onClick={() => handleOpenChange(false)}
      />
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={cn(
          "w-full p-0 flex flex-col overflow-hidden",
          isMobile ? "h-[92svh] rounded-t-xl" : "sm:max-w-md"
        )}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{sheetTitle}</SheetTitle>
          <SheetDescription>View details and manage this media item</SheetDescription>
        </SheetHeader>

        {/* Loading state */}
        {item.kind === "loading" ? (
          <>
            <div className="flex-1 overflow-y-auto">
              <div className="flex gap-4 p-5 pb-4">
                <Skeleton className="w-[120px] h-[180px] shrink-0 rounded-lg" />
                <div className="flex-1 min-w-0 py-1 space-y-3">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Loading</p>
                  <Skeleton className="h-5 w-3/4" />
                  <Skeleton className="h-4 w-1/3" />
                  <div className="flex gap-1">
                    <Skeleton className="h-5 w-20 rounded-full" />
                    <Skeleton className="h-5 w-16 rounded-full" />
                  </div>
                </div>
              </div>

              <div className="px-5 pb-4 space-y-2">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-[94%]" />
                <Skeleton className="h-3.5 w-[82%]" />
              </div>

              <div className="mx-5 mb-5 rounded-lg border overflow-hidden">
                <div className="px-4 py-3 border-b"><Skeleton className="h-4 w-full" /></div>
                <div className="px-4 py-3 border-b"><Skeleton className="h-4 w-full" /></div>
                <div className="px-4 py-3"><Skeleton className="h-4 w-full" /></div>
              </div>
            </div>

            <div className="shrink-0 px-5 pb-5 pt-2">
              <Button className="w-full gap-2" disabled>
                <Shimmer as="span" className="text-sm" duration={1.5}>
                  Looking up metadata…
                </Shimmer>
              </Button>
            </div>
          </>
        ) : (
          <>
            {/* Content — shared layout for library and lookup */}
            <div className="flex-1 overflow-y-auto">
              <MediaHero
                title={item.data.title}
                year={item.data.year}
                type={item.data.type}
                poster={item.data.poster}
                rating={item.data.rating}
                genres={item.data.genres}
                onGenreSelect={handleGenreSelect}
                externalLinks={getExternalLinks(item.data)}
                badge={item.kind === "lookup" ? (
                  <span className="inline-flex items-center text-xs text-muted-foreground border border-border/50 rounded-full px-2 py-0.5">
                    Not in library
                  </span>
                ) : undefined}
              />

              {item.data.overview && (
                <div className="px-5 pb-4">
                  <p className="text-sm text-muted-foreground leading-relaxed">{item.data.overview}</p>
                </div>
              )}

              {/* Download progress — library only */}
              {item.kind === "library" && activeDownloads.length > 0 && (
                <div className="mx-5 mb-4 rounded-lg border border-border/50 p-4 space-y-3">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Downloading</p>
                  {activeDownloads.map((dl) => (
                    <DownloadProgress key={dl.id} item={dl} onRemove={removeFromQueue} />
                  ))}
                </div>
              )}

              {/* Stats table — show all available fields */}
              <div className="mx-5 mb-5 rounded-lg border overflow-hidden">
                {item.data.type === "tv" && (item.data as MediaItem | LookupItem).network && (
                  <StatRow label="Network" value={(item.data as MediaItem | LookupItem).network!} />
                )}
                {item.data.type === "movie" && (item.data as MediaItem | LookupItem).studio && (
                  <StatRow label="Studio" value={(item.data as MediaItem | LookupItem).studio!} />
                )}
                {item.kind === "lookup" && item.data.type === "tv" && item.data.seasonCount && (
                  <StatRow label="Seasons" value={item.data.seasonCount} />
                )}
                {item.kind === "library" && (
                  <StatRow
                    label="Status"
                    value={item.data.type === "movie" ? (item.data.hasFile ? "In library" : "Missing") : (item.data.status ?? "—")}
                  />
                )}
                {item.kind === "library" && (item.data.sizeOnDisk ?? 0) > 0 && (
                  <StatRow label="Size" value={formatSize(item.data.sizeOnDisk!)} />
                )}
                {item.kind === "library" && (
                  <FormatStatRow container={item.data.quality?.container} filePath={item.data.filePath} codec={item.data.quality?.codec} audioCodec={item.data.quality?.audioCodec} />
                )}
                {item.kind === "lookup" && item.data.runtime && (
                  <StatRow label="Runtime" value={`${item.data.runtime} min`} />
                )}
                {item.kind === "library" && watchStatus && (
                  <StatRow
                    label="Plex"
                    value={
                      <span className={watchStatus === "watched" ? "text-status-healthy" : "text-status-info"}>
                        {watchStatus === "watched" ? "Watched" : "In Progress"}
                      </span>
                    }
                  />
                )}
              </div>
            </div>

            {/* Action area — contextual */}
            <div className="shrink-0 px-5 pb-5 pt-2">
              {item.kind === "library" ? (
                <div className="flex gap-2">
                  <Button onClick={handleViewDetails} className="flex-1" variant="secondary" size="sm">
                    View details
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-dim-foreground hover:text-destructive"
                        onClick={() => setShowRemoveConfirm(true)}
                      >
                        <HugeiconsIcon icon={Delete01Icon} size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Remove from library</TooltipContent>
                  </Tooltip>
                </div>
              ) : (
                <>
                  {addState === "error" && (
                    <p className="text-xs text-destructive mb-2">{errorMsg}</p>
                  )}
                  {/* Quality tier — vertical list with hints */}
                  <div className="space-y-1 mb-2">
                    {QUALITY_TIERS.map((tier) => {
                      const isManualOverride = qualityProfileId !== "auto";
                      const isSelected = !isManualOverride && qualityTier === tier.id;
                      const resolved = isSelected && qualityProfiles.length > 0
                        ? matchProfile(qualityProfiles, tier.id)
                        : null;
                      return (
                        <button
                          key={tier.id}
                          type="button"
                          onClick={() => {
                            setQualityTier(tier.id);
                            setQualityProfileId("auto");
                          }}
                          disabled={addState === "loading"}
                          className={cn(
                            "w-full flex items-center justify-between rounded-lg px-3 py-2 text-left transition-colors",
                            isSelected
                              ? "bg-muted/60 text-foreground"
                              : isManualOverride
                              ? "text-dim-foreground hover:text-muted-foreground hover:bg-muted/10"
                              : "text-muted-foreground hover:text-foreground hover:bg-muted/20"
                          )}
                        >
                          <span className="text-sm font-medium">{tier.label}</span>
                          <span className="text-xs text-muted-foreground">
                            {resolved && !resolved.fallbackUsed ? resolved.profileName : tier.hint}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {/* Profile override */}
                  <div className="mb-2">
                    <SelectRoot
                      value={qualityProfileId}
                      onValueChange={setQualityProfileId}
                      disabled={addState === "loading"}
                    >
                      <SelectTrigger size="sm" className="h-8 w-full text-xs">
                        <SelectValue placeholder="Auto profile" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Auto profile</SelectItem>
                        {qualityProfiles.map((p) => (
                          <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </SelectRoot>
                  </div>
                  <Button
                    className="w-full gap-2"
                    onClick={handleAdd}
                    disabled={addState === "loading" || addState === "done"}
                  >
                    {addState === "loading" ? (
                      <Spinner className="size-3.5" />
                    ) : addState === "done" ? (
                      <HugeiconsIcon icon={Tick01Icon} size={14} />
                    ) : (
                      <HugeiconsIcon icon={Download01Icon} size={14} />
                    )}
                    {addState === "done"
                      ? "Added to library"
                      : addState === "loading"
                      ? "Adding…"
                      : "Add to library"}
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </SheetContent>

      {/* Remove from library confirmation */}
      {item?.kind === "library" && (
        <Dialog
          open={showRemoveConfirm}
          onOpenChange={(open) => {
            if (!open && removeState !== "loading") {
              setShowRemoveConfirm(false);
              setRemoveDeleteFiles(false);
            }
          }}
        >
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Remove from library</DialogTitle>
              <DialogDescription>
                This will remove &ldquo;{item.data.title}&rdquo; from {item.data.type === "movie" ? "Radarr" : "Sonarr"}.
                It will no longer appear in your library.
              </DialogDescription>
            </DialogHeader>
            <label className="flex items-center justify-between gap-3 py-1">
              <div>
                <p className="text-sm font-medium">Delete files from disk</p>
                <p className="text-xs text-muted-foreground">Permanently remove media files from disk</p>
              </div>
              <Switch checked={removeDeleteFiles} onCheckedChange={setRemoveDeleteFiles} />
            </label>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setShowRemoveConfirm(false)} disabled={removeState === "loading"}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleRemoveFromLibrary} disabled={removeState === "loading"}>
                {removeState === "loading" ? <Spinner className="size-3.5" /> : "Remove"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Sheet>
  );
}
