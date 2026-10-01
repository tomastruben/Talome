"use client";

import {
  useEffect,
  useState,
  Suspense,
  useMemo,
  useRef,
  useCallback,
  useDeferredValue,
  type ReactNode,
} from "react";
import Image from "next/image";
import { useSearchParams, useRouter } from "next/navigation";
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
  Add01Icon,
  UserIcon,
} from "@/components/icons";
import { tiltHandlers } from "@/components/ui/micro";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { useDownloads } from "@/hooks/use-downloads";
import type { DownloadQueueItem, DownloadTorrent, MediaSearchResult } from "@talome/types";
import {
  getDownloadDisplayStatus,
  getDownloadHealthFacts,
  getTorrentDisplayStatus,
} from "@/lib/download-status";
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
import { AnimatePresence, motion } from "motion/react";
import { DURATION, SKELETON_DELAY_MS, tween } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { requestDesktopNavigation } from "@/lib/desktop-navigation";
import {
  type MediaItem,
  type LookupItem,
  formatSize,
  UnifiedMediaSheet,
  type SheetItem,
} from "@/components/media/media-detail-sheet";
import { ReleaseSearchPanel } from "@/components/media/release-search-panel";
import { MediaFiltersRow } from "@/components/media/media-filters-row";
import { MediaSelectionBar } from "@/components/media/media-selection-bar";
import { RequestsTab } from "@/components/media/requests-tab";
import { WatchlistSection } from "@/components/media/watching-tab";
import { useCinemaBrowser } from "@/components/media/cinema-browser-context";
import { preloadCinemaBrowser } from "@/components/media/cinema-browser-launcher";
import { Projector01Icon } from "@/components/icons";
import { useSetAtom } from "jotai";
import { pageActionAtom } from "@/atoms/page-action";
import { desktopAppActionsAtom } from "@/atoms/desktop-app-actions";
import {
  WINDOW_SIDEBAR_REPLACES,
  WINDOW_SIDEBAR_SHOWS,
  WindowSidebarLayout,
  useWindowSidebarShown,
} from "@/components/ui/source-list";
import { DesktopAppToolbar } from "@/components/desktop/desktop-app-toolbar";
import { useFeatureStack } from "@/hooks/use-feature-stacks";
import { StackSetup } from "@/components/ui/stack-setup";
import {
  continueWatchingFallbackRoute,
  resolveContinueWatchingRoute,
} from "@/lib/media-navigation";
import {
  useMediaCalendar,
  useMediaLibrary,
  useMediaRequests,
  useMediaWanted,
  useMovieHealth,
  usePlexWatching,
  usePlexWatchlist,
  usePlexWatchStatus,
  useHourClock,
  mediaSourceStatus,
  sourceFailed,
  wantedTotal,
  watchStatusOrNull,
  type MediaSourceStatus,
  type PlexContinueWatchingItem,
  type WantedRecord,
} from "@/components/media/media-data";
import {
  DEFAULT_MEDIA_VIEW_STATE,
  MEDIA_SORT_KEYS,
  MEDIA_VIEW_PARAM_KEYS,
  RATING_OPTIONS,
  SORT_LABELS,
  availableCollections,
  collectionLabel,
  fileStem,
  filterLibrary,
  genreCounts,
  hasCinemaParam,
  isLibraryTab,
  matchesCollection,
  parseMediaViewState,
  serializeMediaViewState,
  sortLibrary,
  viewSummary,
  viewTitle,
  type ActivitySection,
  type CollectionContext,
  type LibraryTab,
  type MediaCollection,
  type MediaLocation,
  type MediaSortKey,
  type MediaTab,
  type MediaViewState,
} from "@/components/media/media-library-view";
import { MediaWindowSidebar } from "@/components/media/media-window-sidebar";
import { MEDIA_VIEW_INLINE, MEDIA_VIEW_MENU, MediaViewMenu } from "@/components/media/media-view-menu";

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

// ── Helpers ──────────────────────────────────────────────────────────────────

const PAGE_CHUNK = 120;
const SCROLL_KEY = "media-scroll-y";
/** Search is written to the URL once typing pauses. */
const SEARCH_URL_DEBOUNCE_MS = 300;
/** Our own URL writes come back through useSearchParams; recognise them for this long. */
const ECHO_WINDOW_MS = 2000;

const numberFormat = new Intl.NumberFormat();
const listFormat = new Intl.ListFormat(undefined, { type: "conjunction" });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function formatDay(value: string | undefined | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : dayFormat.format(date);
}

/** True once `flag` has stayed true for `delayMs`: skeletons never flash on fast loads. */
function useDelayedFlag(flag: boolean, delayMs = SKELETON_DELAY_MS) {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!flag) return;
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => {
      clearTimeout(timer);
      setElapsed(false);
    };
  }, [flag, delayMs]);
  return flag && elapsed;
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
  stalled:       { label: "Stalled",      color: "text-status-warning" },
  paused:        { label: "Paused",       color: "text-muted-foreground" },
  queued:        { label: "Queued",       color: "text-muted-foreground" },
};

function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-sm font-medium text-muted-foreground">{children}</h2>;
}

// ── Skeletons (shaped like the result) ───────────────────────────────────────

function LibrarySkeleton() {
  return (
    <div className="media-grid" aria-hidden="true">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="min-w-0">
          <Skeleton className="aspect-2/3 w-full rounded-lg" />
          <Skeleton className="mt-2 h-4 w-3/4" />
          <Skeleton className="mt-1.5 h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

function RowsSkeleton({ rows, className }: { rows: number; className: string }) {
  return (
    <div className="grid gap-2" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={cn("w-full rounded-lg", className)} />
      ))}
    </div>
  );
}

// ── Source states ─────────────────────────────────────────────────────────────

/** A source that never answered, or that core couldn't reach: names the app and the fix. */
function SourceErrorState({
  app,
  what,
  status,
  onRetry,
}: {
  app: string;
  /** What failed to load, in running text ("your watchlist"). */
  what: string;
  status: MediaSourceStatus;
  onRetry: () => void;
}) {
  return status === "unreachable" ? (
    <ErrorState
      fill
      title={`Couldn't reach ${app}`}
      description={`Talome couldn't connect to ${app}. Check that it's running and its address is right in Services, then retry.`}
      onRetry={onRetry}
    />
  ) : (
    <ErrorState
      fill
      title={`Couldn't load ${what}`}
      description={`Talome couldn't get ${what} from ${app}. Check that the server is running, then retry.`}
      onRetry={onRetry}
    />
  );
}

/** One line above data that stays on screen while part of it couldn't be loaded or refreshed. */
function SourceStatusLine({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <p className="flex items-center gap-1 text-xs text-muted-foreground" role="status">
      {message} ·
      <Button variant="ghost" size="xs" className="pointer-coarse:h-11 pointer-coarse:px-3" onClick={onRetry}>Retry</Button>
    </p>
  );
}

