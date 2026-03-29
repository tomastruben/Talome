"use client";

import { useEffect, useState, Suspense, useMemo, useRef, useCallback } from "react";
import Image from "next/image";
import { useSearchParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { CORE_URL, resolvePosterUrl } from "@/lib/constants";
import { SearchField } from "@/components/ui/search-field";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsBadge } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Pill } from "@/components/kibo-ui/pill";
import {
  HugeiconsIcon,
  Tv01Icon,
  Film01Icon,
  Download01Icon,
  Calendar01Icon,
  Search01Icon,
  PlayListAddIcon,
  Refresh01Icon,
  Delete01Icon,
  PlayIcon,
  Notification01Icon,
  CheckmarkCircle01Icon,
  Cancel01Icon,
  Add01Icon,
} from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { useDownloads } from "@/hooks/use-downloads";
import type { DownloadQueueItem, DownloadTorrent, MediaSearchResult } from "@talome/types";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
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
import { toast } from "sonner";
import { AnimatePresence, motion } from "framer-motion";
import {
  type MediaItem,
  type LookupItem,
  type LibraryData,
  formatSize,
  deriveContainerFromPath,
  UnifiedMediaSheet,
  type SheetItem,
} from "@/components/media/media-detail-sheet";
import { ReleaseSearchPanel } from "@/components/media/release-search-panel";
import { RequestsTab, type OverseerrRequest } from "@/components/media/requests-tab";
import { WatchlistSection, type PlexWatchlistItem } from "@/components/media/watching-tab";
import { useCinemaBrowser } from "@/components/media/cinema-browser-context";
import { Projector01Icon } from "@/components/icons";
import { useSetAtom } from "jotai";
import { pageActionAtom } from "@/atoms/page-action";
import { useFeatureStack } from "@/hooks/use-feature-stacks";
import { StackSetup } from "@/components/ui/stack-setup";

interface CalendarData {
  episodes: { id: number; seriesId?: number | null; seriesTitle: string; title: string; season: number; episode: number; airDate: string; poster?: string | null }[];
  movies: { id: number; title: string; releaseDate?: string; poster?: string | null; year?: number | null }[];
}

interface WantedRecord {
  id: number;
  app: "sonarr" | "radarr";
  title: string;
  year?: number | null;
  monitored?: boolean | null;
  quality?: string | null;
  size?: number | null;
  poster?: string | null;
  seriesId?: number | null;
  episodeId?: number | null;
  seasonNumber?: number | null;
  movieId?: number | null;
}

interface WantedData {
  records: WantedRecord[];
}

interface WantedReleaseResult {
  title: string;
  quality?: string | null;
  size?: number | null;
  ageHours?: number | null;
  indexer?: string | null;
  seeders?: number | null;
  leechers?: number | null;
  rejected?: boolean;
  rejections?: string[];
  raw?: Record<string, unknown>;
}

interface WantedReleasePanelState {
  loading: boolean;
  error: string | null;
  releases: WantedReleaseResult[];
  grabbingTitle: string | null;
}

type Tab = "movies" | "tv" | "downloads" | "calendar" | "activity";

interface RequestsData {
  configured?: boolean;
  results: OverseerrRequest[];
}

interface PlexWatchlistData {
  configured: boolean;
  items: PlexWatchlistItem[];
}

interface PlexWatchStatusData {
  configured: boolean;
  watchStatus: Record<string, "watched" | "in-progress">;
}

interface PlexContinueWatchingItem {
  ratingKey?: string;
  title?: string;
  episodeTitle?: string;
  type: "movie" | "tv";
  year?: number;
  thumb?: string;
  viewOffset?: number;
  duration?: number;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
}

interface PlexWatchingData {
  configured: boolean;
  continueWatching?: PlexContinueWatchingItem[];
}

type SortKey = "added-desc" | "added-asc" | "title-asc" | "title-desc" | "year-desc" | "year-asc";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetcher(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("API error");
  return res.json();
}

function useAutoLoadSentinel({
  targetRef,
  enabled,
  onLoadMore,
}: {
  targetRef: React.RefObject<HTMLDivElement | null>;
  enabled: boolean;
  onLoadMore: () => void;
}) {
  useEffect(() => {
    if (!enabled) return;
    const target = targetRef.current;
    if (!target) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMore();
        }
      },
      {
        // Start loading before user reaches the absolute end of the grid.
        rootMargin: "420px 0px 220px 0px",
        threshold: 0.01,
      }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [enabled, onLoadMore, targetRef]);
}

function formatSpeed(bps: number): string {
  if (!bps) return "—";
  const mb = bps / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${(bps / 1024).toFixed(0)} KB/s`;
}

function formatEta(seconds: number): string {
  if (!seconds || seconds < 0 || seconds > 86400 * 7) return "";
  if (seconds < 60) return `~${seconds}s`;
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min`;
  return `~${(seconds / 3600).toFixed(1)} hr`;
}

const QUEUE_STATUS_MAP: Record<string, { label: string; color: string }> = {
  downloading:   { label: "Downloading",  color: "text-status-info" },
  delay:         { label: "Waiting",      color: "text-muted-foreground" },
  importPending: { label: "Processing",   color: "text-status-warning" },
  importing:     { label: "Importing",    color: "text-status-warning" },
  completed:     { label: "Complete",     color: "text-status-healthy" },
  failed:        { label: "Failed",       color: "text-status-critical" },
  warning:       { label: "Warning",      color: "text-status-warning" },
  paused:        { label: "Paused",       color: "text-muted-foreground" },
  queued:        { label: "Queued",       color: "text-muted-foreground" },
};

const TORRENT_STATE_MAP: Record<string, string> = {
  downloading:  "Downloading",
  stalledDL:    "Stalled",
  pausedDL:     "Paused",
  queuedDL:     "Queued",
  uploading:    "Seeding",
  stalledUP:    "Seeding (idle)",
  pausedUP:     "Paused",
  checkingDL:   "Checking",
  checkingUP:   "Checking",
  missingFiles: "Error",
};

// ── Download Row Components ───────────────────────────────────────────────────