/** Picks what a view shows from where its source stands. */
function bySourceStatus(
  status: MediaSourceStatus,
  cases: { loading: ReactNode; failed: ReactNode; notConfigured: ReactNode; ready: () => ReactNode },
): ReactNode {
  switch (status) {
    case "loading": return cases.loading;
    case "error":
    case "unreachable": return cases.failed;
    case "not-configured": return cases.notConfigured;
    case "ready": return cases.ready();
  }
}

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
  const displayStatus = getDownloadDisplayStatus(item);
  const statusInfo = QUEUE_STATUS_MAP[displayStatus] ?? { label: displayStatus, color: "text-muted-foreground" };
  const healthFacts = displayStatus === "stalled" ? getDownloadHealthFacts(item) : [];
  const eta = item.eta != null ? formatEta(item.eta) : "";
  const resolved = resolvePosterUrl(item.poster, 120);
  const [imgFailed, setImgFailed] = useState(false);
  const warningDetails = [
    item.errorMessage?.trim() ?? "",
    ...((item.statusMessages ?? []).map((message) => message.trim())),
  ].filter((message) => message.length > 0);
  const warningDetailText = warningDetails.length > 0 ? Array.from(new Set(warningDetails)).join(" • ") : null;
  const statusClass = retryState === "running"
    ? "text-primary motion-safe:animate-pulse"
    : retryState === "done"
      ? "text-status-healthy"
      : retryState === "error"
        ? "text-destructive"
        : statusInfo.color;
  const statusLabel = retryState === "running"
    ? "Retrying"
    : retryState === "done"
      ? "Retried"
      : retryState === "error"
        ? "Retry failed"
        : statusInfo.label;

  return (
    <div className="group/row relative rounded-lg overflow-hidden border border-border/50 bg-card flex items-stretch min-h-22">
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
                  <span className={`text-xs mt-px cursor-help ${statusClass}`} aria-label="Show warning details">
                    {statusLabel}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-80 text-xs leading-snug">
                  {warningDetailText}
                </TooltipContent>
              </Tooltip>
            ) : (
              <span className={`text-xs mt-px ${statusClass}`}>{statusLabel}</span>
            )}
            {(item.status === "failed" || item.status === "warning") && onRetry && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-primary/80 hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-60 pointer-coarse:size-11"
                    onClick={() => onRetry(item)}
                    disabled={retryingId === item.id}
                    aria-label={retryingId === item.id ? "Retrying download" : "Retry download"}
                  >
                    <HugeiconsIcon icon={Refresh01Icon} size={14} className={retryingId === item.id ? "motion-safe:animate-spin" : ""} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  {retryingId === item.id ? "Retrying…" : "Retry"}
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
          {healthFacts.length > 0 && (
            <p className="text-xs text-status-warning tabular-nums">
              {healthFacts.join(" · ")}
            </p>
          )}
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
  const status = getTorrentDisplayStatus(torrent);
  const statusColor = {
    default: "text-muted-foreground",
    healthy: "text-status-healthy",
    warning: "text-status-warning",
    critical: "text-status-critical",
  }[status.tone];
  const eta = formatEta(torrent.eta);
  const resolved = resolvePosterUrl(torrent.poster, 120);
  const [imgFailed, setImgFailed] = useState(false);

  return (
    <div className="relative rounded-lg overflow-hidden border border-border/50 bg-card flex items-stretch min-h-22">
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
          <span className={`text-xs shrink-0 mt-px ${statusColor}`}>{status.label}</span>
        </div>

        <div className="space-y-1.5">
          {status.detail && (
            <p className="text-xs leading-snug text-muted-foreground">
              {status.detail}
            </p>
          )}
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
    <button
      type="button"
      aria-expanded={active}
      className={cn(
        "group relative flex h-18 w-full items-stretch overflow-hidden rounded-lg border bg-card text-left transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        active ? "border-primary/30" : "border-border/50 hover:border-border/80",
      )}
      onClick={() => onManualSearch?.(item)}
    >
      <span className="relative block w-12 shrink-0 border-r border-border/40 bg-muted/40">
        {resolved && !imgFailed ? (
          <Image
            src={resolved}
            alt=""
            className="object-cover" fill
            onError={() => setImgFailed(true)}
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center">
            <HugeiconsIcon icon={item.app === "sonarr" ? Tv01Icon : Film01Icon} size={14} className="text-dim-foreground" />
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-3 px-3.5">
        <span className="block min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-snug">{item.title}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {[item.app === "sonarr" ? "Sonarr" : "Radarr", item.year ?? null, item.quality ?? null].filter(Boolean).join(" · ")}
          </span>
        </span>
        <HugeiconsIcon
          icon={Search01Icon}
          size={14}
          className="shrink-0 text-dim-foreground"
        />
      </span>
    </button>
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

// ── CalendarCard ─────────────────────────────────────────────────────────────

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
    <div className="group relative rounded-lg overflow-hidden border border-border/50 bg-card flex items-stretch h-18">
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
          <p className="text-sm font-medium text-muted-foreground tabular-nums">{date}</p>
          {meta && <p className="text-xs text-muted-foreground mt-0.5 font-mono">{meta}</p>}
        </div>
      </div>

      {/* Remove button */}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${title}`}
          className="shrink-0 w-9 flex items-center justify-center border-l border-border/30 text-dim-foreground hover:text-destructive transition-colors duration-150 opacity-0 group-hover:opacity-100 focus:opacity-100 pointer-coarse:opacity-100"
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

// ── Cards ────────────────────────────────────────────────────────────────────

function mediaName(title: string, year?: number | null) {
  return year ? `${title} (${year})` : title;
}

/**
 * A poster card. It is a button: its name is the title and year, Enter or
 * Space opens it, and in selection mode it reports whether it is selected.
 */
function MediaCard({
  item,
  onActivate,
  watchStatus,
  selected,
  selectionMode,
  priority,
  optStatus,
}: {
  item: MediaItem;
  onActivate: (item: MediaItem) => void;
  watchStatus?: "watched" | "in-progress";
  selected?: boolean;
  selectionMode?: boolean;
  priority?: boolean;
  optStatus?: { status: string; progress: number };
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const label = item.type === "tv"
    ? `${item.seasonCount ?? 0}S · ${item.episodeCount ?? 0}E`
    : item.hasFile ? "In library" : "Missing";
  const container = item.type === "movie" ? item.quality?.container : null;
  const containerPlays = (() => {
    if (!container) return false;
    const c = container.toLowerCase();
    const v = (item.quality?.codec ?? "").toLowerCase();
    return (c === "mp4" || c === "m4v") && (v === "h264" || v === "x264" || v === "hevc" || v === "h265" || v === "x265");
  })();

  return (
    <button
      type="button"
      className="media-card group text-left"
      aria-label={mediaName(item.title, item.year)}
      aria-pressed={selectionMode ? !!selected : undefined}
      onClick={() => onActivate(item)}
    >
      <span className="media-card-poster tm-tilt block" {...tiltHandlers}>
        {item.poster && !imgFailed ? (
          <Image
            src={resolvePosterUrl(item.poster, 400) ?? ""}
            alt=""
            className="object-cover" fill
            sizes="(max-width: 640px) 33vw, (max-width: 1024px) 20vw, 200px"
            priority={priority}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center">
            <HugeiconsIcon
              icon={item.type === "tv" ? Tv01Icon : Film01Icon}
              size={28}
              className="text-dim-foreground"
            />
          </span>
        )}
        {/* Hover, focus and selection ring, drawn inside the artwork so no
            scroller or rail can clip it. Hover never scales the poster. */}
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 z-10 rounded-lg ring-2 ring-inset transition-colors duration-150 ease-out group-focus-visible:ring-ring",
            selected ? "ring-primary" : "ring-transparent group-hover:ring-foreground/20",
          )}
        />
        {/* Overlays sit on artwork, so they use the dark palette in both themes. */}
        {selectionMode && (
          <span className="dark absolute top-1.5 left-1.5 z-10">
            <span className={cn(
              "flex size-5 items-center justify-center rounded-full transition-colors duration-150",
              selected ? "bg-foreground" : "border border-foreground/30 bg-background/70",
            )}>
              {selected && <HugeiconsIcon icon={CheckmarkCircle01Icon} size={14} className="text-background" />}
            </span>
          </span>
        )}
        {!selectionMode && watchStatus && (
          <span className="dark absolute top-1.5 right-1.5 z-10">
            <span className="block rounded-full bg-background/70 p-0.5">
              <HugeiconsIcon
                icon={watchStatus === "watched" ? CheckmarkCircle01Icon : PlayIcon}
                size={14}
                className={watchStatus === "watched" ? "text-status-healthy" : "text-status-info"}
              />
            </span>
          </span>
        )}
        {(optStatus?.status === "running" || optStatus?.status === "queued") && (
          <span className="dark absolute inset-x-0 bottom-0 z-10 block h-1 overflow-hidden rounded-b bg-background/70">
            {optStatus.status === "running" ? (
              <span className="block h-full bg-status-healthy transition-[width] duration-200 ease-linear" style={{ width: `${optStatus.progress * 100}%` }} />
            ) : (
              <span className="block h-full w-full bg-muted-foreground/40 motion-safe:animate-pulse" />
            )}
          </span>
        )}
      </span>
      <span className="min-w-0 mt-2 block px-0.5">
        <span className="block truncate text-sm font-medium leading-tight">{item.title}</span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          {item.year && (
            <Pill variant="secondary" className="text-xs py-0 px-1.5 h-4 rounded-sm font-normal tabular-nums">
              {item.year}
            </Pill>
          )}
          <Pill variant="secondary" className="text-xs py-0 px-1.5 h-4 rounded-sm font-normal truncate max-w-24">
            {label}
          </Pill>
          {container && (
            <Pill
              variant="secondary"
              className={cn(
                "text-xs py-0 px-1.5 h-4 rounded-sm font-normal",
                containerPlays ? "bg-status-healthy/12 text-status-healthy" : "bg-status-warning/12 text-status-warning",
              )}
            >
              {container.toUpperCase()}
            </Pill>
          )}
        </span>
        {(item.sizeOnDisk ?? 0) > 0 && (
          <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">{formatSize(item.sizeOnDisk!)}</span>
        )}
      </span>
    </button>
  );
}

function DiscoveryCard({ item, onClick, priority }: { item: MediaSearchResult; onClick: (item: MediaSearchResult) => void; priority?: boolean }) {
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <button
      type="button"
      className="media-card group text-left"
      aria-label={mediaName(item.name, item.year > 0 ? item.year : null)}
      onClick={() => onClick(item)}
    >
      <span className="media-card-poster block opacity-75 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
        {item.poster && !imgFailed ? (
          <Image
            src={resolvePosterUrl(item.poster, 400) ?? ""}
            alt=""
            className="object-cover" fill
            sizes="(max-width: 640px) 33vw, (max-width: 1024px) 20vw, 200px"
            priority={priority}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center">
            <HugeiconsIcon
              icon={item.type === "tv" ? Tv01Icon : Film01Icon}
              size={28}
              className="text-dim-foreground"
            />
          </span>
        )}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 rounded-lg ring-2 ring-inset ring-transparent transition-colors duration-150 ease-out group-hover:ring-foreground/20 group-focus-visible:ring-ring"
        />
        <span className="dark absolute top-1.5 right-1.5 z-10">
          <span className="block rounded-full bg-foreground/80 p-0.5">
            <HugeiconsIcon icon={Add01Icon} size={14} className="text-background" />
          </span>
        </span>
      </span>
      <span className="min-w-0 mt-2 block px-0.5">
        <span className="block truncate text-sm font-medium leading-tight">{item.name}</span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          {item.year > 0 && (
            <Pill variant="secondary" className="text-xs py-0 px-1.5 h-4 rounded-sm font-normal tabular-nums">
              {item.year}
            </Pill>
          )}
          {typeof item.rating === "number" && item.rating > 0 && (
            <Pill variant="secondary" className="text-xs py-0 px-1.5 h-4 rounded-sm font-normal tabular-nums">
              {item.rating.toFixed(1)}
            </Pill>
          )}
        </span>
      </span>
    </button>
  );
}

function ContinueWatchingCard({
  item,
  onOpen,
  className,
}: {
  item: PlexContinueWatchingItem;
  onOpen: (item: PlexContinueWatchingItem) => void;
  className?: string;
}) {
  const pct = item.viewOffset && item.duration && item.duration > 0
    ? Math.min(100, (item.viewOffset / item.duration) * 100)
    : 0;
  const thumb = item.thumb
    ? `${CORE_URL}/api/media/poster?service=plex&path=${encodeURIComponent(item.thumb)}&w=240`
    : null;
  const title = item.title?.trim() || (item.type === "tv" ? "TV show" : "Movie");
  return (
    <button
      type="button"
      className={cn("group text-left outline-none", className)}
      onClick={() => onOpen(item)}
      aria-label={`Open ${title}`}
    >
      <span className="relative block aspect-2/3 overflow-hidden rounded-lg bg-muted/30">
        {thumb ? (
          <Image
            src={thumb}
            alt=""
            fill
            className="object-cover transition-[filter] duration-150 ease-out group-hover:brightness-110"
            sizes="(max-width: 640px) 33vw, 160px"
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center">
            <HugeiconsIcon icon={item.type === "tv" ? Tv01Icon : Film01Icon} size={16} className="text-dim-foreground" />
          </span>
        )}
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-lg ring-2 ring-inset ring-transparent transition-colors duration-150 ease-out group-hover:ring-foreground/20 group-focus-visible:ring-ring" />
        {pct > 0 && (
          <span className="dark absolute inset-x-0 bottom-0 block h-1 bg-background/70">
            <span className="block h-full rounded-r-full bg-foreground/80" style={{ width: `${pct}%` }} />
          </span>
        )}
      </span>
      <span className="mt-1.5 block truncate text-xs font-medium text-foreground">{title}</span>
      {item.episodeTitle && (
        <span className="block truncate text-xs text-muted-foreground">
          {item.parentIndex != null && item.index != null ? `S${item.parentIndex}E${item.index} · ` : ""}
          {item.episodeTitle}
        </span>
      )}
    </button>
  );
}

// ── Copy for library states ──────────────────────────────────────────────────

const COLLECTION_EMPTY: Record<Exclude<MediaCollection, "all">, { title: string; description: string }> = {
  recent: { title: "Nothing added in the last 30 days", description: "Titles show here for 30 days after they're added to your library." },
  unwatched: { title: "You've watched everything", description: "Every movie in your library is marked watched in Plex." },
  missing: { title: "No missing files", description: "Every released movie you monitor has a file on disk." },
  ready: { title: "No movies ready yet", description: "Scan your library to check which files play directly in the browser." },
  "needs-conversion": { title: "Nothing to convert", description: "Every scanned movie plays directly in the browser." },
};

const ACTIVITY_SECTION_ICONS: Record<Exclude<ActivitySection, "all">, typeof Film01Icon> = {
  continue: PlayIcon,
  watchlist: PlayListAddIcon,
  requests: UserIcon,
  wanted: Search01Icon,
};

// ── Page ─────────────────────────────────────────────────────────────────────

function MediaPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const paramsString = searchParams.toString();

  const [view, setView] = useState<MediaViewState>(() => parseMediaViewState(searchParams));
  const { tab, collection, section, search, sort, genres: selectedGenres, minRating } = view;
  const patchView = useCallback((patch: Partial<MediaViewState>) => {
    setView((current) => ({ ...current, ...patch }));
  }, []);

  /** The last of Movies or TV shows: collections, Cinema and the detail route follow it. */
  const lastLibraryTabRef = useRef<LibraryTab>(isLibraryTab(view.tab) ? view.tab : "movies");
  useEffect(() => {
    if (isLibraryTab(tab)) lastLibraryTabRef.current = tab;
  }, [tab]);
  const libraryTab: LibraryTab = isLibraryTab(tab) ? tab : lastLibraryTabRef.current;

  const [selected, setSelected] = useState<SheetItem | null>(null);
  const [scanning, setScanning] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_CHUNK);
  const [retryingQueueId, setRetryingQueueId] = useState<number | null>(null);
  const [queueRetryState, setQueueRetryState] = useState<Record<number, "idle" | "running" | "done" | "error">>({});
  const [removingQueueIds, setRemovingQueueIds] = useState<Set<number>>(new Set());
  const [wantedPanels, setWantedPanels] = useState<Record<string, WantedReleasePanelState>>({});
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Cinema browser
  const cinemaBrowser = useCinemaBrowser();
  /** In a window with its sidebar on screen, collections live in the sidebar. */
  const windowSidebarShown = useWindowSidebarShown();

  // Feature stack readiness — show setup when nothing is configured
  const { stack: mediaStack, isLoading: stackLoading } = useFeatureStack("media");

  // ── URL ⇄ view ─────────────────────────────────────────────────────────────
  // One writer keeps the URL in step with the view (search once typing
  // pauses). It calls replaceState with a null state: Next.js treats a call
  // that carries its own history state (`__NA`) as internal and ignores it,
  // so useSearchParams, the router's URL and the desktop window's route would
  // all keep the old URL. With null, Next.js copies its state over and
  // reports the new URL back through useSearchParams; those echoes are
  // recognised and ignored, so only a real outside change (a link, the
  // desktop opening this window at a new URL) re-applies the view. The page
  // never remounts on a URL change.
  const lastWrittenRef = useRef<string>(serializeMediaViewState(view));
  const pendingWritesRef = useRef<{ value: string; at: number }[]>([]);
  const consumedCinemaRef = useRef<string | null>(null);

  useEffect(() => {
    const next = serializeMediaViewState(view);
    const current = new URLSearchParams(window.location.search);
    const rest = new URLSearchParams();
    current.forEach((value, key) => {
      if (!MEDIA_VIEW_PARAM_KEYS.includes(key)) rest.append(key, value);
    });
    const query = [next, rest.toString()].filter(Boolean).join("&");
    const target = query ? `?${query}` : "";
    if (target === window.location.search) {
      lastWrittenRef.current = next;
      return;
    }
    const write = () => {
      const now = Date.now();
      pendingWritesRef.current = [
        ...pendingWritesRef.current.filter((entry) => now - entry.at < ECHO_WINDOW_MS),
        { value: next, at: now },
      ];
      lastWrittenRef.current = next;
      window.history.replaceState(null, "", `${window.location.pathname}${target}${window.location.hash}`);
    };
    const inUrl = parseMediaViewState(current);
    const onlySearchChanged = inUrl.search !== view.search
      && serializeMediaViewState({ ...inUrl, search: view.search }) === next;
    if (!onlySearchChanged) {
      write();
      return;
    }
    const timer = setTimeout(write, SEARCH_URL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [view]);

  useEffect(() => {
    const params = new URLSearchParams(paramsString);
    const incoming = serializeMediaViewState(parseMediaViewState(params));
    const now = Date.now();
    const pending = pendingWritesRef.current.filter((entry) => now - entry.at < ECHO_WINDOW_MS);
    const echo = pending.findIndex((entry) => entry.value === incoming);
    if (echo >= 0) {
      // Our own write (or an older one Next.js reports late): not a navigation.
      pendingWritesRef.current = pending.slice(echo + 1);
    } else {
      pendingWritesRef.current = pending;
      if (incoming !== lastWrittenRef.current) {
        lastWrittenRef.current = incoming;
        // Keep the same state object when the view already matches (no re-render)
        setView((current) => (serializeMediaViewState(current) === incoming ? current : parseMediaViewState(params)));
      }
    }
    // ?cinema=1 opens Cinema once; the writer strips it from the URL.
    if (hasCinemaParam(params) && consumedCinemaRef.current !== paramsString) {
      consumedCinemaRef.current = paramsString;
      const parsed = parseMediaViewState(params);
      cinemaBrowser.open(isLibraryTab(parsed.tab) ? parsed.tab : "movies");
    }
    // cinemaBrowser.open is stable for the page's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsString]);

  // ── Data ───────────────────────────────────────────────────────────────────
  const { data: library, error: libraryError, mutate: mutateLibrary } = useMediaLibrary();
  const health = useMovieHealth(library?.movies);
  const { data: plexWatchStatus, error: plexWatchStatusError, mutate: mutatePlexWatchStatus } = usePlexWatchStatus();
  const watchStatusMap = watchStatusOrNull(plexWatchStatus);
  const {
    data: downloads,
    torrents: activeTorrents,
    queue: downloadQueue,
    totalCount: pendingDownloadCount,
    activity: downloadActivity,
    error: downloadsError,
    retry: retryDownloads,
  } = useDownloads();
  const { data: calendar, error: calendarError, mutate: mutateCalendar } = useMediaCalendar();
  const { data: wantedTv, error: wantedTvError, mutate: mutateWantedTv } = useMediaWanted("sonarr");
  const { data: wantedMovies, error: wantedMoviesError, mutate: mutateWantedMovies } = useMediaWanted("radarr");
  const { data: requestsData, error: requestsError, mutate: mutateRequests } = useMediaRequests();
  const { data: plexWatchlist, error: plexWatchlistError, mutate: mutatePlexWatchlist } = usePlexWatchlist();
  const { data: plexWatchingData, error: plexWatchingError, mutate: mutatePlexWatching } = usePlexWatching();

  const [calendarRemoving, setCalendarRemoving] = useState<string | null>(null);
  const [calendarRemoveTarget, setCalendarRemoveTarget] = useState<{ type: "tv" | "movie"; id: number; title: string } | null>(null);

  // ── Library view (memoised: large libraries stay responsive while typing) ──
  const deferredSearch = useDeferredValue(search);
  const now = useHourClock();
  const collectionCtx = useMemo<CollectionContext>(
    () => ({ now, watchStatus: watchStatusMap, health: health.healthOf }),
    [now, watchStatusMap, health.healthOf],
  );
  const libraryItems = useMemo(
    () => (library ? (libraryTab === "movies" ? library.movies : library.tv) : null),
    [library, libraryTab],
  );
  const sortedItems = useMemo(() => (libraryItems ? sortLibrary(libraryItems, sort) : []), [libraryItems, sort]);
  const collectionItems = useMemo(
    () => (collection === "all" ? sortedItems : sortedItems.filter((item) => matchesCollection(item, collection, collectionCtx))),
    [sortedItems, collection, collectionCtx],
  );
  const filteredItems = useMemo(
    () => filterLibrary(collectionItems, { search: deferredSearch, genres: selectedGenres, minRating, collection: "all" }, collectionCtx),
    [collectionItems, deferredSearch, selectedGenres, minRating, collectionCtx],
  );
  const railGenres = useMemo(
    () => (libraryItems ? genreCounts(libraryItems).map((g) => g.genre).sort((a, b) => a.localeCompare(b)) : []),
    [libraryItems],
  );
  const showCollections = useMemo(() => {
    const available = availableCollections(libraryTab, collectionCtx);
    return available.includes(collection) ? available : [...available, collection];
  }, [libraryTab, collectionCtx, collection]);
  const filtersActive = search.trim() !== "" || selectedGenres.length > 0 || minRating !== null;

  const moviesLoadSentinelRef = useRef<HTMLDivElement | null>(null);
  const loadNextChunk = useCallback(() => {
    setVisibleCount((current) => Math.min(current + PAGE_CHUNK, filteredItems.length));
  }, [filteredItems.length]);
  useAutoLoadSentinel({
    targetRef: moviesLoadSentinelRef,
    enabled: isLibraryTab(tab) && !!library && filteredItems.length > visibleCount,
    onLoadMore: loadNextChunk,
  });
  useEffect(() => {
    setVisibleCount(PAGE_CHUNK);
  }, [tab, collection, deferredSearch, selectedGenres, minRating, sort]);

  const showLibrarySkeleton = useDelayedFlag(isLibraryTab(tab) && !library && !libraryError);
  const showDownloadsSkeleton = useDelayedFlag(tab === "downloads" && !downloads && !downloadsError);
  const showCalendarSkeleton = useDelayedFlag(tab === "calendar" && !calendar && !calendarError);

  // ── Collections decided by Plex or the scan ────────────────────────────────
  // Unwatched needs Plex watch status; Ready to play and Needs conversion need
  // the scan. Until that data answers (or when it failed), the collection's
  // count and its empty copy would be guesses.
  const watchStatusStatus = mediaSourceStatus(plexWatchStatus, plexWatchStatusError);
  const healthCollection = collection === "ready" || collection === "needs-conversion";
  const collectionUndecided = (collection === "unwatched" && watchStatusMap === null)
    || (healthCollection && health.healthOf === null && (health.scanPending || !!health.scanError));
  const showCollectionSkeleton = useDelayedFlag(
    isLibraryTab(tab) && !!library && (
      (collection === "unwatched" && watchStatusStatus === "loading")
      || (healthCollection && health.healthOf === null && health.scanPending)
    ),
  );

  // ── Scroll: remember the position across a detail visit ───────────────────
  const contentScroller = useCallback(
    () => rootRef.current?.closest<HTMLElement>("[data-content-scroll]") ?? null,
    [],
  );
  const libraryLoaded = !!library;
  useEffect(() => {
    if (!libraryLoaded) return;
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(SCROLL_KEY);
      if (saved !== null) sessionStorage.removeItem(SCROLL_KEY);
    } catch {
      return;
    }
    const top = saved === null ? NaN : Number(saved);
    if (!Number.isFinite(top)) return;
    const frame = requestAnimationFrame(() => contentScroller()?.scrollTo({ top }));
    return () => cancelAnimationFrame(frame);
  }, [libraryLoaded, contentScroller]);

  // ── Discovery search (external lookup when local results are sparse) ──────
  const [discoveryResults, setDiscoveryResults] = useState<MediaSearchResult[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const discoveryAbort = useRef<AbortController | null>(null);
  const discoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const q = search.trim().toLowerCase();
  const filteredCount = filteredItems.length;
  useEffect(() => {
    if (discoveryTimer.current) clearTimeout(discoveryTimer.current);
    if (!isLibraryTab(tab) || q.length < 3 || filteredCount >= 3) {
      setDiscoveryResults([]);
      setDiscoveryLoading(false);
      return;
    }

    setDiscoveryLoading(true);
    discoveryTimer.current = setTimeout(() => {
      if (discoveryAbort.current) discoveryAbort.current.abort();
      const controller = new AbortController();
      discoveryAbort.current = controller;

      fetch(`${CORE_URL}/api/search?q=${encodeURIComponent(q)}`, {
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
  }, [q, tab, filteredCount]);
  const discoveryActive = q.length >= 3 && (discoveryResults.length > 0 || discoveryLoading);

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
    } catch {
      setQueueRetryState((prev) => ({ ...prev, [item.id]: "error" }));
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
        toast.error(`Couldn't remove "${target.title}"`);
      }
    } catch {
      toast.error(`Couldn't remove "${target.title}"`);
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
          error: err instanceof Error ? err.message : "Couldn't load releases",
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
          error: err instanceof Error ? err.message : "Couldn't submit the release",
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
    const scroller = contentScroller();
    if (scroller) {
      try {
        sessionStorage.setItem(SCROLL_KEY, String(scroller.scrollTop));
      } catch {
        // Storage unavailable (private mode): the list just opens at the top.
      }
    }
    router.push(`/dashboard/media/${item.type}/${item.id}`);
  }, [router, contentScroller]);

  const navigateToContinueWatching = useCallback((item: PlexContinueWatchingItem) => {
    const route = resolveContinueWatchingRoute(item, [
      ...(library?.movies ?? []),
      ...(library?.tv ?? []),
    ]) ?? continueWatchingFallbackRoute(item);
    router.push(route);
  }, [library?.movies, library?.tv, router]);

  const openServices = useCallback(() => {
    const href = "/dashboard/containers";
    if (!requestDesktopNavigation(href)) router.push(href);
  }, [router]);

  // Batch selection
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [bulkDeleteFiles, setBulkDeleteFiles] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

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
  const setDesktopAppActions = useSetAtom(desktopAppActionsAtom);
  useEffect(() => {
    if (tab !== "movies" && tab !== "tv") {
      setPageAction(null);
      setDesktopAppActions([]);
      return;
    }
    setPageAction(
      <div className="ml-auto flex items-center gap-1.5 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="hidden md:inline-flex h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground pointer-coarse:h-11"
          onClick={() => cinemaBrowser.open(tab)}
          onPointerEnter={preloadCinemaBrowser}
          onFocus={preloadCinemaBrowser}
        >
          <HugeiconsIcon icon={Projector01Icon} size={14} />
          Cinema
        </Button>
        <Button
          variant={selectionMode ? "secondary" : "ghost"}
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground pointer-coarse:h-11"
          onClick={() => selectionMode ? exitSelectionMode() : setSelectionMode(true)}
        >
          {selectionMode ? "Cancel" : "Select"}
        </Button>
      </div>,
    );
    setDesktopAppActions([
      {
        id: "cinema",
        label: "Cinema",
        icon: "projector",
        onSelect: () => cinemaBrowser.open(tab),
      },
      {
        id: "select",
        label: selectionMode ? "Cancel" : "Select",
        active: selectionMode,
        onSelect: () => selectionMode ? exitSelectionMode() : setSelectionMode(true),
      },
    ]);
    return () => {
      setPageAction(null);
      setDesktopAppActions([]);
    };
  }, [
    tab,
    selectionMode,
    setPageAction,
    setDesktopAppActions,
    cinemaBrowser,
    exitSelectionMode,
  ]);

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
    if (failed > 0) toast.error(`Couldn't remove ${failed} item${failed === 1 ? "" : "s"}`);
    setBulkDeleting(false);
    setShowBulkDeleteDialog(false);
    setBulkDeleteFiles(false);
    exitSelectionMode();
    void mutateLibrary();
  }, [selectedIds, bulkDeleteFiles, exitSelectionMode, mutateLibrary]);

  // A card opens the detail page, or toggles it while selecting
  const handleCardActivate = useCallback((item: MediaItem) => {
    if (selectionMode) toggleSelect(item);
    else navigateToDetail(item);
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
    patchView({ search: "" });
    void mutateLibrary();
  }, [mutateLibrary, patchView]);

  // ── Activity sources: only answered, reachable data is shown as a fact ────
  const watchingStatus = mediaSourceStatus(plexWatchingData, plexWatchingError);
  const watchlistStatus = mediaSourceStatus(plexWatchlist, plexWatchlistError);
  const requestsStatus = mediaSourceStatus(requestsData, requestsError);
  const wantedTvStatus = mediaSourceStatus(wantedTv, wantedTvError);
  const wantedMoviesStatus = mediaSourceStatus(wantedMovies, wantedMoviesError);
  const requestsReady = requestsStatus === "ready";
  const requestItems = useMemo(() => requestsData?.results ?? [], [requestsData]);
  const pendingRequestCount = requestsReady ? requestItems.filter((r) => r.status === 1).length : 0;
  const continueItems = useMemo(() => plexWatchingData?.continueWatching ?? [], [plexWatchingData]);
  const watchlistItems = useMemo(() => plexWatchlist?.items ?? [], [plexWatchlist]);
  const wantedItems = useMemo(
    () => [...(wantedTv?.records ?? []), ...(wantedMovies?.records ?? [])],
    [wantedTv?.records, wantedMovies?.records],
  );
  const wantedCount = wantedTotal(wantedTv, wantedMovies);
  /** Sonarr and Radarr have both answered, with data or a failure. */
  const wantedSettled = wantedTvStatus !== "loading" && wantedMoviesStatus !== "loading";
  /** Neither app could be read, so "Nothing wanted" would be a guess. */
  const wantedFailed = sourceFailed(wantedTvStatus) && sourceFailed(wantedMoviesStatus);
  const hasContinue = watchingStatus === "ready" && continueItems.length > 0;
  const hasWatchlist = watchlistStatus === "ready" && watchlistItems.length > 0;
  const hasRequests = requestsReady && requestItems.length > 0;
  const hasWanted = wantedItems.length > 0;
  const activitySettled = wantedSettled
    && watchingStatus !== "loading" && watchlistStatus !== "loading" && requestsStatus !== "loading";
  const activityPending = (() => {
    switch (section) {
      case "continue": return watchingStatus === "loading";
      case "watchlist": return watchlistStatus === "loading";
      case "requests": return requestsStatus === "loading";
      case "wanted": return !hasWanted && !wantedSettled;
      default: return !hasContinue && !hasWatchlist && !hasRequests && !hasWanted && !activitySettled;
    }
  })();
  const showActivitySkeleton = useDelayedFlag(tab === "activity" && activityPending);

  // Build set of TMDB IDs in library for watchlist cross-reference
  const libraryTmdbIds = useMemo(() => {
    const ids = new Set<number>();
    for (const m of library?.movies ?? []) { if (m.tmdbId) ids.add(m.tmdbId); }
    for (const s of library?.tv ?? []) { if (s.tmdbId) ids.add(s.tmdbId); }
    return ids;
  }, [library?.movies, library?.tv]);

  // ── Navigation between views ──────────────────────────────────────────────
  /** Switching tab starts a fresh view: no search, filters, collection or section. */
  const selectTab = useCallback((next: MediaTab) => {
    setView({ ...DEFAULT_MEDIA_VIEW_STATE, genres: [], tab: next });
  }, []);

  const navigateTo = useCallback((location: MediaLocation) => {
    setView((current) => current.tab === location.tab
      ? { ...current, collection: location.collection, section: location.section }
      : { ...DEFAULT_MEDIA_VIEW_STATE, genres: [], ...location });
  }, []);

  const setGenres = useCallback((genres: string[]) => {
    setView((current) => ({ ...current, genres }));
  }, []);

  // Show stack setup when no media apps are installed or configured
  if (!stackLoading && mediaStack && mediaStack.readiness === 0) {
    return (
      <StackSetup
        stackId="media"
        onSetupWithAI={(prompt) => router.push(`/dashboard/assistant?prompt=${encodeURIComponent(prompt)}`)}
      />
    );
  }

  // ── Toolbar ────────────────────────────────────────────────────────────────
  const tabs: { id: MediaTab; label: string; icon: typeof Film01Icon; badge: ReactNode; ariaLabel: string }[] = [
    {
      id: "movies",
      label: "Movies",
      icon: Film01Icon,
      badge: (library?.movies.length ?? 0) > 0 ? <TabsBadge>{numberFormat.format(library!.movies.length)}</TabsBadge> : null,
      ariaLabel: "Movies",
    },
    {
      id: "tv",
      label: "TV shows",
      icon: Tv01Icon,
      badge: (library?.tv.length ?? 0) > 0 ? <TabsBadge>{numberFormat.format(library!.tv.length)}</TabsBadge> : null,
      ariaLabel: "TV shows",
    },
    {
      id: "downloads",
      label: "Downloads",
      icon: Download01Icon,
      badge: downloads && pendingDownloadCount > 0 ? <TabsBadge>{numberFormat.format(pendingDownloadCount)}</TabsBadge> : null,
      ariaLabel: "Downloads",
    },
    { id: "calendar", label: "Calendar", icon: Calendar01Icon, badge: null, ariaLabel: "Calendar" },
    {
      id: "activity",
      label: "Activity",
      icon: Notification01Icon,
      badge: pendingRequestCount > 0 ? <Badge variant="count">{numberFormat.format(pendingRequestCount)}</Badge> : null,
      ariaLabel: pendingRequestCount > 0
        ? `Activity, ${numberFormat.format(pendingRequestCount)} ${pendingRequestCount === 1 ? "request" : "requests"} awaiting approval`
        : "Activity",
    },
  ];

  const isLibrary = isLibraryTab(tab);
  const noun = libraryTab === "movies" ? "movies" : "shows";
  const heading = viewTitle(view);
  const summaryTotal: number | null = (() => {
    if (isLibrary) return library && !collectionUndecided ? collectionItems.length : null;
    if (tab === "downloads") return downloads ? pendingDownloadCount : null;
    if (tab === "calendar") return calendar ? calendar.episodes.length + calendar.movies.length : null;
    if (tab === "activity") {
      if (section === "continue") return watchingStatus === "ready" ? continueItems.length : null;
      if (section === "watchlist") return watchlistStatus === "ready" ? watchlistItems.length : null;
      if (section === "requests") return requestsReady ? pendingRequestCount : null;
      if (section === "wanted") return wantedSettled ? wantedCount : null;
    }
    return null;
  })();
  const summary = viewSummary(view, {
    total: summaryTotal,
    shown: isLibrary ? (library ? filteredItems.length : null) : summaryTotal,
    attention: downloads ? downloadActivity.counts.attention : null,
  }, numberFormat);

  const setCollection = (next: MediaCollection) => patchView({ collection: next });
  const setSort = (next: MediaSortKey) => patchView({ sort: next });
  const setMinRating = (next: number | null) => patchView({ minRating: next });

  // One row: where you are on the left (the tab strip, or in a window with a
  // sidebar the heading), search and the view controls on the right. The
  // selects fold into one menu where the content column is narrow; only when
  // the tab strip and the search can't share a row does search drop to a
  // second line (narrow windows without a sidebar, phones). The search widens
  // only in a window's column: on the classic page the labelled tab strip
  // shares the row, and it fits with every count and badge showing only at
  // w-48 (the toolbar-fit model in media-window-layout.test.tsx).
  const toolbar = (
    <DesktopAppToolbar className="flex min-w-0 flex-wrap items-center gap-2">
      <Tabs
        className={cn(WINDOW_SIDEBAR_REPLACES, "shrink-0")}
        value={tab}
        onValueChange={(v) => selectTab(v as MediaTab)}
      >
        {/* On touch each tab is a 44px target; below @4xl they are icon-only */}
        <TabsList className="pointer-coarse:h-12">
          {tabs.map((t) => (
            <TabsTrigger
              key={t.id}
              id={`media-tab-${t.id}`}
              value={t.id}
              aria-label={t.ariaLabel}
              title={t.label}
              className="text-xs gap-1.5 pointer-coarse:h-11 pointer-coarse:min-w-11"
            >
              <HugeiconsIcon icon={t.icon} size={14} />
              <span className="hidden @4xl:inline">{t.label}</span>
              {t.badge}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* In a window the sidebar names the place; the heading says where you are. */}
      <div className={cn(WINDOW_SIDEBAR_SHOWS, "min-w-0 flex-1 flex-col")}>
        <h1 className="truncate text-sm font-medium leading-5">{heading}</h1>
        {summary && <p className="truncate text-xs leading-4 tabular-nums text-muted-foreground">{summary}</p>}
      </div>

      {isLibrary && (
        <div data-media-view-controls="" className="ml-auto flex min-w-0 items-center justify-end gap-2 @max-md:w-full">
          <SearchField
            containerClassName="min-w-0 w-48 @3xl/content:w-56 @max-md:w-auto @max-md:max-w-none @max-md:flex-1"
            className="h-8 pointer-coarse:h-11"
            placeholder={tab === "movies" ? "Search movies…" : "Search shows…"}
            aria-label={tab === "movies" ? "Search movies" : "Search shows"}
            value={search}
            onChange={(e) => patchView({ search: e.target.value })}
          />
          <div className={cn(MEDIA_VIEW_INLINE, "shrink-0 items-center gap-2")}>
            {showCollections.length > 1 && (
              <Select value={collection} onValueChange={(v) => setCollection(v as MediaCollection)}>
                <SelectTrigger
                  aria-label="Show"
                  className={cn(WINDOW_SIDEBAR_REPLACES, "h-8 min-w-28 text-xs pointer-coarse:h-11")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {showCollections.map((c) => (
                    <SelectItem key={c} value={c}>{collectionLabel(libraryTab, c)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={sort} onValueChange={(v) => setSort(v as MediaSortKey)}>
              <SelectTrigger aria-label="Sort" className="h-8 min-w-28 text-xs pointer-coarse:h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEDIA_SORT_KEYS.map((key) => (
                  <SelectItem key={key} value={key}>{SORT_LABELS[key]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={minRating === null ? "any" : String(minRating)}
              onValueChange={(v) => setMinRating(v === "any" ? null : Number(v))}
            >
              <SelectTrigger aria-label="Minimum rating" className="h-8 min-w-24 text-xs pointer-coarse:h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any rating</SelectItem>
                {RATING_OPTIONS.map((rating) => (
                  <SelectItem key={rating} value={String(rating)} aria-label={`Rated ${rating} or higher`}>
                    Rated {rating}+
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <MediaViewMenu
            className={cn(MEDIA_VIEW_MENU, "shrink-0")}
            libraryTab={libraryTab}
            collections={windowSidebarShown ? null : showCollections}
            collection={collection}
            sort={sort}
            minRating={minRating}
            onCollectionChange={setCollection}
            onSortChange={setSort}
            onMinRatingChange={setMinRating}
          />
        </div>
      )}
    </DesktopAppToolbar>
  );

  // ── Library content ───────────────────────────────────────────────────────
  const showAllAction = (
    <Button variant="outline" size="sm" onClick={() => patchView({ collection: "all" })}>
      {libraryTab === "movies" ? "Show all movies" : "Show all shows"}
    </Button>
  );

  const renderLibrary = () => {
    if (!library) {
      if (libraryError) {
        return (
          <ErrorState
            fill
            title={`Couldn't load your ${noun}`}
            description="Talome couldn't get your library from Radarr and Sonarr. Check that the server is running, then retry."
            onRetry={() => void mutateLibrary()}
          />
        );
      }
      return showLibrarySkeleton ? <LibrarySkeleton /> : null;
    }

    const appName = tab === "movies" ? "Radarr" : "Sonarr";
    const unavailable = tab === "movies" ? library.radarrAvailable === false : library.sonarrAvailable === false;
    if (unavailable && (libraryItems?.length ?? 0) === 0) {
      return (
        <EmptyState
          fill
          icon={tab === "movies" ? Film01Icon : Tv01Icon}
          title={`${appName} isn't reachable`}
          description={`Talome couldn't connect to ${appName}. Check that it's running and its address is right in Services.`}
          action={<Button variant="outline" size="sm" onClick={openServices}>Open Services</Button>}
        />
      );
    }

    // The collection can't be computed yet (or at all): say so instead of "nothing here".
    if (collection === "unwatched" && watchStatusMap === null) {
      if (watchStatusStatus === "loading") return showCollectionSkeleton ? <LibrarySkeleton /> : null;
      if (sourceFailed(watchStatusStatus)) {
        return (
          <SourceErrorState
            app="Plex"
            what="your watch history"
            status={watchStatusStatus}
            onRetry={() => void mutatePlexWatchStatus()}
          />
        );
      }
      return (
        <EmptyState
          fill
          icon={Film01Icon}
          title="Connect Plex to see what's unwatched"
          description="Talome reads watch history from Plex."
          action={showAllAction}
        />
      );
    }
    if (healthCollection && health.healthOf === null) {
      if (health.scanPending) return showCollectionSkeleton ? <LibrarySkeleton /> : null;
      if (health.scanError) {
        return (
          <ErrorState
            fill
            title="Couldn't load scan results"
            description="Talome couldn't read which movies play directly in the browser. Check that the server is running, then retry."
            onRetry={() => void health.mutateScan()}
          />
        );
      }
    }

    if (filteredItems.length === 0 && !discoveryActive) {
      if (collection !== "all" && !filtersActive) {
        return (
          <EmptyState
            fill
            icon={tab === "movies" ? Film01Icon : Tv01Icon}
            title={COLLECTION_EMPTY[collection].title}
            description={COLLECTION_EMPTY[collection].description}
            action={showAllAction}
          />
        );
      }
      if (filtersActive) {
        return (
          <EmptyState
            fill
            icon={tab === "movies" ? Film01Icon : Tv01Icon}
            title={`No ${noun} match those filters`}
            description="Try a longer search to discover new titles."
          />
        );
      }
      return (
        <EmptyState
          fill
          icon={tab === "movies" ? Film01Icon : Tv01Icon}
          title={tab === "movies" ? "Your movie library is empty" : "Your TV library is empty"}
          description={tab === "movies" ? "Search for a movie above to add it to your library." : "Search for a show above to add it to your library."}
          action={
            <Button variant="outline" size="sm" asChild>
              <a href="/dashboard/assistant?prompt=Help+me+set+up+a+media+server+stack">Set up media stack</a>
            </Button>
          }
        />
      );
    }

    return (
      <>
        {filteredItems.length > 0 && (
          <div className="media-grid">
            {filteredItems.slice(0, visibleCount).map((m, i) => (
              <MediaCard
                key={`${m.type}-${m.id}`}
                item={m}
                onActivate={handleCardActivate}
                watchStatus={m.tmdbId ? plexWatchStatus?.watchStatus?.[`tmdb:${m.tmdbId}`] : undefined}
                selected={selectionMode && selectedIds.has(`${m.type}-${m.id}`)}
                selectionMode={selectionMode}
                priority={i < 8}
                optStatus={m.filePath ? health.jobsByStem.get(fileStem(m.filePath)) : undefined}
              />
            ))}
          </div>
        )}
        {filteredItems.length > visibleCount && (
          <div ref={moviesLoadSentinelRef} className="flex justify-center py-2">
            <span className="text-xs text-muted-foreground">
              {tab === "movies" ? "Loading more movies…" : "Loading more shows…"}
            </span>
          </div>
        )}
        {discoveryActive && (
          <section>
            <SectionHeading>{discoveryLoading ? "Searching…" : "Not in your library"}</SectionHeading>
            {discoveryResults.length > 0 && (
              <div className="media-grid">
                {discoveryResults.map((r, i) => (
                  <DiscoveryCard key={r.id} item={r} onClick={handleDiscoveryClick} priority={i < 4} />
                ))}
              </div>
            )}
          </section>
        )}
      </>
    );
  };

  const libraryUnfiltered = collection === "all" && !filtersActive;
  const railItems = continueItems.filter((cw) => (tab === "movies" ? cw.type === "movie" : cw.type === "tv"));

  // ── Activity content ──────────────────────────────────────────────────────
  const renderWanted = (withHeading: boolean) => (
    <section>
      {withHeading && <SectionHeading>Wanted</SectionHeading>}
      <div className="grid gap-2">
        {wantedItems.map((w) => {
          const key = `${w.app}-${w.id}`;
          const panel = wantedPanels[key];
          return (
            <div key={key} className="grid gap-1">
              <WantedRow item={w} onManualSearch={handleWantedManualSearch} active={Boolean(panel)} />
              <AnimatePresence initial={false}>
                {panel && (
                  <motion.div
                    key={`panel-${key}`}
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ height: tween(DURATION.fast), opacity: { duration: DURATION.fast } }}
                    className="overflow-hidden"
                  >
                    <div className="pt-1">
                      <WantedReleasePanel
                        loading={panel.loading}
                        error={panel.error}
                        releases={panel.releases}
                        grabbingTitle={panel.grabbingTitle}
                        onClose={() => {
                          setWantedPanels((prev) => {
                            const next = { ...prev };
                            delete next[key];
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
          );
        })}
      </div>
      {wantedCount != null && wantedCount > wantedItems.length && (
        <p className="mt-3 text-xs tabular-nums text-muted-foreground">
          Showing {numberFormat.format(wantedItems.length)} of {numberFormat.format(wantedCount)} wanted titles. Sonarr and Radarr list the rest.
        </p>
      )}
    </section>
  );

  const renderContinue = (withHeading: boolean) => (
    <section>
      {withHeading && <SectionHeading>Continue watching</SectionHeading>}
      <div className="media-grid">
        {continueItems.map((cw, i) => (
          <ContinueWatchingCard key={cw.ratingKey ?? i} item={cw} onOpen={navigateToContinueWatching} className="w-full" />
        ))}
      </div>
    </section>
  );

  const renderActivity = () => {
    const showAll = section !== "all" && (
      <Button
        variant="ghost"
        size="sm"
        className={cn(WINDOW_SIDEBAR_REPLACES, "self-start")}
        onClick={() => patchView({ section: "all" })}
      >
        Show all activity
      </Button>
    );
    const sectionIcon = section === "all" ? PlayListAddIcon : ACTIVITY_SECTION_ICONS[section];
    const gridSkeleton = showActivitySkeleton ? <LibrarySkeleton /> : null;
    const rowsSkeleton = showActivitySkeleton ? <RowsSkeleton rows={3} className="h-18" /> : null;
    const retryWatching = () => void mutatePlexWatching();
    const retryWatchlist = () => void mutatePlexWatchlist();
    const retryRequests = () => void mutateRequests();
    const retryWanted = () => { void mutateWantedTv(); void mutateWantedMovies(); };
    // Data on screen whose last refresh failed stays, with a line saying so.
    const watchingStale = !!plexWatchingData && !!plexWatchingError;
    const watchlistStale = !!plexWatchlist && !!plexWatchlistError;
    const requestsStale = !!requestsData && !!requestsError;
    const wantedStale = (!!wantedTv && !!wantedTvError) || (!!wantedMovies && !!wantedMoviesError);

    let body: ReactNode;
    let statusLine: ReactNode = null;
    const refreshLine = (stale: boolean, onRetry: () => void) =>
      stale ? <SourceStatusLine message="Couldn't refresh" onRetry={onRetry} /> : null;

    if (section === "continue") {
      statusLine = watchingStatus === "ready" && refreshLine(watchingStale, retryWatching);
      body = bySourceStatus(watchingStatus, {
        loading: gridSkeleton,
        failed: <SourceErrorState app="Plex" what="what you're watching" status={watchingStatus} onRetry={retryWatching} />,
        notConfigured: <EmptyState fill icon={sectionIcon} title="Connect Plex to see what you're watching" description="Continue watching comes from Plex." />,
        ready: () => continueItems.length === 0
          ? <EmptyState fill icon={sectionIcon} title="Nothing in progress" description="Movies and episodes you start in Plex show here." />
          : renderContinue(false),
      });
    } else if (section === "watchlist") {
      statusLine = watchlistStatus === "ready" && refreshLine(watchlistStale, retryWatchlist);
      body = bySourceStatus(watchlistStatus, {
        loading: gridSkeleton,
        failed: <SourceErrorState app="Plex" what="your watchlist" status={watchlistStatus} onRetry={retryWatchlist} />,
        notConfigured: <EmptyState fill icon={sectionIcon} title="Connect Plex to see your watchlist" description="Your watchlist comes from Plex." />,
        ready: () => watchlistItems.length === 0
          ? <EmptyState fill icon={sectionIcon} title="Your watchlist is empty" description="Titles you add to your Plex watchlist show here." />
          : <WatchlistSection items={watchlistItems} libraryTmdbIds={libraryTmdbIds} />,
      });
    } else if (section === "requests") {
      statusLine = requestsReady && refreshLine(requestsStale, retryRequests);
      body = bySourceStatus(requestsStatus, {
        loading: rowsSkeleton,
        failed: <SourceErrorState app="Overseerr" what="requests" status={requestsStatus} onRetry={retryRequests} />,
        notConfigured: <EmptyState fill icon={sectionIcon} title="Connect Overseerr to see requests" description="Requests come from Overseerr." />,
        ready: () => requestItems.length === 0
          ? <EmptyState fill icon={sectionIcon} title="No requests" description="Requests people make in Overseerr show here." />
          : <RequestsTab requests={requestItems} onMutate={retryRequests} />,
      });
    } else if (section === "wanted") {
      statusLine = (hasWanted || wantedSettled) && !wantedFailed && refreshLine(wantedStale, retryWanted);
      body = hasWanted
        ? renderWanted(false)
        : !wantedSettled
          ? rowsSkeleton
          : wantedFailed
            ? (
              <ErrorState
                fill
                title="Couldn't reach Sonarr or Radarr"
                description="Talome couldn't load wanted titles. Check that they're running in Services, then retry."
                onRetry={retryWanted}
              />
            )
            : <EmptyState fill icon={sectionIcon} title="Nothing wanted" description="Monitored titles that are released but have no file show here." />;
    } else {
      // Every source that failed outright or couldn't refresh, by what it would show.
      const failures: { what: string; retry: () => void }[] = [];
      if (sourceFailed(watchingStatus) || watchingStale) failures.push({ what: "continue watching", retry: retryWatching });
      if (sourceFailed(watchlistStatus) || watchlistStale) failures.push({ what: "your watchlist", retry: retryWatchlist });
      if (sourceFailed(requestsStatus) || requestsStale) failures.push({ what: "requests", retry: retryRequests });
      if (wantedFailed || wantedStale) failures.push({ what: "wanted titles", retry: retryWanted });
      const failedList = listFormat.format(failures.map((f) => f.what));
      const retryFailures = () => { for (const failure of failures) failure.retry(); };
      const sectionCount = [hasContinue, hasWatchlist, hasRequests, hasWanted].filter(Boolean).length;
      if (sectionCount === 0) {
        // "No activity" only once every source has answered and none failed.
        body = !activitySettled
          ? rowsSkeleton
          : failures.length > 0
            ? (
              <ErrorState
                fill
                title="Couldn't load activity"
                description={`Talome couldn't load ${failedList}. Check that those apps are running in Services, then retry.`}
                onRetry={retryFailures}
              />
            )
            : <EmptyState fill icon={PlayListAddIcon} title="No activity" description="Continue watching, your watchlist, requests and wanted titles show here." />;
      } else {
        statusLine = failures.length > 0 && <SourceStatusLine message={`Couldn't load ${failedList}`} onRetry={retryFailures} />;
        body = (
          <div className="grid gap-6">
            {hasContinue && renderContinue(sectionCount > 1)}
            {hasWatchlist && (
              <section>
                {sectionCount > 1 && <SectionHeading>Watchlist</SectionHeading>}
                <WatchlistSection items={watchlistItems} libraryTmdbIds={libraryTmdbIds} />
              </section>
            )}
            {hasRequests && (
              <section>
                {sectionCount > 1 && <SectionHeading>Requests</SectionHeading>}
                <RequestsTab requests={requestItems} onMutate={retryRequests} />
              </section>
            )}
            {hasWanted && renderWanted(sectionCount > 1)}
          </div>
        );
      }
    }

    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {showAll}
        {statusLine}
        {body}
      </div>
    );
  };

  const sidebar = (
    <MediaWindowSidebar
      location={{ tab, collection, section }}
      libraryTab={libraryTab}
      genres={selectedGenres}
      onNavigate={navigateTo}
      onGenresChange={setGenres}
    />
  );

  return (
    <WindowSidebarLayout sidebar={sidebar}>
    <div ref={rootRef} className="flex min-w-0 flex-1 flex-col gap-6">
      {toolbar}

      {isLibrary && libraryError && library && (
        <SourceStatusLine message="Couldn't refresh" onRetry={() => void mutateLibrary()} />
      )}

      {isLibrary && (
        <MediaFiltersRow
          genres={railGenres}
          selectedGenres={selectedGenres}
          minRating={minRating}
          onToggleGenre={(genre) => {
            setGenres(selectedGenres.includes(genre)
              ? selectedGenres.filter((g) => g !== genre)
              : [...selectedGenres, genre]);
          }}
          onClearFilters={() => patchView({ genres: [], minRating: null })}
        />
      )}

      {/* Continue watching — Plex on-deck, only on the unfiltered library */}
      {isLibrary && libraryUnfiltered && railItems.length > 0 && (
        <section className="min-w-0">
          <SectionHeading>Continue watching</SectionHeading>
          <div className="flex gap-3 overflow-x-auto scrollbar-none pb-1">
            {railItems.map((cw, i) => (
              <ContinueWatchingCard key={cw.ratingKey ?? i} item={cw} onOpen={navigateToContinueWatching} className="w-28 shrink-0 @3xl:w-32" />
            ))}
          </div>
        </section>
      )}

      {/* Movie optimization — per-movie counts from the scan cache */}
      {tab === "movies" && health.counts.scanned > 0 && (
        <div className="flex items-center justify-between gap-4 py-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground @md:gap-3">
            <button
              type="button"
              aria-pressed={collection === "ready"}
              onClick={() => patchView({ collection: collection === "ready" ? "all" : "ready" })}
              className={cn(
                "inline-flex min-h-6 items-center gap-1 rounded-full px-2 transition-colors duration-150 pointer-coarse:min-h-11",
                collection === "ready" ? "bg-status-healthy/12 text-status-healthy" : "hover:bg-muted/50",
              )}
            >
              <span className="font-medium tabular-nums">{numberFormat.format(health.counts.ready)}</span> ready to play
            </button>
            {health.counts.needsConversion > 0 && (
              <>
                <span aria-hidden="true" className="text-border">·</span>
                <button
                  type="button"
                  aria-pressed={collection === "needs-conversion"}
                  onClick={() => patchView({ collection: collection === "needs-conversion" ? "all" : "needs-conversion" })}
                  className={cn(
                    "inline-flex min-h-6 items-center gap-1 rounded-full px-2 transition-colors duration-150 pointer-coarse:min-h-11",
                    collection === "needs-conversion" ? "bg-status-warning/12 text-status-warning" : "hover:bg-muted/50",
                  )}
                >
                  <span className="font-medium tabular-nums">{numberFormat.format(health.counts.needsConversion)}</span> need conversion
                </button>
              </>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs shrink-0 pointer-coarse:h-11"
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
                if (scanPaths.length === 0) { toast.error("No media folders found to scan"); setScanning(false); return; }
                const res = await fetch(`${CORE_URL}/api/optimization/scan`, {
                  method: "POST", credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ paths: scanPaths, queueJobs: false }),
                });
                if (res.ok) {
                  const data = await res.json();
                  void health.mutateScan();
                  if (data.queued > 0) {
                    toast(`Found ${data.queued} files needing conversion`);
                  } else {
                    toast("Library is fully optimized");
                  }
                } else {
                  toast.error("Couldn't scan the library");
                }
              } catch { toast.error("Couldn't scan the library"); }
              finally { setScanning(false); }
            }}
          >
            {scanning ? <Spinner className="h-3 w-3" /> : <HugeiconsIcon icon={Search01Icon} size={14} />}
            {scanning ? "Scanning…" : "Scan"}
          </Button>
        </div>
      )}

      {isLibrary && renderLibrary()}

      {tab === "downloads" && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Content acquired via connected services is your responsibility. Ensure compliance with applicable laws in your jurisdiction.
          </p>
          {!downloads && downloadsError && (
            <ErrorState
              fill
              title="Couldn't load downloads"
              description="Talome couldn't reach your download apps. Check that they're running, then retry."
              onRetry={() => void retryDownloads()}
            />
          )}
          {showDownloadsSkeleton && <RowsSkeleton rows={3} className="h-22" />}

          {/* Unified list — queue items (with enriched speed/eta) + unmatched raw torrents */}
          {downloads && (downloadQueue.length > 0 || activeTorrents.length > 0) && (
            <div className="grid gap-2">
              {(() => {
                const seenKeys = new Map<string, number>();
                return downloadQueue.map((item) => {
                  const baseKey = `q-${item.type}-${item.id}-${item.downloadId ?? item.title}`;
                  const duplicateIndex = seenKeys.get(baseKey) ?? 0;
                  seenKeys.set(baseKey, duplicateIndex + 1);
                  const key = duplicateIndex === 0 ? baseKey : `${baseKey}-${duplicateIndex}`;
                  return (
                    <DownloadQueueRow
                      key={key}
                      item={item}
                      onRetry={handleRetryQueueItem}
                      onRemove={handleRemoveQueueItem}
                      retryingId={retryingQueueId}
                      retryState={queueRetryState[item.id] ?? "idle"}
                      removing={removingQueueIds.has(item.id)}
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
            <EmptyState fill icon={Download01Icon} title="Nothing downloading" description="Downloads from Sonarr, Radarr and qBittorrent show here." />
          )}
        </div>
      )}

      {tab === "calendar" && (
        <div className="flex min-h-0 flex-1 flex-col gap-6">
          {!calendar && calendarError && (
            <ErrorState
              fill
              title="Couldn't load the calendar"
              description="Talome couldn't get upcoming releases from Sonarr and Radarr. Check that they're running, then retry."
              onRetry={() => void mutateCalendar()}
            />
          )}
          {showCalendarSkeleton && <RowsSkeleton rows={4} className="h-18" />}
          {(calendar?.episodes?.length ?? 0) > 0 && (
            <section>
              <SectionHeading>Upcoming episodes</SectionHeading>
              <div className="grid gap-2">
                {calendar!.episodes.map((ep) => (
                  <CalendarCard
                    key={ep.id}
                    poster={ep.poster}
                    type="tv"
                    title={ep.seriesTitle}
                    subtitle={ep.title}
                    meta={`S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`}
                    date={formatDay(ep.airDate) ?? "TBA"}
                    onRemove={ep.seriesId ? () => setCalendarRemoveTarget({ type: "tv", id: ep.seriesId!, title: ep.seriesTitle }) : undefined}
                    removing={calendarRemoving === `tv-${ep.seriesId}`}
                  />
                ))}
              </div>
            </section>
          )}

          {(calendar?.movies?.length ?? 0) > 0 && (
            <section>
              <SectionHeading>Upcoming movies</SectionHeading>
              <div className="grid gap-2">
                {calendar!.movies.map((m) => (
                  <CalendarCard
                    key={m.id}
                    poster={m.poster}
                    type="movie"
                    title={m.title}
                    subtitle={m.year ? String(m.year) : undefined}
                    date={formatDay(m.releaseDate) ?? "TBA"}
                    onRemove={() => setCalendarRemoveTarget({ type: "movie", id: m.id, title: m.title })}
                    removing={calendarRemoving === `movie-${m.id}`}
                  />
                ))}
              </div>
            </section>
          )}

          {calendar && !calendar.episodes?.length && !calendar.movies?.length && (
            <EmptyState fill icon={Calendar01Icon} title="No upcoming releases" description="Nothing is scheduled in the next 14 days." />
          )}
        </div>
      )}

      {tab === "activity" && renderActivity()}

      {/* Detail sheet (titles found by search that aren't in the library yet) */}
      <UnifiedMediaSheet
        item={selected}
        onClose={() => setSelected(null)}
        onRemoved={handleSheetRemoved}
        onAdded={handleSheetAdded}
      />

      {/* Floating selection bar */}
      <MediaSelectionBar
        count={selectionMode ? selectedIds.size : 0}
        onRemove={() => setShowBulkDeleteDialog(true)}
        onCancel={exitSelectionMode}
      />

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
    </WindowSidebarLayout>
  );
}

export default function MediaPage() {
  return (
    <Suspense fallback={null}>
      <MediaPageInner />
    </Suspense>
  );
}