function DownloadQueueRow({
  item,
  onRetry,
  onRemove,
  retryingId,
  retryState,
  removing,
}: {
  item: DownloadQueueItem;
  onRetry?: (item: DownloadQueueItem) => void;
  onRemove?: (item: DownloadQueueItem) => void;
  retryingId?: number | null;
  retryState?: "idle" | "running" | "done" | "error";
  removing?: boolean;
}) {
  const hasKnownSize = item.size > 0;
  const progressFromBytes = hasKnownSize && item.sizeleft >= 0
    ? (item.size - item.sizeleft) / item.size
    : null;
  const rawProgress = typeof item.progress === "number" ? item.progress : progressFromBytes;
  const normalizedProgress = rawProgress == null ? null : Math.min(1, Math.max(0, rawProgress));
  const pct = Math.round((normalizedProgress ?? 0) * 100);
  const downloaded = hasKnownSize ? item.size * (normalizedProgress ?? 0) : 0;
  const statusInfo = QUEUE_STATUS_MAP[item.status] ?? { label: item.status, color: "text-muted-foreground" };
  const eta = item.eta != null ? formatEta(item.eta) : "";
  const resolved = resolvePosterUrl(item.poster, 120);
  const [imgFailed, setImgFailed] = useState(false);
  const warningDetails = [
    item.errorMessage?.trim() ?? "",
    ...((item.statusMessages ?? []).map((message) => message.trim())),
  ].filter((message) => message.length > 0);
  const warningDetailText = warningDetails.length > 0 ? Array.from(new Set(warningDetails)).join(" • ") : null;

  return (
    <div className="group/row relative rounded-lg overflow-hidden border border-border/50 bg-card flex items-stretch min-h-[88px]">
      {/* Poster — full-height strip on the left */}
      <div className="w-14 shrink-0 relative bg-muted/40 border-r border-border/40">
        {resolved && !imgFailed ? (
          <Image
            src={resolved}
            alt={`${item.title} poster`}
            className="object-cover" fill
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <HugeiconsIcon icon={item.type === "tv" ? Tv01Icon : Film01Icon} size={16} className="text-dim-foreground" />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 px-4 py-3 flex flex-col justify-between">
        {/* Top: title + status */}
        <div className="flex items-center justify-between gap-3 mb-2">
          <p className="text-sm font-medium leading-snug line-clamp-1 flex-1 min-w-0">{item.title}</p>
          <div className="shrink-0 flex items-center gap-1.5">
            {warningDetailText ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={`text-xs mt-px cursor-help ${
                      retryState === "running"
                        ? "text-primary animate-pulse"
                        : retryState === "done"
                          ? "text-status-healthy"
                          : retryState === "error"
                            ? "text-destructive"
                            : statusInfo.color
                    }`}
                    aria-label="Show warning details"
                  >
                    {retryState === "running"
                      ? "Retrying"
                      : retryState === "done"
                        ? "Retried"
                        : retryState === "error"
                          ? "Retry failed"
                          : statusInfo.label}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-[320px] text-xs leading-snug">
                  {warningDetailText}
                </TooltipContent>
              </Tooltip>
            ) : (
              <span
                className={`text-xs mt-px ${
                  retryState === "running"
                    ? "text-primary animate-pulse"
                    : retryState === "done"
                      ? "text-status-healthy"
                      : retryState === "error"
                        ? "text-destructive"
                        : statusInfo.color
                }`}
              >
                {retryState === "running"
                  ? "Retrying"
                  : retryState === "done"
                    ? "Retried"
                    : retryState === "error"
                      ? "Retry failed"
                      : statusInfo.label}
              </span>
            )}
            {(item.status === "failed" || item.status === "warning") && onRetry && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-primary/80 hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-60"
                    onClick={() => onRetry(item)}
                    disabled={retryingId === item.id}
                    aria-label={retryingId === item.id ? "Retrying download" : "Retry download"}
                  >
                    <HugeiconsIcon icon={Refresh01Icon} size={14} className={retryingId === item.id ? "animate-spin" : ""} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  {retryingId === item.id ? "Retrying..." : "Retry"}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Progress + metadata (always visible) */}
        <div className="space-y-1.5">
          <Progress value={normalizedProgress == null ? 0 : pct} className="h-0.5" />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground tabular-nums">
              {hasKnownSize
                ? `${formatSize(downloaded)} of ${formatSize(item.size)}`
                : "Waiting for progress data"}
              {(item.dlspeed ?? 0) > 0 && (
                <span className="ml-2 text-muted-foreground">· {formatSpeed(item.dlspeed!)}</span>
              )}
              {eta && <span className="ml-2 text-muted-foreground">· {eta}</span>}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {normalizedProgress == null ? "—" : `${pct}%`}
            </span>
          </div>
        </div>
      </div>

      {/* Remove — right edge, always visible */}
      {onRemove && (
        <button
          type="button"
          className="shrink-0 w-9 flex items-center justify-center border-l border-border/30 text-dim-foreground hover:text-destructive transition-colors duration-150 disabled:cursor-wait"
          onClick={() => onRemove(item)}
          disabled={removing}
          aria-label="Remove from queue"
        >
          {removing ? (
            <Spinner className="size-3" />
          ) : (
            <HugeiconsIcon icon={Delete01Icon} size={14} />
          )}
        </button>
      )}
    </div>
  );
}

function DownloadTorrentRow({ torrent }: { torrent: DownloadTorrent }) {
  const pct = Math.round(torrent.progress * 100);
  const downloaded = torrent.size * torrent.progress;
  const stateLabel = TORRENT_STATE_MAP[torrent.state] ?? torrent.state;
  const eta = formatEta(torrent.eta);
  const resolved = resolvePosterUrl(torrent.poster, 120);
  const [imgFailed, setImgFailed] = useState(false);

  return (
    <div className="relative rounded-lg overflow-hidden border border-border/50 bg-card flex items-stretch min-h-[88px]">
      {/* Poster strip */}
      <div className="w-14 shrink-0 relative bg-muted/40 border-r border-border/40">
        {resolved && !imgFailed ? (
          <Image
            src={resolved}
            alt={`${torrent.name} poster`}
            className="object-cover" fill
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <HugeiconsIcon icon={Film01Icon} size={16} className="text-dim-foreground" />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 px-4 py-3 flex flex-col justify-between">
        <div className="flex items-start justify-between gap-3 mb-2">
          <p className="text-sm font-medium leading-snug line-clamp-2 flex-1 min-w-0">{torrent.name}</p>
          <span className="text-xs shrink-0 mt-px text-muted-foreground">{stateLabel}</span>
        </div>

        <div className="space-y-1.5">
          <Progress value={pct} className="h-0.5" />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatSize(downloaded)} of {formatSize(torrent.size)}
              {torrent.dlspeed > 0 && (
                <span className="ml-2 text-muted-foreground">· {formatSpeed(torrent.dlspeed)}</span>
              )}
              {eta && <span className="ml-2 text-muted-foreground">· {eta}</span>}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function WantedRow({
  item,
  onManualSearch,
  active,
}: {
  item: WantedRecord;
  onManualSearch?: (item: WantedRecord) => void;
  active?: boolean;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const resolved = resolvePosterUrl(item.poster, 120);
  return (
    <div
      className={`group relative rounded-lg overflow-hidden border bg-card flex items-stretch h-[72px] transition-colors duration-150 cursor-pointer ${
        active
          ? "border-primary/30"
          : "border-border/50 hover:border-border/80"
      }`}
      onClick={() => onManualSearch?.(item)}
    >
      <div className="w-12 shrink-0 relative bg-muted/40 border-r border-border/40">
        {resolved && !imgFailed ? (
          <Image
            src={resolved}
            alt={`${item.title} poster`}
            className="object-cover" fill
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <HugeiconsIcon icon={item.app === "sonarr" ? Tv01Icon : Film01Icon} size={14} className="text-dim-foreground" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0 flex items-center gap-3 px-3.5">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate leading-snug">{item.title}</p>
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {[item.app.toUpperCase(), item.year ?? null, item.quality ?? null].filter(Boolean).join(" · ")}
          </p>
        </div>
        <HugeiconsIcon
          icon={Search01Icon}
          size={14}
          className="shrink-0 text-dim-foreground"
        />
      </div>
    </div>
  );
}

function WantedReleasePanel({
  loading,
  error,
  releases,
  grabbingTitle,
  onClose,
  onGrab,
}: {
  loading: boolean;
  error: string | null;
  releases: WantedReleaseResult[];
  grabbingTitle: string | null;
  onClose: () => void;
  onGrab: (release: WantedReleaseResult) => void;
}) {
  return (
    <div className="rounded-lg border border-border/30 bg-card/80 px-3 py-2.5">
      <ReleaseSearchPanel
        loading={loading}
        error={error}
        releases={releases}
        submittingTitle={grabbingTitle}
        onGrab={onGrab}
        onClose={onClose}
        maxResults={6}
      />
    </div>
  );
}

// ── CalendarPoster ────────────────────────────────────────────────────────────

function CalendarCard({
  poster,
  type,
  title,
  subtitle,
  meta,
  date,
  onRemove,
  removing,
}: {
  poster?: string | null;
  type: "tv" | "movie";
  title: string;
  subtitle?: string;
  meta?: string;
  date: string;
  onRemove?: () => void;
  removing?: boolean;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const resolved = resolvePosterUrl(poster, 120);

  return (
    <div className="group relative rounded-lg overflow-hidden border border-border/50 bg-card flex items-stretch h-[72px]">
      {/* Poster strip */}
      <div className="w-12 shrink-0 relative bg-muted/40 border-r border-border/40">
        {resolved && !imgFailed ? (
          <Image
            src={resolved}
            alt={`${title} poster`}
            className="object-cover" fill
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <HugeiconsIcon icon={type === "tv" ? Tv01Icon : Film01Icon} size={14} className="text-dim-foreground" />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 flex items-center gap-3 px-3.5">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate leading-snug">{title}</p>
          {subtitle && (
            <p className="text-xs text-muted-foreground truncate mt-0.5">{subtitle}</p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-medium text-muted-foreground">{date}</p>
          {meta && <p className="text-xs text-muted-foreground mt-0.5 font-mono">{meta}</p>}
        </div>
      </div>

      {/* Remove button */}
      {onRemove && (
        <button
          type="button"
          className="shrink-0 w-9 flex items-center justify-center border-l border-border/30 text-dim-foreground hover:text-destructive transition-colors duration-150 opacity-0 group-hover:opacity-100 focus:opacity-100"
          onClick={onRemove}
          disabled={removing}
        >
          {removing
            ? <Spinner className="size-3.5" />
            : <HugeiconsIcon icon={Delete01Icon} size={14} />}
        </button>
      )}
    </div>
  );
}

// ── MediaCard ────────────────────────────────────────────────────────────────

function MediaCard({ item, onClick, onNavigate, watchStatus, selected, selectionMode, priority, optStatus }: { item: MediaItem; onClick: (item: MediaItem) => void; onNavigate?: (item: MediaItem) => void; watchStatus?: "watched" | "in-progress"; selected?: boolean; selectionMode?: boolean; priority?: boolean; optStatus?: { status: string; progress: number } }) {
  const [imgFailed, setImgFailed] = useState(false);
  const label = item.type === "tv"
    ? `${item.seasonCount ?? 0}S · ${item.episodeCount ?? 0}E`
    : item.hasFile ? "In library" : "Missing";

  return (
    <div className="media-card" onClick={() => (onNavigate ?? onClick)(item)}>
      <div className={`media-card-poster ${selected ? "ring-2 ring-primary" : ""}`}>
        {item.poster && !imgFailed ? (
          <Image
            src={resolvePosterUrl(item.poster, 400) ?? ""}
            alt={item.title}
            className="object-cover" fill
            sizes="(max-width: 640px) 33vw, (max-width: 1024px) 20vw, 200px"
            priority={priority}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <HugeiconsIcon
              icon={item.type === "tv" ? Tv01Icon : Film01Icon}
              size={28}
              className="text-dim-foreground"
            />
          </div>
        )}
        {selectionMode && (
          <div className={`absolute top-1.5 left-1.5 rounded-full size-5 flex items-center justify-center transition-colors ${
            selected ? "bg-primary" : "bg-black/50 border border-white/30"
          }`}>
            {selected && <HugeiconsIcon icon={CheckmarkCircle01Icon} size={14} className="text-primary-foreground" />}
          </div>
        )}
        {!selectionMode && watchStatus && (
          <div className="absolute top-1.5 right-1.5 rounded-full bg-black/60 p-0.5">
            <HugeiconsIcon
              icon={watchStatus === "watched" ? CheckmarkCircle01Icon : PlayIcon}
              size={14}
              className={watchStatus === "watched" ? "text-status-healthy" : "text-status-info"}
            />
          </div>
        )}
        {optStatus?.status === "running" && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/30 overflow-hidden rounded-b">
            <div className="h-full bg-status-healthy/80 transition-all duration-1000 ease-out" style={{ width: `${optStatus.progress * 100}%` }} />
          </div>
        )}
        {optStatus?.status === "queued" && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/30 overflow-hidden rounded-b">
            <div className="h-full w-full bg-muted-foreground/30 animate-pulse" />
          </div>
        )}
      </div>
      <div className="min-w-0 mt-2 px-0.5">
        <p className="text-sm font-medium truncate leading-tight">{item.title}</p>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          {item.year && (
            <Pill variant="secondary" className="text-xs py-0 px-1.5 h-4 rounded-sm font-normal">
              {item.year}
            </Pill>
          )}
          <Pill variant="secondary" className="text-xs py-0 px-1.5 h-4 rounded-sm font-normal truncate max-w-[100px]">
            {label}
          </Pill>
          {item.type === "movie" && item.quality?.container && (() => {
            const c = item.quality!.container!.toLowerCase();
            const v = (item.quality!.codec ?? "").toLowerCase();
            const ok = (c === "mp4" || c === "m4v") && (v === "h264" || v === "x264" || v === "hevc" || v === "h265" || v === "x265");
            return (
              <Pill
                variant="secondary"
                className={`text-xs py-0 px-1.5 h-4 rounded-sm font-normal ${
                  ok ? "bg-status-healthy/10 text-status-healthy" : "bg-status-warning/10 text-status-warning"
                }`}
              >
                {item.quality!.container!.toUpperCase()}
              </Pill>
            );
          })()}
        </div>
        {(item.sizeOnDisk ?? 0) > 0 && (
          <p className="text-xs text-muted-foreground mt-0.5">{formatSize(item.sizeOnDisk!)}</p>
        )}
      </div>
    </div>
  );
}

function DiscoveryCard({ item, onClick, priority }: { item: MediaSearchResult; onClick: (item: MediaSearchResult) => void; priority?: boolean }) {
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <div className="media-card group" onClick={() => onClick(item)}>
      <div className="media-card-poster opacity-75 group-hover:opacity-100 transition-opacity">
        {item.poster && !imgFailed ? (
          <Image
            src={resolvePosterUrl(item.poster, 400) ?? ""}
            alt={item.name}
            className="object-cover" fill
            sizes="(max-width: 640px) 33vw, (max-width: 1024px) 20vw, 200px"
            priority={priority}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <HugeiconsIcon
              icon={item.type === "tv" ? Tv01Icon : Film01Icon}
              size={28}
              className="text-dim-foreground"
            />
          </div>
        )}
        <div className="absolute top-1.5 right-1.5 rounded-full bg-foreground/80 p-0.5">
          <HugeiconsIcon icon={Add01Icon} size={14} className="text-background" />
        </div>
      </div>
      <div className="min-w-0 mt-2 px-0.5">
        <p className="text-sm font-medium truncate leading-tight">{item.name}</p>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          {item.year > 0 && (
            <Pill variant="secondary" className="text-xs py-0 px-1.5 h-4 rounded-sm font-normal">
              {item.year}
            </Pill>
          )}
          {typeof item.rating === "number" && item.rating > 0 && (
            <Pill variant="secondary" className="text-xs py-0 px-1.5 h-4 rounded-sm font-normal">
              {item.rating.toFixed(1)}
            </Pill>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function MediaPageInner({
  initialTab,
  initialSearch,
  initialGenres,
  initialMinRating,
  initialCinema,
}: {
  initialTab: Tab;
  initialSearch: string;
  initialGenres: string[];
  initialMinRating: number | null;
  initialCinema?: boolean;
}) {
  const PAGE_CHUNK = 120;
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [search, setSearch] = useState(initialSearch);
  const [selected, setSelected] = useState<SheetItem | null>(null);
  const [sort, setSort] = useState<SortKey>("added-desc");
  const [selectedGenres, setSelectedGenres] = useState<string[]>(initialGenres);
  const [minRating, setMinRating] = useState<number | null>(initialMinRating);
  type HealthFilter = "all" | "ready" | "needs-conversion";
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("all");
  const [scanning, setScanning] = useState(false);
  const [visibleMovies, setVisibleMovies] = useState(PAGE_CHUNK);
  const [visibleTv, setVisibleTv] = useState(PAGE_CHUNK);
  const [retryingQueueId, setRetryingQueueId] = useState<number | null>(null);
  const [queueRetryState, setQueueRetryState] = useState<Record<number, "idle" | "running" | "done" | "error">>({});
  const [removingQueueIds, setRemovingQueueIds] = useState<Set<number>>(new Set());
  const [wantedPanels, setWantedPanels] = useState<Record<string, WantedReleasePanelState>>({});

  // Cinema browser
  const cinemaBrowser = useCinemaBrowser();

  // Feature stack readiness — show setup when nothing is configured
  const { stack: mediaStack, isLoading: stackLoading } = useFeatureStack("media");

  // Auto-open cinema mode via ?cinema=1 URL param (bookmarkable link for projectors)
  useEffect(() => {
    if (initialCinema) {
      const cinemaTab = tab === "movies" || tab === "tv" ? tab : "movies";
      cinemaBrowser.open(cinemaTab);
    }
    // Only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Batch selection
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [bulkDeleteFiles, setBulkDeleteFiles] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const moviesLoadSentinelRef = useRef<HTMLDivElement | null>(null);
  const tvLoadSentinelRef = useRef<HTMLDivElement | null>(null);
  const tabRef = useRef(tab);
  tabRef.current = tab;

  // Sync active tab to URL so browser history preserves it on back-navigation
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(window.history.state, "", url.toString());
  }, [tab]);

  const { data: library, isLoading: libraryLoading, error: libraryError, mutate: mutateLibrary } = useSWR<LibraryData>(
    `${CORE_URL}/api/media/library`,
    fetcher,
    { refreshInterval: 30000 }
  );

  // Optimization jobs — lookup by basename (host paths ≠ Radarr container paths)
  const { data: optJobsData } = useSWR<{ jobs: Array<{ sourcePath: string; status: string; progress: number }> }>(
    `${CORE_URL}/api/optimization/jobs?status=running,queued,completed`,
    fetcher,
    { refreshInterval: 3000 }
  );
  const stemOf = (p: string) => {
    const name = p.split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.substring(0, dot).toLowerCase() : name.toLowerCase();
  };
  const optJobsByBasename = useMemo(() => {
    const map = new Map<string, { status: string; progress: number }>();
    for (const j of optJobsData?.jobs ?? []) {
      map.set(stemOf(j.sourcePath), { status: j.status, progress: j.progress });
    }
    return map;
  }, [optJobsData]);

  // Scan status by basename — movies only (TV optimization is per-episode in detail view)
  type ScanEntry = { needsOptimization: boolean; videoCodec: string; audioCodec: string; container: string };
  const movieBasenames = useMemo(() => {
    const names: string[] = [];
    for (const m of library?.movies ?? []) {
      if (m.filePath) names.push(stemOf(m.filePath));
    }
    return names;
  }, [library?.movies]);
  const { data: scanStatusData, mutate: mutateScanStatus } = useSWR<{ entries: Record<string, ScanEntry> }>(
    movieBasenames.length > 0 ? `${CORE_URL}/api/optimization/scan-status` : null,
    (url: string) => fetch(url, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ basenames: movieBasenames }),
    }).then(r => r.json()),
    { refreshInterval: 30000 }
  );
  const scanStatusByBasename = useMemo(() => scanStatusData?.entries ?? {}, [scanStatusData]);

  // Movie optimization counts — derived from scan data + job status
  const movieOptCounts = useMemo(() => {
    let scanned = 0, ready = 0, needsConversion = 0;
    for (const m of library?.movies ?? []) {
      if (!m.hasFile || !m.filePath) continue;
      const stem = stemOf(m.filePath);
      const job = optJobsByBasename.get(stem);
      if (job?.status === "completed") { scanned++; ready++; continue; }
      const entry = scanStatusByBasename[stem];
      if (!entry) continue;
      scanned++;
      if (entry.needsOptimization) needsConversion++;
      else ready++;
    }
    return { scanned, ready, needsConversion };
  }, [library?.movies, optJobsByBasename, scanStatusByBasename]);

  // Restore scroll position when returning from a detail page
  useEffect(() => {
    if (libraryLoading) return;
    const savedY = sessionStorage.getItem("media-scroll-y");
    if (!savedY) return;
    sessionStorage.removeItem("media-scroll-y");
    requestAnimationFrame(() => {
      const scrollParent = document.querySelector(".overflow-y-auto") as HTMLElement | null;
      if (scrollParent) scrollParent.scrollTo({ top: Number(savedY) });
    });
  }, [libraryLoading]);

  const { data: downloads, torrents: activeTorrents, queue: downloadQueue } = useDownloads();

  const { data: calendar, mutate: mutateCalendar } = useSWR<CalendarData>(
    `${CORE_URL}/api/media/calendar`,
    fetcher,
    { refreshInterval: 60000 }
  );
  const [calendarRemoving, setCalendarRemoving] = useState<string | null>(null);
  const [calendarRemoveTarget, setCalendarRemoveTarget] = useState<{ type: "tv" | "movie"; id: number; title: string } | null>(null);
  const { data: wantedTv } = useSWR<WantedData>(
    `${CORE_URL}/api/media/wanted?app=sonarr&kind=missing&page=1&pageSize=40`,
    fetcher,
    { refreshInterval: 60000 }
  );
  const { data: wantedMovies } = useSWR<WantedData>(
    `${CORE_URL}/api/media/wanted?app=radarr&kind=missing&page=1&pageSize=40`,
    fetcher,
    { refreshInterval: 60000 }
  );

  // Conditional tabs data
  const { data: requestsData, mutate: mutateRequests } = useSWR<RequestsData>(
    `${CORE_URL}/api/media/requests`,
    fetcher,
    { refreshInterval: 60000 }
  );
  const { data: plexWatchlist } = useSWR<PlexWatchlistData>(
    `${CORE_URL}/api/media/plex/watchlist`,
    fetcher,
    { refreshInterval: 60000 }
  );
  const { data: plexWatchStatus } = useSWR<PlexWatchStatusData>(
    `${CORE_URL}/api/media/plex/watch-status`,
    fetcher,
    { refreshInterval: 120000 }
  );
  const { data: plexWatchingData } = useSWR<PlexWatchingData>(
    `${CORE_URL}/api/media/plex/watching`,
    fetcher,
    { refreshInterval: 30000 }
  );

  // ── Discovery search (external lookup when local results are sparse) ──────
  const [discoveryResults, setDiscoveryResults] = useState<MediaSearchResult[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const discoveryAbort = useRef<AbortController | null>(null);
  const discoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function sortItems(items: MediaItem[]): MediaItem[] {
    return [...items].sort((a, b) => {
      switch (sort) {
        case "title-asc":   return a.title.localeCompare(b.title);
        case "title-desc":  return b.title.localeCompare(a.title);
        case "year-desc":   return (b.year ?? 0) - (a.year ?? 0);
        case "year-asc":    return (a.year ?? 0) - (b.year ?? 0);
        case "added-asc":   return new Date(a.added ?? 0).getTime() - new Date(b.added ?? 0).getTime();
        case "added-desc":
        default:            return new Date(b.added ?? 0).getTime() - new Date(a.added ?? 0).getTime();
      }
    });
  }

  const movies = sortItems(library?.movies ?? []);
  const tv     = sortItems(library?.tv ?? []);

  const q = search.toLowerCase();
  // Health-based filter — movies only, uses scan cache (ffmpeg ground truth).
  const matchesMovieHealthFilter = (item: MediaItem) => {
    if (healthFilter === "all") return true;
    if (!item.hasFile || !item.filePath) return false;
    const stem = stemOf(item.filePath);
    const job = optJobsByBasename.get(stem);
    if (job?.status === "completed") return healthFilter === "ready";
    const scanEntry = scanStatusByBasename[stem];
    if (!scanEntry) return false;
    const optimal = !scanEntry.needsOptimization;
    return healthFilter === "ready" ? optimal : !optimal;
  };

  const filteredMovies = movies.filter((movie) => {
    const matchesSearch = !q || movie.title.toLowerCase().includes(q);
    const matchesGenres =
      selectedGenres.length === 0 ||
      selectedGenres.every((genre) => movie.genres?.includes(genre));
    const matchesRating =
      minRating === null ||
      (typeof movie.rating === "number" && movie.rating >= minRating);
    return matchesSearch && matchesGenres && matchesRating && matchesMovieHealthFilter(movie);
  });
  const filteredTv = tv.filter((show) => {
    const matchesSearch = !q || show.title.toLowerCase().includes(q);
    const matchesGenres =
      selectedGenres.length === 0 ||
      selectedGenres.every((genre) => show.genres?.includes(genre));
    const matchesRating =
      minRating === null ||
      (typeof show.rating === "number" && show.rating >= minRating);
    return matchesSearch && matchesGenres && matchesRating;
  });
  const wantedItems = useMemo(
    () => [...(wantedTv?.records ?? []), ...(wantedMovies?.records ?? [])],
    [wantedTv?.records, wantedMovies?.records],
  );

  const loadNextMoviesChunk = useCallback(() => {
    setVisibleMovies((current) => Math.min(current + PAGE_CHUNK, filteredMovies.length));
  }, [PAGE_CHUNK, filteredMovies.length]);
  const loadNextTvChunk = useCallback(() => {
    setVisibleTv((current) => Math.min(current + PAGE_CHUNK, filteredTv.length));
  }, [PAGE_CHUNK, filteredTv.length]);

  useAutoLoadSentinel({
    targetRef: moviesLoadSentinelRef,
    enabled: tab === "movies" && !libraryLoading && filteredMovies.length > visibleMovies,
    onLoadMore: loadNextMoviesChunk,
  });
  useAutoLoadSentinel({
    targetRef: tvLoadSentinelRef,
    enabled: tab === "tv" && !libraryLoading && filteredTv.length > visibleTv,
    onLoadMore: loadNextTvChunk,
  });

  useEffect(() => {
    setVisibleMovies(PAGE_CHUNK);
    setVisibleTv(PAGE_CHUNK);
  }, [search, selectedGenres, minRating, sort, PAGE_CHUNK]);

  // Discovery: search externally when local results are sparse
  const filteredLocal = tab === "movies" ? filteredMovies : filteredTv;
  useEffect(() => {
    if (discoveryTimer.current) clearTimeout(discoveryTimer.current);
    if (tab !== "movies" && tab !== "tv") { setDiscoveryResults([]); return; }
    if (q.length < 3) { setDiscoveryResults([]); setDiscoveryLoading(false); return; }

    // Only search externally when local matches are few
    if (filteredLocal.length >= 3) { setDiscoveryResults([]); setDiscoveryLoading(false); return; }

    setDiscoveryLoading(true);
    discoveryTimer.current = setTimeout(() => {
      if (discoveryAbort.current) discoveryAbort.current.abort();
      const controller = new AbortController();
      discoveryAbort.current = controller;

      fetch(`${CORE_URL}/api/search?q=${encodeURIComponent(search)}`, {
        credentials: "include",
        signal: controller.signal,
      })
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (!data || controller.signal.aborted) return;
          const mediaType = tab === "movies" ? "movie" : "tv";
          const hits = (data.results ?? [])
            .filter((r: { kind: string; type?: string; inLibrary?: boolean }) =>
              r.kind === "media" && r.type === mediaType && !r.inLibrary)
            .slice(0, 12) as MediaSearchResult[];
          setDiscoveryResults(hits);
          setDiscoveryLoading(false);
        })
        .catch(() => { setDiscoveryLoading(false); });
    }, 400);

    return () => {
      if (discoveryTimer.current) clearTimeout(discoveryTimer.current);
      if (discoveryAbort.current) discoveryAbort.current.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, tab, filteredLocal.length]);

  const activeDownloads = activeTorrents.filter((t) => t?.state === "downloading").length;
  const queueCount = downloadQueue.length + activeDownloads;

  async function handleRetryQueueItem(item: DownloadQueueItem) {
    if (!item?.id) return;
    const app = item.type === "tv" ? "sonarr" : "radarr";
    setRetryingQueueId(item.id);
    setQueueRetryState((prev) => ({ ...prev, [item.id]: "running" }));
    try {
      const res = await fetch(`${CORE_URL}/api/media/queue/grab`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app, id: item.id }),
      });
      setQueueRetryState((prev) => ({ ...prev, [item.id]: res.ok ? "done" : "error" }));
    } finally {
      setRetryingQueueId(null);
      setTimeout(() => {
        setQueueRetryState((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
      }, 2200);
    }
  }

  async function handleRemoveQueueItem(item: DownloadQueueItem) {
    if (!item?.id) return;
    const app = item.type === "tv" ? "sonarr" : "radarr";
    setRemovingQueueIds((prev) => new Set(prev).add(item.id));
    try {
      await fetch(`${CORE_URL}/api/media/queue/${item.id}?app=${app}&removeFromClient=true`, {
        method: "DELETE",
      });
    } finally {
      // Item disappears on next SWR poll; clean up tracking state after a delay
      setTimeout(() => {
        setRemovingQueueIds((prev) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }, 3000);
    }
  }

  async function handleRemoveCalendarItem() {
    const target = calendarRemoveTarget;
    if (!target) return;
    const key = `${target.type}-${target.id}`;
    setCalendarRemoving(key);
    try {
      const endpoint = target.type === "tv"
        ? `${CORE_URL}/api/media/series/${target.id}?addImportExclusion=true`
        : `${CORE_URL}/api/media/movie/${target.id}?addImportExclusion=true`;
      const res = await fetch(endpoint, { method: "DELETE" });
      if (res.ok) {
        toast.success(`Removed "${target.title}" from ${target.type === "tv" ? "Sonarr" : "Radarr"}`);
        void mutateCalendar();
        void mutateLibrary();
      } else {
        toast.error(`Failed to remove "${target.title}"`);
      }
    } catch {
      toast.error(`Failed to remove "${target.title}"`);
    } finally {
      setCalendarRemoving(null);
      setCalendarRemoveTarget(null);
    }
  }

  async function handleWantedManualSearch(item: WantedRecord) {
    const key = `${item.app}-${item.id}`;
    setWantedPanels((prev) => ({
      ...prev,
      [key]: { loading: true, error: null, releases: prev[key]?.releases ?? [], grabbingTitle: null },
    }));
    try {
      const params = new URLSearchParams({
        app: item.app,
        qualityTier: "standard",
      });
      if (item.app === "sonarr") {
        if (item.seriesId) params.set("seriesId", String(item.seriesId));
        if (item.seasonNumber != null) params.set("seasonNumber", String(item.seasonNumber));
        if (item.episodeId) params.set("episodeId", String(item.episodeId));
      } else if (item.movieId) {
        params.set("movieId", String(item.movieId));
      }
      params.set("targetTitle", item.title);
      const res = await fetch(`${CORE_URL}/api/media/releases?${params.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setWantedPanels((prev) => ({
        ...prev,
        [key]: {
          loading: false,
          error: null,
          releases: (data.releases ?? []).slice(0, 6),
          grabbingTitle: null,
        },
      }));
    } catch (err: unknown) {
      setWantedPanels((prev) => ({
        ...prev,
        [key]: {
          loading: false,
          error: err instanceof Error ? err.message : "Failed to load releases",
          releases: [],
          grabbingTitle: null,
        },
      }));
    }
  }

  async function handleWantedGrabRelease(item: WantedRecord, release: { title: string; raw?: Record<string, unknown> }) {
    if (!item?.app || !release.raw) return;
    const key = `${item.app}-${item.id}`;
    setWantedPanels((prev) => ({
      ...prev,
      [key]: {
        ...(prev[key] ?? { loading: false, error: null, releases: [], grabbingTitle: null }),
        grabbingTitle: release.title,
      },
    }));
    try {
      const res = await fetch(`${CORE_URL}/api/media/releases/grab`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app: item.app,
          release: release.raw,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    } catch (err) {
      setWantedPanels((prev) => ({
        ...prev,
        [key]: {
          ...(prev[key] ?? { loading: false, error: null, releases: [], grabbingTitle: null }),
          error: err instanceof Error ? err.message : "Failed to submit release",
        },
      }));
    } finally {
      setWantedPanels((prev) => ({
        ...prev,
        [key]: {
          ...(prev[key] ?? { loading: false, error: null, releases: [], grabbingTitle: null }),
          grabbingTitle: null,
        },
      }));
    }
  }

  // Save scroll position and navigate to a detail page
  const navigateToDetail = useCallback((item: MediaItem) => {
    const scrollParent = document.querySelector(".overflow-y-auto") as HTMLElement | null;
    if (scrollParent) {
      sessionStorage.setItem("media-scroll-y", String(scrollParent.scrollTop));
    }
    router.push(`/dashboard/media/${item.type}/${item.id}`);
  }, [router]);

  // Selection key: "movie-123" or "tv-456"
  const toggleSelect = useCallback((item: MediaItem) => {
    const key = `${item.type}-${item.id}`;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  // Header actions — Cinema + Select in the shell header
  const setPageAction = useSetAtom(pageActionAtom);
  useEffect(() => {
    if (tab !== "movies" && tab !== "tv") {
      setPageAction(null);
      return;
    }
    setPageAction(
      <div className="ml-auto flex items-center gap-1.5 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="hidden md:inline-flex h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => cinemaBrowser.open(tab as "movies" | "tv")}
        >
          <HugeiconsIcon icon={Projector01Icon} size={14} />
          Cinema
        </Button>
        <Button
          variant={selectionMode ? "secondary" : "ghost"}
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => selectionMode ? exitSelectionMode() : setSelectionMode(true)}
        >
          {selectionMode ? "Cancel" : "Select"}
        </Button>
      </div>,
    );
    return () => setPageAction(null);
  }, [tab, selectionMode, setPageAction, cinemaBrowser, exitSelectionMode]);

  // Escape to exit selection
  useEffect(() => {
    if (!selectionMode) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") exitSelectionMode(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectionMode, exitSelectionMode]);

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setBulkDeleting(true);
    let success = 0;
    let failed = 0;
    for (const key of selectedIds) {
      const [itemType, idStr] = key.split("-");
      const endpoint = itemType === "movie"
        ? `${CORE_URL}/api/media/movie/${idStr}`
        : `${CORE_URL}/api/media/series/${idStr}`;
      const params = new URLSearchParams();
      if (bulkDeleteFiles) params.set("deleteFiles", "true");
      try {
        const res = await fetch(`${endpoint}?${params}`, { method: "DELETE" });
        if (res.ok) success++;
        else failed++;
      } catch {
        failed++;
      }
    }
    if (success > 0) toast.success(`Removed ${success} item${success === 1 ? "" : "s"} from library`);
    if (failed > 0) toast.error(`Failed to remove ${failed} item${failed === 1 ? "" : "s"}`);
    setBulkDeleting(false);
    setShowBulkDeleteDialog(false);
    setBulkDeleteFiles(false);
    exitSelectionMode();
    void mutateLibrary();
  }, [selectedIds, bulkDeleteFiles, exitSelectionMode, mutateLibrary]);

  // Handle card click: selection mode vs normal
  const handleCardClick = useCallback((item: MediaItem) => {
    if (selectionMode) {
      toggleSelect(item);
    } else {
      const ws = item.tmdbId ? plexWatchStatus?.watchStatus?.[`tmdb:${item.tmdbId}`] : undefined;
      setSelected({ kind: "library", data: item, watchStatus: ws });
    }
  }, [selectionMode, toggleSelect, plexWatchStatus]);

  const handleCardNavigate = useCallback((item: MediaItem) => {
    if (selectionMode) {
      toggleSelect(item);
    } else {
      navigateToDetail(item);
    }
  }, [selectionMode, toggleSelect, navigateToDetail]);

  const handleDiscoveryClick = useCallback((item: MediaSearchResult) => {
    const lookup: LookupItem = {
      tmdbId: item.tmdbId,
      tvdbId: item.tvdbId,
      title: item.name,
      year: item.year || null,
      type: item.type,
      poster: item.poster,
      overview: item.overview,
      rating: item.rating,
      genres: [],
      inLibrary: false as const,
    };
    setSelected({ kind: "lookup", data: lookup });
  }, []);

  // Handle removal from sheet
  const handleSheetRemoved = useCallback(() => {
    setSelected(null);
    void mutateLibrary();
  }, [mutateLibrary]);

  // Handle add from sheet (lookup → now in library)
  const handleSheetAdded = useCallback(() => {
    setSelected(null);
    setDiscoveryResults([]);
    setSearch("");
    void mutateLibrary();
  }, [mutateLibrary]);

  const requestsConfigured = requestsData?.configured !== false && (requestsData?.results?.length ?? 0) >= 0 && requestsData?.configured === true;
  const pendingRequestCount = requestsData?.results?.filter((r) => r.status === 1).length ?? 0;
  const watchlistCount = plexWatchlist?.items?.length ?? 0;
  const activityCount = (wantedItems.length + pendingRequestCount + watchlistCount) || undefined;

  // Build set of TMDB IDs in library for watchlist cross-reference
  const libraryTmdbIds = useMemo(() => {
    const ids = new Set<number>();
    for (const m of library?.movies ?? []) { if (m.tmdbId) ids.add(m.tmdbId); }
    for (const s of library?.tv ?? []) { if (s.tmdbId) ids.add(s.tmdbId); }
    return ids;
  }, [library?.movies, library?.tv]);

  const tabs: { id: Tab; label: string; icon: typeof Film01Icon; count?: number }[] = [
    { id: "movies", label: "Movies", icon: Film01Icon, count: movies.length },
    { id: "tv", label: "TV Shows", icon: Tv01Icon, count: tv.length },
    { id: "downloads", label: "Downloads", icon: Download01Icon, count: queueCount || undefined },
    { id: "calendar", label: "Calendar", icon: Calendar01Icon },
    { id: "activity", label: "Activity", icon: Notification01Icon, count: activityCount },
  ];

  // Show stack setup when no media apps are installed or configured
  if (!stackLoading && mediaStack && mediaStack.readiness === 0) {
    return (
      <StackSetup
        stackId="media"
        onSetupWithAI={(prompt) => router.push(`/dashboard/assistant?prompt=${encodeURIComponent(prompt)}`)}
      />
    );
  }

  return (
    <div className="grid gap-5">
      {/* Controls: tabs + search + sort */}
      <div className="page-controls-row flex-wrap justify-between gap-2">
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v as Tab);
            setSearch("");
            setSort("added-desc");
            setSelectedGenres([]);
            setMinRating(null);
            setHealthFilter("all");
          }}
        >
          <TabsList>
            {tabs.map((t) => (
              <TabsTrigger
                key={t.id}
                id={`media-tab-${t.id}`}
                value={t.id}
                className="text-xs gap-1.5"
              >
                <HugeiconsIcon icon={t.icon} size={14} />
                {t.count !== undefined && t.count > 0 && (
                  <TabsBadge>{t.count}</TabsBadge>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end sm:gap-2">
          {(tab === "movies" || tab === "tv") && (
            <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:gap-2">
              <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                <SelectTrigger className="h-8 w-full min-w-0 text-xs sm:w-auto sm:min-w-[7rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="added-desc">Recently added</SelectItem>
                  <SelectItem value="added-asc">Oldest first</SelectItem>
                  <SelectItem value="title-asc">Title A–Z</SelectItem>
                  <SelectItem value="title-desc">Title Z–A</SelectItem>
                  <SelectItem value="year-desc">Year (newest)</SelectItem>
                  <SelectItem value="year-asc">Year (oldest)</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={minRating === null ? "any" : String(minRating)}
                onValueChange={(v) => setMinRating(v === "any" ? null : Number(v))}
              >
                <SelectTrigger className="h-8 w-full min-w-0 text-xs sm:w-auto sm:min-w-[6rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any rating</SelectItem>
                  <SelectItem value="6">6.0+</SelectItem>
                  <SelectItem value="7">7.0+</SelectItem>
                  <SelectItem value="8">8.0+</SelectItem>
                  <SelectItem value="9">9.0+</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <SearchField
            containerClassName="flex-1 w-full sm:w-auto"
            placeholder={`Search ${tab === "movies" ? "movies" : tab === "tv" ? "shows" : ""}...`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {(tab === "movies" || tab === "tv") && (
        <MediaFiltersRow
          items={tab === "movies" ? movies : tv}
          selectedGenres={selectedGenres}
          minRating={minRating}
          onToggleGenre={(genre) => {
            setSelectedGenres((prev) =>
              prev.includes(genre)
                ? prev.filter((g) => g !== genre)
                : [...prev, genre]
            );
          }}
          onClearFilters={() => {
            setSelectedGenres([]);
            setMinRating(null);
          }}
        />
      )}

      {/* Continue Watching — horizontal row from Plex on-deck */}
      {(() => {
        const items = plexWatchingData?.continueWatching?.filter(
          (cw) => (tab === "movies" ? cw.type === "movie" : cw.type === "tv")
        ) ?? [];
        if (items.length === 0) return null;
        return (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground font-medium px-1">Continue Watching</p>
            <div className="flex gap-3 overflow-x-auto scrollbar-none pb-1 -mx-1 px-1">
              {items.map((cw, i) => {
                const pct = cw.viewOffset && cw.duration && cw.duration > 0
                  ? Math.min(100, (cw.viewOffset / cw.duration) * 100)
                  : 0;
                const thumb = cw.thumb
                  ? `${CORE_URL}/api/media/poster?service=plex&path=${encodeURIComponent(cw.thumb)}&w=120`
                  : null;
                return (
                  <div key={cw.ratingKey ?? i} className="shrink-0 w-[90px]">
                    <div className="relative aspect-[2/3] rounded-lg overflow-hidden bg-muted/30">
                      {thumb ? (
                        <Image src={thumb} alt={cw.title ?? ""} fill className="object-cover" sizes="90px" />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <HugeiconsIcon icon={cw.type === "tv" ? Tv01Icon : Film01Icon} size={16} className="text-dim-foreground" />
                        </div>
                      )}
                      {pct > 0 && (
                        <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/60">
                          <div className="h-full bg-white/80 rounded-r-full" style={{ width: `${pct}%` }} />
                        </div>
                      )}
                    </div>
                    <p className="text-xs font-medium truncate mt-1.5 text-foreground">{cw.title}</p>
                    {cw.episodeTitle && (
                      <p className="text-[10px] text-muted-foreground truncate">
                        {cw.parentIndex != null && cw.index != null ? `S${cw.parentIndex}E${cw.index} · ` : ""}
                        {cw.episodeTitle}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Movie optimization bar — movies tab only, shows per-movie counts */}
      {tab === "movies" && movieOptCounts.scanned > 0 && (
        <div className="flex items-center justify-between gap-4 px-1 py-1">
          <div className="flex items-center gap-2 sm:gap-3 text-xs text-muted-foreground flex-wrap">
            <button
              type="button"
              onClick={() => setHealthFilter(healthFilter === "ready" ? "all" : "ready")}
              className={`rounded-full px-2 py-0.5 transition-colors ${healthFilter === "ready" ? "bg-status-healthy/15 text-status-healthy" : "hover:bg-muted/50"}`}
            >
              <span className="font-medium tabular-nums">{movieOptCounts.ready}</span> movies ready
            </button>
            {movieOptCounts.needsConversion > 0 && (
              <>
                <span className="text-border">·</span>
                <button
                  type="button"
                  onClick={() => setHealthFilter(healthFilter === "needs-conversion" ? "all" : "needs-conversion")}
                  className={`rounded-full px-2 py-0.5 transition-colors ${healthFilter === "needs-conversion" ? "bg-status-warning/15 text-status-warning" : "hover:bg-muted/50"}`}
                >
                  <span className="font-medium tabular-nums">{movieOptCounts.needsConversion}</span> need conversion
                </button>
              </>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs shrink-0"
            disabled={scanning}
            onClick={async () => {
              setScanning(true);
              try {
                const pathsRes = await fetch(`${CORE_URL}/api/optimization/scan-paths`, { credentials: "include" });
                const pathsData = pathsRes.ok ? await pathsRes.json() as { paths?: string[]; tagged?: { path: string; source: string }[] } : { paths: [] as string[] };
                const cfgRes = await fetch(`${CORE_URL}/api/optimization/config`, { credentials: "include" });
                const cfg = cfgRes.ok ? await cfgRes.json() as { mediaTypes?: string } : { mediaTypes: "all" };
                let scanPaths: string[];
                if (cfg.mediaTypes && cfg.mediaTypes !== "all" && pathsData.tagged?.length) {
                  scanPaths = pathsData.tagged
                    .filter((t) => t.source === cfg.mediaTypes)
                    .map((t) => t.path);
                } else {
                  scanPaths = (pathsData.paths as string[]) ?? [];
                }
                if (scanPaths.length === 0) { toast.error("No media directories found"); setScanning(false); return; }
                const res = await fetch(`${CORE_URL}/api/optimization/scan`, {
                  method: "POST", credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ paths: scanPaths, queueJobs: false }),
                });
                if (res.ok) {
                  const data = await res.json();
                  void mutateScanStatus();
                  if (data.queued > 0) {
                    toast(`Found ${data.queued} files needing conversion`);
                  } else {
                    toast("Library is fully optimized");
                  }
                }
              } catch { toast.error("Scan failed"); }
              finally { setScanning(false); }
            }}
          >
            {scanning ? <Spinner className="h-3 w-3" /> : <HugeiconsIcon icon={Search01Icon} size={14} />}
            {scanning ? "Scanning..." : "Scan"}
          </Button>
        </div>
      )}

      {/* Content */}
      {tab === "movies" && (
        libraryLoading ? (
          <div className="media-grid">
            {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="h-[200px] rounded-lg" />)}
          </div>
        ) : libraryError ? (
          <EmptyState
            icon={Film01Icon}
            title="Unable to load movies"
            description="The media server returned an error. Check that Talome's backend is running."
          />
        ) : library?.radarrAvailable === false && filteredMovies.length === 0 ? (
          <EmptyState
            icon={Film01Icon}
            title="Radarr is not reachable"
            description="Check that Radarr is running and the URL is correct in settings."
          />
        ) : filteredMovies.length === 0 && !(q.length >= 3 && (discoveryResults.length > 0 || discoveryLoading)) ? (
          <EmptyState
            icon={Film01Icon}
            title={search || selectedGenres.length > 0 || minRating !== null
              ? "No movies match those filters"
              : "Your movie library is empty"}
            description={search || selectedGenres.length > 0 || minRating !== null
              ? "Try a longer search to discover new titles."
              : "Search for a movie above to add it to your library."}
            action={!(search || selectedGenres.length > 0 || minRating !== null) ? (
              <Button variant="outline" size="sm" asChild>
                <a href="/dashboard/assistant?prompt=Help+me+set+up+a+media+server+stack">
                  Set up media stack
                </a>
              </Button>
            ) : undefined}
          />
        ) : filteredMovies.length > 0 ? (
          <div className="media-grid">
            {filteredMovies.slice(0, visibleMovies).map((m, i) => <MediaCard key={m.id} item={m} onClick={handleCardClick} onNavigate={handleCardNavigate} watchStatus={m.tmdbId ? plexWatchStatus?.watchStatus?.[`tmdb:${m.tmdbId}`] : undefined} selected={selectionMode && selectedIds.has(`movie-${m.id}`)} selectionMode={selectionMode} priority={i < 8} optStatus={m.filePath ? optJobsByBasename.get(stemOf(m.filePath)) : undefined} />)}
          </div>
        ) : null
      )}
      {tab === "movies" && filteredMovies.length > visibleMovies && (
        <div ref={moviesLoadSentinelRef} className="flex justify-center py-2">
          <span className="text-xs text-muted-foreground">Loading more movies...</span>
        </div>
      )}

      {/* Discovery results — movies */}
      {tab === "movies" && (discoveryResults.length > 0 || discoveryLoading) && (
        <div className="mt-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground tracking-wide shrink-0">
              {discoveryLoading ? "Searching..." : "Not in your library"}
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>
          {discoveryResults.length > 0 && (
            <div className="media-grid">
              {discoveryResults.map((r, i) => (
                <DiscoveryCard key={r.id} item={r} onClick={handleDiscoveryClick} priority={i < 4} />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "tv" && (
        libraryLoading ? (
          <div className="media-grid">
            {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="h-[200px] rounded-lg" />)}
          </div>
        ) : libraryError ? (
          <EmptyState
            icon={Tv01Icon}
            title="Unable to load TV shows"
            description="The media server returned an error. Check that Talome's backend is running."
          />
        ) : library?.sonarrAvailable === false && filteredTv.length === 0 ? (
          <EmptyState
            icon={Tv01Icon}
            title="Sonarr is not reachable"
            description="Check that Sonarr is running and the URL is correct in settings."
          />
        ) : filteredTv.length === 0 && !(q.length >= 3 && (discoveryResults.length > 0 || discoveryLoading)) ? (
          <EmptyState
            icon={Tv01Icon}
            title={search || selectedGenres.length > 0 || minRating !== null
              ? "No shows match those filters"
              : "Your TV library is empty"}
            description={search || selectedGenres.length > 0 || minRating !== null
              ? "Try a longer search to discover new titles."
              : "Search for a show above to add it to your library."}
            action={!(search || selectedGenres.length > 0 || minRating !== null) ? (
              <Button variant="outline" size="sm" asChild>
                <a href="/dashboard/assistant?prompt=Help+me+set+up+a+media+server+stack">
                  Set up media stack
                </a>
              </Button>
            ) : undefined}
          />
        ) : filteredTv.length > 0 ? (
          <div className="media-grid">
            {filteredTv.slice(0, visibleTv).map((s, i) => <MediaCard key={s.id} item={s} onClick={handleCardClick} onNavigate={handleCardNavigate} watchStatus={s.tmdbId ? plexWatchStatus?.watchStatus?.[`tmdb:${s.tmdbId}`] : undefined} selected={selectionMode && selectedIds.has(`tv-${s.id}`)} selectionMode={selectionMode} priority={i < 8} optStatus={s.filePath ? optJobsByBasename.get(stemOf(s.filePath)) : undefined} />)}
          </div>
        ) : null
      )}
      {tab === "tv" && filteredTv.length > visibleTv && (
        <div ref={tvLoadSentinelRef} className="flex justify-center py-2">
          <span className="text-xs text-muted-foreground">Loading more shows...</span>
        </div>
      )}

      {/* Discovery results — TV */}
      {tab === "tv" && (discoveryResults.length > 0 || discoveryLoading) && (
        <div className="mt-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground tracking-wide shrink-0">
              {discoveryLoading ? "Searching..." : "Not in your library"}
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>
          {discoveryResults.length > 0 && (
            <div className="media-grid">
              {discoveryResults.map((r, i) => (
                <DiscoveryCard key={r.id} item={r} onClick={handleDiscoveryClick} priority={i < 4} />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "downloads" && (
        <div className="grid gap-3">
          <p className="text-xs text-muted-foreground">
            Content acquired via connected services is your responsibility. Ensure compliance with applicable laws in your jurisdiction.
          </p>
          {/* Loading skeleton */}
          {!downloads && (
            <div className="grid gap-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-20 rounded-lg" />
              ))}
            </div>
          )}

          {/* Unified list — queue items (with enriched speed/eta) + unmatched raw torrents */}
          {downloads && (downloadQueue.length > 0 || activeTorrents.length > 0) && (
            <div className="grid gap-2">
              {(() => {
                const seenKeys = new Map<string, number>();
                return downloadQueue.map((q) => {
                  const baseKey = `q-${q.type}-${q.id}-${q.downloadId ?? q.title}`;
                  const duplicateIndex = seenKeys.get(baseKey) ?? 0;
                  seenKeys.set(baseKey, duplicateIndex + 1);
                  const key = duplicateIndex === 0 ? baseKey : `${baseKey}-${duplicateIndex}`;
                  return (
                    <DownloadQueueRow
                      key={key}
                      item={q}
                      onRetry={handleRetryQueueItem}
                      onRemove={handleRemoveQueueItem}
                      retryingId={retryingQueueId}
                      retryState={queueRetryState[q.id] ?? "idle"}
                      removing={removingQueueIds.has(q.id)}
                    />
                  );
                });
              })()}
              {activeTorrents.map((t) => (
                <DownloadTorrentRow key={t.hash} torrent={t} />
              ))}
            </div>
          )}

          {downloads && downloadQueue.length === 0 && activeTorrents.length === 0 && (
            <EmptyState icon={Download01Icon} title="Nothing downloading" description="Downloads from Sonarr, Radarr, and qBittorrent will appear here." />
          )}
        </div>
      )}

      {tab === "calendar" && (
        <div className="grid gap-4">
          {/* Loading skeleton */}
          {!calendar && (
            <div className="grid gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 rounded-lg" />
              ))}
            </div>
          )}
          {(calendar?.episodes?.length ?? 0) > 0 && (
            <section>
              <h2 className="media-section-label">Upcoming Episodes</h2>
              <div className="grid gap-2">
                {calendar!.episodes.map((ep) => (
                  <CalendarCard
                    key={ep.id}
                    poster={ep.poster}
                    type="tv"
                    title={ep.seriesTitle}
                    subtitle={ep.title}
                    meta={`S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`}
                    date={new Date(ep.airDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    onRemove={ep.seriesId ? () => setCalendarRemoveTarget({ type: "tv", id: ep.seriesId!, title: ep.seriesTitle }) : undefined}
                    removing={calendarRemoving === `tv-${ep.seriesId}`}
                  />
                ))}
              </div>
            </section>
          )}

          {(calendar?.movies?.length ?? 0) > 0 && (
            <section>
              <h2 className="media-section-label">Upcoming Movies</h2>
              <div className="grid gap-2">
                {calendar!.movies.map((m) => (
                  <CalendarCard
                    key={m.id}
                    poster={m.poster}
                    type="movie"
                    title={m.title}
                    subtitle={m.year ? String(m.year) : undefined}
                    date={m.releaseDate
                      ? new Date(m.releaseDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                      : "TBA"}
                    onRemove={() => setCalendarRemoveTarget({ type: "movie", id: m.id, title: m.title })}
                    removing={calendarRemoving === `movie-${m.id}`}
                  />
                ))}
              </div>
            </section>
          )}

          {calendar && !calendar.episodes?.length && !calendar.movies?.length && (
            <EmptyState icon={Calendar01Icon} title="No upcoming releases" description="Nothing scheduled in the next 14 days." />
          )}
        </div>
      )}

      {tab === "activity" && (() => {
        const hasWatchlist = plexWatchlist?.configured && (plexWatchlist.items?.length ?? 0) > 0;
        const hasRequests = requestsConfigured && (requestsData?.results?.length ?? 0) > 0;
        const hasWanted = wantedItems.length > 0;
        const sectionCount = [hasWatchlist, hasRequests, hasWanted].filter(Boolean).length;

        if (!hasWatchlist && !hasRequests && !hasWanted) {
          return <EmptyState icon={PlayListAddIcon} title="No activity" description="Watchlist items, requests, and wanted media will appear here." />;
        }

        return (
          <div className="grid gap-6">
            {hasWatchlist && (
              <section>
                {sectionCount > 1 && <h2 className="media-section-label">Watchlist</h2>}
                <WatchlistSection items={plexWatchlist!.items} libraryTmdbIds={libraryTmdbIds} />
              </section>
            )}

            {hasRequests && (
              <section>
                {sectionCount > 1 && <h2 className="media-section-label">Requests</h2>}
                <RequestsTab
                  requests={requestsData!.results}
                  onMutate={() => void mutateRequests()}
                />
              </section>
            )}

            {hasWanted && (
              <section>
                {sectionCount > 1 && <h2 className="media-section-label">Wanted</h2>}
                <div className="grid gap-2">
                  {wantedItems.map((w) => (
                    <div key={`${w.app}-${w.id}`} className="grid gap-1">
                      <WantedRow
                        item={w}
                        onManualSearch={handleWantedManualSearch}
                        active={Boolean(wantedPanels[`${w.app}-${w.id}`])}
                      />
                      <AnimatePresence initial={false}>
                        {wantedPanels[`${w.app}-${w.id}`] && (
                          <motion.div
                            key={`panel-${w.app}-${w.id}`}
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ height: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }, opacity: { duration: 0.15 } }}
                            className="overflow-hidden"
                          >
                            <div className="pt-1">
                              <WantedReleasePanel
                                loading={wantedPanels[`${w.app}-${w.id}`].loading}
                                error={wantedPanels[`${w.app}-${w.id}`].error}
                                releases={wantedPanels[`${w.app}-${w.id}`].releases}
                                grabbingTitle={wantedPanels[`${w.app}-${w.id}`].grabbingTitle}
                                onClose={() => {
                                  setWantedPanels((prev) => {
                                    const next = { ...prev };
                                    delete next[`${w.app}-${w.id}`];
                                    return next;
                                  });
                                }}
                                onGrab={(release) => handleWantedGrabRelease(w, release)}
                              />
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        );
      })()}

      {/* Detail sheet */}
      <UnifiedMediaSheet
        item={selected}
        onClose={() => setSelected(null)}
        onRemoved={handleSheetRemoved}
        onAdded={handleSheetAdded}
      />

      {/* Floating selection bar */}
      <AnimatePresence>
        {selectionMode && selectedIds.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
            className="fixed bottom-6 inset-x-0 z-50 flex justify-center pointer-events-none pb-[env(safe-area-inset-bottom)]"
          >
            <div className="flex items-center gap-1 rounded-full bg-foreground text-background px-4 py-2 shadow-lg pointer-events-auto">
              <span className="text-sm font-medium tabular-nums whitespace-nowrap">{selectedIds.size} selected</span>
              <div className="w-px h-4 bg-background/15 mx-1" />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2.5 text-xs text-status-critical hover:text-status-critical hover:bg-status-critical/15"
                onClick={() => setShowBulkDeleteDialog(true)}
              >
                <HugeiconsIcon icon={Delete01Icon} size={14} />
                <span className="hidden sm:inline">Remove</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2.5 text-xs text-background/70 hover:text-background hover:bg-background/10"
                onClick={exitSelectionMode}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={14} />
                <span className="hidden sm:inline">Cancel</span>
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bulk delete confirmation dialog */}
      <Dialog
        open={showBulkDeleteDialog}
        onOpenChange={(open) => {
          if (!open && !bulkDeleting) {
            setShowBulkDeleteDialog(false);
            setBulkDeleteFiles(false);
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remove {selectedIds.size} item{selectedIds.size === 1 ? "" : "s"} from library</DialogTitle>
            <DialogDescription>
              This will remove the selected media from {tab === "movies" ? "Radarr" : tab === "tv" ? "Sonarr" : "Radarr/Sonarr"}.
              They will no longer appear in your library.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center justify-between gap-3 py-1">
            <div>
              <p className="text-sm font-medium">Delete files from disk</p>
              <p className="text-xs text-muted-foreground">Permanently remove media files from disk</p>
            </div>
            <Switch checked={bulkDeleteFiles} onCheckedChange={setBulkDeleteFiles} />
          </label>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowBulkDeleteDialog(false)} disabled={bulkDeleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleBulkDelete} disabled={bulkDeleting}>
              {bulkDeleting ? <Spinner className="size-3.5" /> : `Remove ${selectedIds.size} item${selectedIds.size === 1 ? "" : "s"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Calendar item removal confirmation */}
      <Dialog
        open={!!calendarRemoveTarget}
        onOpenChange={(open) => { if (!open && !calendarRemoving) setCalendarRemoveTarget(null); }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remove &ldquo;{calendarRemoveTarget?.title}&rdquo;</DialogTitle>
            <DialogDescription>
              This will remove the {calendarRemoveTarget?.type === "tv" ? "series" : "movie"} from {calendarRemoveTarget?.type === "tv" ? "Sonarr" : "Radarr"} and add it to the exclusion list to prevent it from being re-added.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCalendarRemoveTarget(null)} disabled={!!calendarRemoving}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRemoveCalendarItem} disabled={!!calendarRemoving}>
              {calendarRemoving ? <Spinner className="size-3.5" /> : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MediaFiltersRow({
  items,
  selectedGenres,
  minRating,
  onToggleGenre,
  onClearFilters,
}: {
  items: MediaItem[];
  selectedGenres: string[];
  minRating: number | null;
  onToggleGenre: (genre: string) => void;
  onClearFilters: () => void;
}) {
  const allGenres = useMemo(() => {
    const genres = new Set<string>();
    for (const item of items) {
      for (const genre of item.genres ?? []) {
        if (genre) genres.add(genre);
      }
    }
    return Array.from(genres).sort((a, b) => a.localeCompare(b));
  }, [items]);

  const hasActiveFilters = selectedGenres.length > 0 || minRating !== null;

  if (allGenres.length === 0 && !hasActiveFilters) return null;

  return (
    <div className="grid gap-2">
      {allGenres.length > 0 && (
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            onClick={onClearFilters}
            className={`h-6 px-2 rounded-full border text-xs transition-colors shrink-0 ${
              selectedGenres.length === 0 && minRating === null
                ? "border-foreground/30 bg-foreground/8 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            all
          </button>
          <div className="filter-rail min-w-0 flex-1">
            <div className="flex items-center gap-1.5 overflow-x-auto whitespace-nowrap scrollbar-none">
              {allGenres.map((genre) => {
                const active = selectedGenres.includes(genre);
                return (
                  <button
                    key={genre}
                    type="button"
                    onClick={() => onToggleGenre(genre)}
                    className={`h-6 px-2 rounded-full border text-xs transition-colors shrink-0 ${
                      active
                        ? "border-foreground/30 bg-foreground/8 text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {genre}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {hasActiveFilters && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground truncate">
            {selectedGenres.length > 0 ? selectedGenres.join(" · ") : "All genres"}
            {minRating !== null ? ` · ${minRating.toFixed(1)}+` : ""}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs shrink-0"
            onClick={onClearFilters}
          >
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}

function MediaPageWithParams() {
  const searchParams = useSearchParams();
  const rawTab = searchParams.get("tab");
  const initialTab: Tab =
    rawTab === "movies" || rawTab === "tv" || rawTab === "downloads" || rawTab === "calendar" || rawTab === "activity"
      ? rawTab
      : "movies";
  const initialSearch = searchParams.get("q") ?? "";
  const initialGenres = searchParams.getAll("genre").filter(Boolean);
  const initialMinRatingRaw = searchParams.get("rating");
  const initialMinRating = initialMinRatingRaw ? Number(initialMinRatingRaw) : null;
  const initialCinema = searchParams.get("cinema") === "1";

  return (
    <MediaPageInner
      key={searchParams.toString()}
      initialTab={initialTab}
      initialSearch={initialSearch}
      initialGenres={initialGenres}
      initialMinRating={Number.isFinite(initialMinRating) ? initialMinRating : null}
      initialCinema={initialCinema}
    />
  );
}

export default function MediaPage() {
  return (
    <Suspense fallback={<div className="grid gap-5"><Skeleton className="h-10 rounded-lg" /></div>}>
      <MediaPageWithParams />
    </Suspense>
  );
}
