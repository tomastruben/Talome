"use client";

import Image from "next/image";
import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { motion, AnimatePresence } from "motion/react";
import { CORE_URL } from "@/lib/constants";
import { SearchField } from "@/components/ui/search-field";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  HugeiconsIcon,
  BookOpen01Icon,
  HeadphonesIcon,
  Clock01Icon,
  Search01Icon,
  Download01Icon,
  DownloadCircle01Icon,
  Tick01Icon,
  ArrowUp01Icon,
  Delete01Icon,
} from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsBadge } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useFeatureStack } from "@/hooks/use-feature-stacks";
import { StackSetup } from "@/components/ui/stack-setup";

/* ── Types ─────────────────────────────────────────────── */

interface AudiobookItem {
  id: string;
  ino: string;
  mediaType: string;
  media: {
    metadata: {
      title: string;
      subtitle?: string;
      authorName?: string;
      narratorName?: string;
      seriesName?: string;
      publishedYear?: string;
      description?: string;
      genres?: string[];
    };
    duration?: number;
    numChapters?: number;
    numAudioFiles?: number;
    size?: number;
  };
  addedAt: number;
  updatedAt: number;
  numFiles?: number;
}

interface LibraryData {
  results: AudiobookItem[];
  total: number;
  limit: number;
  page: number;
}

interface Library {
  id: string;
  name: string;
  mediaType: string;
}

interface PersonalizedShelf {
  id: string;
  label: string;
  labelStringKey?: string;
  type: string;
  entities: AudiobookItem[];
}

interface ProgressMap {
  [itemId: string]: {
    progress: number;
    currentTime: number;
    isFinished: boolean;
  };
}

interface SearchRelease {
  guid: string | null;
  title: string;
  size: number;
  ageHours: number | null;
  indexer: string | null;
  seeders: number | null;
  leechers: number | null;
  protocol: string | null;
  downloadUrl: string | null;
  infoUrl: string | null;
  publishDate: string | null;
  language: string | null;
}

interface DownloadRecord {
  hash: string;
  name: string;
  state: string;
  progress: number;
  size: number;
  downloaded: number;
  dlspeed: number;
  eta: number;
  addedOn: number;
  completionOn: number;
  savePath: string;
}

interface AudibleItem {
  asin: string;
  title: string;
  authors: { name: string }[];
  product_images?: Record<string, string>;
  runtime_length_min?: number;
  purchase_date?: string;
}

interface ImportJob {
  id: string;
  asin: string;
  title: string;
  author: string;
  status: string;
  progress: number;
  error?: string;
}

type PageTab = "library" | "search" | "downloads";
type SortKey = "added-desc" | "added-asc" | "title-asc" | "title-desc" | "duration-desc" | "duration-asc";

/* ── Helpers ───────────────────────────────────────────── */

async function fetcher(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("API error");
  return res.json();
}

function formatDuration(seconds?: number): string {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  const gb = bytes / 1073741824;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1048576).toFixed(0)} MB`;
}

function coverUrl(itemId: string, width = 240): string {
  return `${CORE_URL}/api/audiobooks/cover?id=${itemId}&w=${width}`;
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
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { rootMargin: "420px 0px 220px 0px", threshold: 0.01 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [enabled, onLoadMore, targetRef]);
}

/* ── AudiobookCard ─────────────────────────────────────── */

function AudiobookCard({
  item,
  progress,
  onClick,
}: {
  item: AudiobookItem;
  progress?: number;
  onClick: (item: AudiobookItem) => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const meta = item.media?.metadata;
  const duration = item.media?.duration;

  return (
    <div className="media-card" onClick={() => onClick(item)}>
      <div className="audiobook-card-cover">
        {!imgFailed ? (
          <Image
            src={coverUrl(item.id, 400)}
            alt={meta?.title ?? ""}
            className="object-cover"
            fill
            decoding="async"
            fetchPriority="low"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <HugeiconsIcon icon={BookOpen01Icon} size={28} className="text-dim-foreground" />
          </div>
        )}
        {progress !== undefined && progress > 0 && progress < 1 && (
          <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-muted/60">
            <div
              className="h-full bg-foreground/70 transition-all duration-300"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        )}
      </div>
      <div className="min-w-0 mt-2.5 px-0.5">
        <p className="text-sm font-medium truncate leading-tight">{meta?.title}</p>
        <div className="flex items-center gap-2 mt-0.5">
          {meta?.authorName && (
            <p className="text-xs text-muted-foreground truncate flex-1">{meta.authorName}</p>
          )}
          {duration && (
            <span className="text-xs text-dim-foreground tabular-nums shrink-0 flex items-center gap-0.5">
              <HugeiconsIcon icon={Clock01Icon} size={10} />
              {formatDuration(duration)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── ContinueListeningShelf ────────────────────────────── */

function ContinueListeningShelf({
  items,
  progressMap,
  onSelect,
}: {
  items: AudiobookItem[];
  progressMap: ProgressMap;
  onSelect: (item: AudiobookItem) => void;
}) {
  if (items.length === 0) return null;

  return (
    <section className="min-w-0 overflow-hidden">
      <div className="flex items-center gap-2 mb-3">
        <HugeiconsIcon icon={HeadphonesIcon} size={14} className="text-dim-foreground" />
        <p className="media-section-label !mb-0">Continue Listening</p>
      </div>
      <ScrollArea className="w-full">
        <div className="flex gap-4 pb-2">
          {items.map((item) => (
            <div key={item.id} className="w-[130px] flex-shrink-0 sm:w-[160px]">
              <AudiobookCard
                item={item}
                progress={progressMap[item.id]?.progress}
                onClick={onSelect}
              />
            </div>
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </section>
  );
}

/* ── AudiobookReleaseCard ─────────────────────────────── */

const LANG_BADGE_COLORS: Record<string, string> = {
  CZ: "bg-blue-500/10 text-blue-400",
  SK: "bg-indigo-500/10 text-indigo-400",
  EN: "bg-emerald-500/10 text-emerald-400",
  DE: "bg-amber-500/10 text-amber-400",
  PL: "bg-rose-500/10 text-rose-400",
  RU: "bg-purple-500/10 text-purple-400",
  FR: "bg-cyan-500/10 text-cyan-400",
};

function AudiobookReleaseCard({
  release,
  isDownloading,
  isDownloaded,
  onDownload,
}: {
  release: SearchRelease;
  isDownloading: boolean;
  isDownloaded: boolean;
  onDownload: () => void;
}) {
  const seeders = release.seeders ?? 0;
  const meta: string[] = [];
  if (release.size) meta.push(formatSize(release.size));
  if (release.ageHours != null) {
    const h = release.ageHours;
    if (h < 1) meta.push("< 1h");
    else if (h < 24) meta.push(`${Math.round(h)}h`);
    else { const d = Math.round(h / 24); meta.push(d === 1 ? "1d" : `${d}d`); }
  }
  if (release.indexer) meta.push(release.indexer);

  return (
    <div className={cn(
      "flex items-center gap-2 rounded-md border px-2.5 py-2 transition-colors",
      isDownloaded ? "border-status-healthy/20 bg-status-healthy/5" : "border-border/30 hover:border-border/50",
    )}>
      {release.language && (
        <span className={cn(
          "shrink-0 rounded px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide",
          LANG_BADGE_COLORS[release.language] ?? "bg-muted/40 text-muted-foreground",
        )}>
          {release.language}
        </span>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium leading-tight truncate">{release.title}</p>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          {meta.length > 0 && <span className="truncate">{meta.join(" · ")}</span>}
          {seeders > 0 && (
            <span className="inline-flex items-center gap-0.5 shrink-0 tabular-nums">
              <HugeiconsIcon icon={ArrowUp01Icon} size={9} className="text-dim-foreground" />
              {seeders}
            </span>
          )}
        </div>
      </div>

      <button
        type="button"
        className={cn(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-50",
          isDownloaded
            ? "text-status-healthy"
            : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
        )}
        onClick={onDownload}
        disabled={!release.downloadUrl || isDownloading || isDownloaded}
        aria-label={isDownloaded ? "Sent to download client" : isDownloading ? "Downloading..." : "Download"}
      >
        {isDownloading ? (
          <Spinner className="size-3" />
        ) : isDownloaded ? (
          <HugeiconsIcon icon={Tick01Icon} size={13} />
        ) : (
          <HugeiconsIcon icon={Download01Icon} size={13} />
        )}
      </button>
    </div>
  );
}

/* ── DownloadRow ──────────────────────────────────────── */

function DownloadRow({
  record,
  onRemove,
}: {
  record: DownloadRecord;
  onRemove: (hash: string) => void;
}) {
  const isActive = record.state === "downloading" || record.state === "stalledDL" || record.state === "metaDL";
  const isCompleted = record.progress >= 100;
  const isSeeding = record.state === "uploading" || record.state === "stalledUP";

  const formatSpeed = (bps: number) => {
    if (bps <= 0) return "";
    const mbps = bps / 1048576;
    return mbps >= 1 ? `${mbps.toFixed(1)} MB/s` : `${(bps / 1024).toFixed(0)} KB/s`;
  };

  const formatEta = (seconds: number) => {
    if (seconds <= 0 || seconds >= 8640000) return "";
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
  };

  const stateLabel = isCompleted
    ? (isSeeding ? "Seeding" : "Complete")
    : record.state === "stalledDL" ? "Stalled" : record.state === "metaDL" ? "Metadata" : "";

  return (
    <div className={cn(
      "flex items-center gap-3 rounded-md border px-3 py-2.5 transition-colors",
      isCompleted ? "border-status-healthy/15 bg-status-healthy/5" : "border-border/30",
    )}>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate leading-tight">{record.name}</p>
        <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
          <span>{formatSize(record.size)}</span>
          {!isCompleted && record.dlspeed > 0 && <span>{formatSpeed(record.dlspeed)}</span>}
          {!isCompleted && record.eta > 0 && <span>{formatEta(record.eta)}</span>}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {isActive && !isCompleted && (
          <>
            <Progress value={record.progress} className="h-1 w-16" />
            <span className="text-xs tabular-nums text-muted-foreground w-8 text-right">{record.progress}%</span>
          </>
        )}
        {stateLabel && (
          <span className={cn(
            "text-xs",
            isCompleted ? "text-status-healthy/60" : "text-muted-foreground",
          )}>{stateLabel}</span>
        )}
        <button
          type="button"
          onClick={() => onRemove(record.hash)}
          className="h-6 w-6 inline-flex items-center justify-center rounded-md text-dim-foreground hover:text-foreground transition-colors"
          aria-label="Remove download"
        >
          ×
        </button>
      </div>
    </div>
  );
}

/* ── AudibleCard ──────────────────────────────────────── */

function AudibleCard({ item, isLocal, localLibraryName, importJob, canImport, onImport, onRemove }: {
  item: AudibleItem;
  isLocal?: boolean;
  localLibraryName?: string;
  importJob?: ImportJob;
  canImport?: boolean;
  onImport?: (item: AudibleItem) => void;
  onRemove?: (item: AudibleItem) => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const images = item.product_images;
  const coverSrc = images?.["500"] ?? (images ? images[Object.keys(images)[0]] : undefined);
  const authorStr = item.authors?.map((a) => a.name).join(", ");
  const mins = item.runtime_length_min;
  const durationStr = mins
    ? mins >= 60
      ? `${Math.floor(mins / 60)}h ${mins % 60}m`
      : `${mins}m`
    : "";

  return (
    <div className="media-card">
      <div className="audiobook-card-cover">
        {coverSrc && !imgFailed ? (
          <Image
            src={coverSrc}
            alt={item.title}
            className="object-cover"
            fill
            decoding="async"
            fetchPriority="low"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <HugeiconsIcon icon={HeadphonesIcon} size={28} className="text-dim-foreground" />
          </div>
        )}
        {isLocal && (
          <div className="absolute top-1.5 right-1.5 rounded-full bg-status-healthy/90 px-1.5 py-0.5 flex items-center gap-0.5">
            <HugeiconsIcon icon={Tick01Icon} size={9} className="text-white" />
            {localLibraryName && (
              <span className="text-xs text-white font-medium leading-none">{localLibraryName}</span>
            )}
          </div>
        )}
      </div>
      <div className="min-w-0 mt-2.5 px-0.5">
        <p className="text-sm font-medium truncate leading-tight">{item.title}</p>
        <div className="flex items-center gap-2 mt-0.5">
          {authorStr && (
            <p className="text-xs text-muted-foreground truncate flex-1">{authorStr}</p>
          )}
          {durationStr && (
            <span className="text-xs text-dim-foreground tabular-nums shrink-0 flex items-center gap-0.5">
              <HugeiconsIcon icon={Clock01Icon} size={10} />
              {durationStr}
            </span>
          )}
        </div>
        {!isLocal && canImport && (!importJob || importJob.status === "error") && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onImport?.(item); }}
            className="mt-1.5 flex items-center gap-1 text-xs text-dim-foreground hover:text-muted-foreground transition-colors"
          >
            <HugeiconsIcon icon={Download01Icon} size={10} />
            {importJob?.status === "error" ? "Retry" : "Import"}
          </button>
        )}
        {importJob && importJob.status !== "done" && importJob.status !== "error" && (
          <div className="mt-1.5 space-y-0.5">
            <Progress value={importJob.progress} className="h-1" />
            <p className="text-xs text-muted-foreground capitalize">{importJob.status}...</p>
          </div>
        )}
        {importJob?.status === "done" && (
          <p className="mt-1.5 text-xs text-status-healthy/70 flex items-center gap-0.5">
            <HugeiconsIcon icon={Tick01Icon} size={10} />
            Imported
          </p>
        )}
        {isLocal && !importJob && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove?.(item); }}
            className="mt-1.5 flex items-center gap-1 text-xs text-dim-foreground hover:text-status-critical/70 transition-colors"
          >
            <HugeiconsIcon icon={Delete01Icon} size={10} />
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────── */

export default function AudiobooksPage() {
  const PAGE_CHUNK = 60;
  const router = useRouter();

  // Feature stack readiness
  const { stack: booksStack, isLoading: stackLoading } = useFeatureStack("books");

  // Tab state — always initialize to "library" to avoid hydration mismatch,
  // then restore from URL on mount
  const [tab, setTab] = useState<PageTab>("library");
  const tabInitRef = useRef(false);

  // Restore tab from URL on mount (client-only)
  useEffect(() => {
    if (tabInitRef.current) return;
    tabInitRef.current = true;
    const p = new URLSearchParams(window.location.search).get("tab");
    if (p === "library" || p === "search" || p === "downloads") {
      setTab(p);
    }
  }, []);

  // Sync active tab to URL so browser history preserves it on back-navigation
  useEffect(() => {
    if (!tabInitRef.current) return;
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(window.history.state, "", url.toString());
  }, [tab]);

  // Library tab state
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("added-desc");
  const [visibleCount, setVisibleCount] = useState(PAGE_CHUNK);
  const [selectedLibrary, setSelectedLibraryRaw] = useState<string | null>(null);
  const [lastRealLibrary, setLastRealLibrary] = useState<string | null>(null);
  const setSelectedLibrary = useCallback((id: string | null) => {
    setSelectedLibraryRaw(id);
    if (id && id !== "__audible__") {
      setLastRealLibrary(id);
      if (typeof window !== "undefined") localStorage.setItem("audiobooks-library", id);
    }
  }, []);
  const loadSentinelRef = useRef<HTMLDivElement | null>(null);

  // Search tab state
  const [searchQuery, setSearchQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [filterLang, setFilterLang] = useState<string | null>(null);
  const [filterIndexer, setFilterIndexer] = useState<string | null>(null);
  const [downloadingUrls, setDownloadingUrls] = useState<Set<string>>(new Set());
  const [downloadedUrls, setDownloadedUrls] = useState<Set<string>>(new Set());

  // Data fetching
  const { data: libraries, error: libError } = useSWR<Library[]>(
    `${CORE_URL}/api/audiobooks/libraries`,
    fetcher,
    { revalidateOnFocus: false },
  );

  const { data: searchStatus } = useSWR<{ configured: boolean; prowlarr: boolean; qbittorrent: boolean }>(
    `${CORE_URL}/api/audiobooks/search/status`,
    fetcher,
    { revalidateOnFocus: false },
  );

  const searchUrl = submittedQuery
    ? `${CORE_URL}/api/audiobooks/search/releases?q=${encodeURIComponent(submittedQuery)}`
    : null;
  const { data: searchData, isLoading: searchLoading } = useSWR<{ releases: SearchRelease[]; totalFound?: number; error?: string }>(
    searchUrl,
    fetcher,
  );

  const { data: downloadsData, mutate: mutateDownloads } = useSWR<{ totalRecords: number; records: DownloadRecord[] }>(
    tab === "downloads" ? `${CORE_URL}/api/audiobooks/downloads` : null,
    fetcher,
    { refreshInterval: 15_000 },
  );

  // Audible
  const { data: audibleStatus } = useSWR<{ authenticated: boolean }>(
    `${CORE_URL}/api/audible/auth-status`,
    fetcher,
    { revalidateOnFocus: false },
  );
  const audibleConnected = audibleStatus?.authenticated ?? false;

  const { data: audibleLibrary, isLoading: audibleLoading, error: audibleError } = useSWR<AudibleItem[]>(
    audibleConnected && selectedLibrary === "__audible__" ? `${CORE_URL}/api/audible/library` : null,
    async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${text}`);
      }
      const data = await res.json();
      return (data.items ?? []) as AudibleItem[];
    },
    { revalidateOnFocus: false },
  );

  // FFmpeg availability
  const { data: importTools } = useSWR<{ ffmpeg: boolean; version?: string }>(
    audibleConnected ? `${CORE_URL}/api/audible/import-tools` : null,
    fetcher,
    { revalidateOnFocus: false },
  );

  // Active imports — poll while imports are running
  const { data: importsData, mutate: mutateImports } = useSWR<{ jobs: ImportJob[] }>(
    audibleConnected ? `${CORE_URL}/api/audible/imports` : null,
    fetcher,
    { refreshInterval: 10_000 },
  );

  useEffect(() => {
    if (libraries && libraries.length > 0 && !selectedLibrary) {
      const saved = typeof window !== "undefined" ? localStorage.getItem("audiobooks-library") : null;
      const match = saved && libraries.find((l) => l.id === saved);
      const initial = match ? saved : libraries[0].id;
      setSelectedLibraryRaw(initial);
      setLastRealLibrary(initial);
    }
  }, [libraries, selectedLibrary]);

  const { data: libraryData, isLoading: itemsLoading, mutate: mutateLibrary } = useSWR<LibraryData>(
    selectedLibrary && selectedLibrary !== "__audible__"
      ? `${CORE_URL}/api/audiobooks/library/${selectedLibrary}?limit=500&sort=${getSortParam(sort)}&desc=${sort.endsWith("-desc") ? "1" : "0"}`
      : null,
    fetcher,
    { refreshInterval: 60000 },
  );

  // Fetch ALL libraries' items for Audible comparison (need to check across all libraries)
  // Each library is fetched separately with a multi-key SWR
  const allLibraryIds = useMemo(() => (libraries ?? []).map((l) => l.id), [libraries]);

  const { data: allLibrariesItems } = useSWR<Array<{ libraryId: string; libraryName: string; results: AudiobookItem[] }>>(
    selectedLibrary === "__audible__" && allLibraryIds.length > 0
      ? `__audible_comparison__${allLibraryIds.join(",")}`
      : null,
    async () => {
      const results = await Promise.all(
        (libraries ?? []).map(async (lib) => {
          try {
            const res = await fetch(`${CORE_URL}/api/audiobooks/library/${lib.id}?limit=500`);
            if (!res.ok) return { libraryId: lib.id, libraryName: lib.name, results: [] };
            const data = await res.json();
            return { libraryId: lib.id, libraryName: lib.name, results: data.results ?? [] };
          } catch {
            return { libraryId: lib.id, libraryName: lib.name, results: [] };
          }
        })
      );
      return results;
    },
    { revalidateOnFocus: false },
  );

  // Build lookup maps for the Audible tab
  const importsByAsin = useMemo(() => {
    const map = new Map<string, ImportJob>();
    for (const job of importsData?.jobs ?? []) {
      map.set(job.asin, job);
    }
    return map;
  }, [importsData]);

  // Build a map: audible title → { libraryName, itemId } across ALL libraries
  // ABS titles often include "(Unabridged)" or extra subtitles, so use contains matching
  const localBookInfo = useMemo(() => {
    const entries: { title: string; id: string; libraryName: string; libraryId: string }[] = [];
    if (selectedLibrary === "__audible__" && allLibrariesItems) {
      for (const lib of allLibrariesItems) {
        for (const item of lib.results) {
          const title = item?.media?.metadata?.title;
          if (title && item.id) {
            entries.push({ title: title.toLowerCase(), id: item.id, libraryName: lib.libraryName, libraryId: lib.libraryId });
          }
        }
      }
    } else if (libraryData?.results) {
      const libName = libraries?.find((l) => l.id === selectedLibrary)?.name ?? "";
      for (const item of libraryData.results) {
        const title = item?.media?.metadata?.title;
        if (title && item.id) {
          entries.push({ title: title.toLowerCase(), id: item.id, libraryName: libName, libraryId: selectedLibrary ?? "" });
        }
      }
    }
    return entries;
  }, [selectedLibrary, allLibrariesItems, libraryData, libraries]);

  const findLocalMatch = useCallback((audibleTitle: string) => {
    const needle = audibleTitle.toLowerCase();
    return localBookInfo.find((l) => l.title.includes(needle) || needle.includes(l.title));
  }, [localBookInfo]);

  const isLocalTitle = useCallback((audibleTitle: string) => !!findLocalMatch(audibleTitle), [findLocalMatch]);
  const getLocalItemId = useCallback((audibleTitle: string) => findLocalMatch(audibleTitle)?.id, [findLocalMatch]);
  const getLocalLibraryName = useCallback((audibleTitle: string) => findLocalMatch(audibleTitle)?.libraryName, [findLocalMatch]);

  const { data: shelves } = useSWR<PersonalizedShelf[]>(
    selectedLibrary && selectedLibrary !== "__audible__"
      ? `${CORE_URL}/api/audiobooks/library/${selectedLibrary}/personalized`
      : null,
    fetcher,
    { refreshInterval: 60000 },
  );

  const continueListening = shelves?.find(
    (s) => s.id === "continue-listening" || s.labelStringKey === "LabelContinueListening",
  );

  const progressMap: ProgressMap = {};
  if (continueListening?.entities) {
    for (const item of continueListening.entities) {
      const progress = (item as any).mediaProgress;
      if (progress) {
        progressMap[item.id] = {
          progress: progress.progress ?? 0,
          currentTime: progress.currentTime ?? 0,
          isFinished: progress.isFinished ?? false,
        };
      }
    }
  }

  const allItems = libraryData?.results ?? [];
  const q = search.toLowerCase();
  const filtered = allItems.filter((item) => {
    if (!q) return true;
    const meta = item.media?.metadata;
    return (
      meta?.title?.toLowerCase().includes(q) ||
      meta?.authorName?.toLowerCase().includes(q) ||
      meta?.narratorName?.toLowerCase().includes(q) ||
      meta?.seriesName?.toLowerCase().includes(q)
    );
  });

  const loadNextChunk = useCallback(() => {
    setVisibleCount((c) => Math.min(c + PAGE_CHUNK, filtered.length));
  }, [filtered.length]);

  useAutoLoadSentinel({
    targetRef: loadSentinelRef,
    enabled: !itemsLoading && filtered.length > visibleCount,
    onLoadMore: loadNextChunk,
  });

  useEffect(() => {
    setVisibleCount(PAGE_CHUNK);
  }, [search, sort, selectedLibrary]);

  const isNotConfigured = libError || (libraries && libraries.length === 0 && !libError);
  const hasNoBooks = !itemsLoading && filtered.length === 0 && !search;
  const showGrid = !itemsLoading && filtered.length > 0;
  const showContinueListening = !search && (continueListening?.entities?.length ?? 0) > 0;
  const totalCount = libraryData?.total ?? 0;
  const downloadCount = downloadsData?.records?.filter((r) => r.progress < 100).length ?? 0;
  const searchConfigured = searchStatus?.configured ?? false;

  // Restore scroll position when returning from a detail page
  useEffect(() => {
    if (itemsLoading) return;
    const savedY = sessionStorage.getItem("audiobooks-scroll-y");
    if (!savedY) return;
    sessionStorage.removeItem("audiobooks-scroll-y");
    requestAnimationFrame(() => {
      const scrollParent = document.querySelector(".overflow-y-auto") as HTMLElement | null;
      if (scrollParent) scrollParent.scrollTo({ top: Number(savedY) });
    });
  }, [itemsLoading]);

  function handleSelect(item: AudiobookItem) {
    const scrollParent = document.querySelector(".overflow-y-auto") as HTMLElement | null;
    if (scrollParent) {
      sessionStorage.setItem("audiobooks-scroll-y", String(scrollParent.scrollTop));
    }
    router.push(`/dashboard/audiobooks/${item.id}`);
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    // Force SWR refetch by updating the key dependencies
    setSubmittedQuery(searchQuery.trim());
  }

  async function handleDownloadRelease(release: SearchRelease) {
    if (!release.downloadUrl) return;
    const url = release.downloadUrl;
    setDownloadingUrls((prev) => new Set(prev).add(url));
    try {
      const res = await fetch(`${CORE_URL}/api/audiobooks/search/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ downloadUrl: url, title: release.title }),
      });
      const data = await res.json();
      if (data.ok) {
        setDownloadedUrls((prev) => new Set(prev).add(url));
        toast.success("Sent to qBittorrent");
        void mutateDownloads();
      } else {
        toast.error(data.error ?? "Failed to start download");
      }
    } catch {
      toast.error("Failed to start download");
    } finally {
      setDownloadingUrls((prev) => {
        const next = new Set(prev);
        next.delete(url);
        return next;
      });
    }
  }

  async function handleRemoveDownload(hash: string) {
    try {
      await fetch(`${CORE_URL}/api/audiobooks/downloads/${hash}`, {
        method: "DELETE",
      });
      void mutateDownloads();
      toast.success("Removed download");
    } catch {
      toast.error("Failed to remove download");
    }
  }

  async function handleAudibleImport(item: AudibleItem) {
    const existingJob = importsByAsin.get(item.asin);
    if (existingJob && existingJob.status !== "error") {
      toast("Already importing this book");
      return;
    }
    try {
      const res = await fetch(`${CORE_URL}/api/audible/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asin: item.asin,
          title: item.title,
          author: item.authors?.[0]?.name ?? "Unknown",
          libraryId: lastRealLibrary ?? undefined,
        }),
      });
      const data = await res.json();
      if (data.importId) {
        toast(`Importing "${item.title}"`);
        void mutateImports();
      } else {
        toast.error(data.error ?? "Import failed");
      }
    } catch {
      toast.error("Failed to start import");
    }
  }

  async function handleRemoveImport(item: AudibleItem) {
    const absItemId = getLocalItemId(item.title);
    if (!absItemId) {
      toast.error("Book not found in local library");
      return;
    }

    try {
      const res = await fetch(`${CORE_URL}/api/audible/remove-import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: absItemId }),
      });
      const data = await res.json();
      if (data.ok) {
        toast("Removed from library");
        void mutateLibrary();
      } else {
        toast.error(data.error ?? "Failed to remove");
      }
    } catch {
      toast.error("Failed to remove from library");
    }
  }

  const allSearchResults = searchData?.releases ?? [];

  // Extract available languages and indexers from results for filter chips
  const availableLangs = [...new Set(allSearchResults.map((r) => r.language).filter(Boolean))] as string[];
  const availableIndexers = [...new Set(allSearchResults.map((r) => r.indexer).filter(Boolean))] as string[];

  // Client-side filtering
  const searchResults = allSearchResults.filter((r) => {
    if (filterLang && r.language !== filterLang) return false;
    if (filterIndexer && r.indexer !== filterIndexer) return false;
    return true;
  });

  // Show stack setup when audiobookshelf is not installed
  if (!stackLoading && booksStack && booksStack.readiness === 0) {
    return (
      <StackSetup
        stackId="books"
        onSetupWithAI={(prompt) => router.push(`/dashboard/assistant?prompt=${encodeURIComponent(prompt)}`)}
      />
    );
  }

  return (
    <div className="grid gap-5 pb-12">
      {/* Controls — tabs + search/sort */}
      <div className="page-controls-row flex-wrap justify-between gap-2">
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as PageTab)}
        >
          <TabsList>
            <TabsTrigger value="library" className="text-xs gap-1.5">
              <HugeiconsIcon icon={BookOpen01Icon} size={14} />
            </TabsTrigger>
            <TabsTrigger value="search" className="text-xs gap-1.5">
              <HugeiconsIcon icon={Search01Icon} size={14} />
            </TabsTrigger>
            <TabsTrigger value="downloads" className="text-xs gap-1.5">
              <HugeiconsIcon icon={DownloadCircle01Icon} size={14} />
              {downloadCount > 0 && <TabsBadge>{downloadCount}</TabsBadge>}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Library controls */}
        {tab === "library" && (
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-2">
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
                  <SelectItem value="duration-desc">Longest</SelectItem>
                  <SelectItem value="duration-asc">Shortest</SelectItem>
                </SelectContent>
              </Select>
              {libraries && libraries.length > 0 && (
                <Select value={selectedLibrary ?? ""} onValueChange={setSelectedLibrary}>
                  <SelectTrigger className="h-8 w-full min-w-0 text-xs sm:hidden">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {libraries.map((lib) => (
                      <SelectItem key={lib.id} value={lib.id}>{lib.name}</SelectItem>
                    ))}
                    {audibleConnected && (
                      <>
                        <SelectSeparator />
                        <SelectItem value="__audible__">Audible</SelectItem>
                      </>
                    )}
                  </SelectContent>
                </Select>
              )}
            </div>
            <SearchField
              containerClassName="flex-1 w-full sm:w-auto"
              placeholder="Search library..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        )}

        {/* Library picker — visible on all tabs (desktop: always, mobile: library tab only has its own) */}
        {libraries && (libraries.length > 1 || audibleConnected) && (
          <div className={cn("items-center gap-3", tab === "library" ? "hidden sm:flex" : "flex")}>
            <Select value={selectedLibrary ?? ""} onValueChange={setSelectedLibrary}>
              <SelectTrigger className="h-8 text-xs min-w-[8rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {libraries.map((lib) => (
                  <SelectItem key={lib.id} value={lib.id}>{lib.name}</SelectItem>
                ))}
                {audibleConnected && (
                  <>
                    <SelectSeparator />
                    <SelectItem value="__audible__">Audible</SelectItem>
                  </>
                )}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* ═══ Library Tab ═══ */}
      {tab === "library" && (
        <div className="grid gap-5">
          {selectedLibrary === "__audible__" ? (
            <>
              {audibleLoading ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                  {Array.from({ length: 12 }).map((_, i) => (
                    <div key={i} className="space-y-2">
                      <Skeleton className="aspect-square rounded-lg" />
                      <Skeleton className="h-3 w-3/4" />
                      <Skeleton className="h-2.5 w-1/2" />
                    </div>
                  ))}
                </div>
              ) : audibleLibrary && audibleLibrary.length > 0 ? (
                <>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <HugeiconsIcon icon={HeadphonesIcon} size={14} className="text-dim-foreground" />
                      <p className="media-section-label !mb-0">Audible Library</p>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {audibleLibrary.length} {audibleLibrary.length === 1 ? "title" : "titles"}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      {lastRealLibrary && libraries && (
                        <p className="text-xs text-muted-foreground">
                          Importing to {libraries.find((l) => l.id === lastRealLibrary)?.name ?? "library"}
                        </p>
                      )}
                      {(importTools?.ffmpeg ?? false) && audibleLibrary.some((b) => !isLocalTitle(b.title)) && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs gap-1.5"
                          onClick={() => {
                            const missing = audibleLibrary.filter((b) => !isLocalTitle(b.title) && !importsByAsin.has(b.asin));
                            if (missing.length === 0) { toast("All books already imported or importing"); return; }
                            for (const item of missing) void handleAudibleImport(item);
                            toast(`Importing ${missing.length} book${missing.length === 1 ? "" : "s"}`);
                          }}
                        >
                          <HugeiconsIcon icon={Download01Icon} size={12} />
                          Import All ({audibleLibrary.filter((b) => !isLocalTitle(b.title) && !importsByAsin.has(b.asin)).length})
                        </Button>
                      )}
                    </div>
                  </div>
                  {importTools && !importTools.ffmpeg && (
                    <p className="text-xs text-status-warning/60">
                      FFmpeg not found on server — import is disabled. Install FFmpeg to enable audiobook importing.
                    </p>
                  )}
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                    {audibleLibrary.map((item) => (
                      <AudibleCard
                        key={item.asin}
                        item={item}
                        isLocal={isLocalTitle(item.title)}
                        localLibraryName={getLocalLibraryName(item.title)}
                        importJob={importsByAsin.get(item.asin)}
                        canImport={importTools?.ffmpeg ?? false}
                        onImport={handleAudibleImport}
                        onRemove={handleRemoveImport}
                      />
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Importing from Audible may involve DRM conversion using tools you have installed. You are responsible for compliance with applicable laws.
                  </p>
                </>
              ) : (
                <EmptyState
                  icon={HeadphonesIcon}
                  title={audibleError ? "Failed to load library" : "No audiobooks found"}
                  description={audibleError ? String(audibleError.message ?? audibleError) : "Your Audible library appears to be empty."}
                />
              )}
            </>
          ) : (
            <>
              {isNotConfigured && (
                <EmptyState
                  icon={BookOpen01Icon}
                  title="Connect Audiobookshelf"
                  description="Add your Audiobookshelf server in Settings to browse your audiobook library."
                  action={
                    <Button variant="outline" size="sm" asChild>
                      <a href="/dashboard/settings">Go to Settings</a>
                    </Button>
                  }
                />
              )}

              {showContinueListening && (
                <ContinueListeningShelf
                  items={continueListening!.entities}
                  progressMap={progressMap}
                  onSelect={handleSelect}
                />
              )}

              {showGrid && !search && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <HugeiconsIcon icon={BookOpen01Icon} size={14} className="text-dim-foreground" />
                    <p className="media-section-label !mb-0">
                      {showContinueListening ? "Library" : "All Audiobooks"}
                    </p>
                  </div>
                  {totalCount > 0 && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {totalCount} {totalCount === 1 ? "book" : "books"}
                    </span>
                  )}
                </div>
              )}

              {itemsLoading && selectedLibrary && (
                <div className="audiobook-grid">
                  {Array.from({ length: 12 }).map((_, i) => (
                    <div key={i}>
                      <Skeleton className="aspect-square rounded-lg" />
                      <Skeleton className="h-4 w-3/4 mt-2.5" />
                      <Skeleton className="h-3 w-1/2 mt-1" />
                    </div>
                  ))}
                </div>
              )}

              {!itemsLoading && filtered.length === 0 && search && (
                <EmptyState
                  icon={BookOpen01Icon}
                  title="No audiobooks found"
                  description="Try a different search term."
                />
              )}
              {hasNoBooks && selectedLibrary && (
                <EmptyState
                  icon={BookOpen01Icon}
                  title="Your library is empty"
                  description="Add audiobooks to your Audiobookshelf library to see them here."
                />
              )}

              {showGrid && (
                <div className="audiobook-grid">
                  {filtered.slice(0, visibleCount).map((item) => (
                    <AudiobookCard
                      key={item.id}
                      item={item}
                      progress={progressMap[item.id]?.progress}
                      onClick={handleSelect}
                    />
                  ))}
                </div>
              )}

              {filtered.length > visibleCount && (
                <div ref={loadSentinelRef} className="flex justify-center py-2">
                  <span className="text-xs text-muted-foreground">Loading more...</span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ═══ Search Tab ═══ */}
      {tab === "search" && (
        <div className="grid gap-5">
          {!searchConfigured ? (
            <EmptyState
              icon={Search01Icon}
              title="Connect Prowlarr & qBittorrent"
              description="Add Prowlarr and qBittorrent in Settings to search and download audiobooks."
              action={
                <Button variant="outline" size="sm" asChild>
                  <a href="/dashboard/settings">Go to Settings</a>
                </Button>
              }
            />
          ) : (
            <>
              <form onSubmit={handleSearch} className="space-y-3">
                <div className="flex gap-2">
                  <SearchField
                    containerClassName="flex-1"
                    placeholder="Search audiobooks across indexers..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  <Button type="submit" size="sm" className="h-9 min-w-[5rem] text-xs shrink-0" disabled={!searchQuery.trim() || searchLoading}>
                    {searchLoading ? <Spinner className="size-3" /> : "Search"}
                  </Button>
                </div>
                {/* Target library info */}
                {selectedLibrary && libraries && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <HugeiconsIcon icon={BookOpen01Icon} size={11} className="text-dim-foreground shrink-0" />
                    <span>
                      Downloads go to{" "}
                      <span className="text-muted-foreground font-medium">
                        {libraries.find((l) => l.id === selectedLibrary)?.name ?? "your library"}
                      </span>
                      {" "}via qBittorrent
                    </span>
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Results from your configured indexers. You are responsible for the legality of downloads in your jurisdiction.
                </p>
              </form>

              {searchLoading && (
                <div className="grid gap-2">
                  <div className="flex items-center gap-2 py-1">
                    <Spinner className="size-3.5" />
                    <span className="text-xs text-muted-foreground">Searching indexers... this may take up to 30s</span>
                  </div>
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-12 rounded-md" />
                  ))}
                </div>
              )}

              {searchData?.error && (
                <p className="text-xs text-destructive">{searchData.error}</p>
              )}

              {!searchLoading && submittedQuery && allSearchResults.length === 0 && !searchData?.error && (
                <EmptyState
                  icon={Search01Icon}
                  title="No results found"
                  description={`No audiobooks found for "${submittedQuery}". Try a different search.`}
                />
              )}

              <AnimatePresence mode="wait">
                {!searchLoading && allSearchResults.length > 0 && (
                  <motion.div
                    key={submittedQuery}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.15, ease: "easeOut" }}
                    className="space-y-3"
                  >
                    {/* Filter chips — language + indexer */}
                    {(availableLangs.length > 1 || availableIndexers.length > 1) && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {availableLangs.length > 1 && availableLangs.map((lang) => (
                          <button
                            key={lang}
                            type="button"
                            onClick={() => setFilterLang(filterLang === lang ? null : lang)}
                            className={cn(
                              "rounded px-2 py-0.5 text-xs font-medium uppercase tracking-wide transition-colors cursor-pointer",
                              filterLang === lang
                                ? cn(LANG_BADGE_COLORS[lang] ?? "bg-muted text-foreground", "ring-1 ring-current/20")
                                : "bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/50",
                            )}
                          >
                            {lang}
                          </button>
                        ))}
                        {availableLangs.length > 1 && availableIndexers.length > 1 && (
                          <span className="w-px h-3.5 bg-border/40 mx-0.5" />
                        )}
                        {availableIndexers.length > 1 && availableIndexers.map((indexer) => (
                          <button
                            key={indexer}
                            type="button"
                            onClick={() => setFilterIndexer(filterIndexer === indexer ? null : indexer)}
                            className={cn(
                              "rounded px-2 py-0.5 text-xs font-medium transition-colors cursor-pointer",
                              filterIndexer === indexer
                                ? "bg-primary/10 text-primary ring-1 ring-primary/20"
                                : "bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/50",
                            )}
                          >
                            {indexer}
                          </button>
                        ))}
                        {(filterLang || filterIndexer) && (
                          <button
                            type="button"
                            onClick={() => { setFilterLang(null); setFilterIndexer(null); }}
                            className="rounded px-2 py-0.5 text-xs text-dim-foreground hover:text-muted-foreground transition-colors cursor-pointer"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    )}

                    <p className="text-xs text-muted-foreground">
                      {searchResults.length} {searchResults.length === 1 ? "release" : "releases"}
                      {searchResults.length < allSearchResults.length
                        ? ` (${allSearchResults.length} total)`
                        : ""}
                    </p>

                    {searchResults.length === 0 && (filterLang || filterIndexer) && (
                      <p className="text-xs text-muted-foreground py-2">
                        No results match the active filters.{" "}
                        <button
                          type="button"
                          onClick={() => { setFilterLang(null); setFilterIndexer(null); }}
                          className="text-primary hover:underline cursor-pointer"
                        >
                          Clear filters
                        </button>
                      </p>
                    )}

                    <div className="grid gap-1.5">
                      {searchResults.map((release, i) => (
                        <motion.div
                          key={`${release.guid ?? release.title}-${i}`}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.12, delay: Math.min(i * 0.03, 0.3), ease: "easeOut" }}
                        >
                          <AudiobookReleaseCard
                            release={release}
                            isDownloading={downloadingUrls.has(release.downloadUrl ?? "")}
                            isDownloaded={downloadedUrls.has(release.downloadUrl ?? "")}
                            onDownload={() => handleDownloadRelease(release)}
                          />
                        </motion.div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
        </div>
      )}

      {/* ═══ Downloads Tab ═══ */}
      {tab === "downloads" && (
        <div className="grid gap-4">
          {!searchConfigured && (importsData?.jobs ?? []).length === 0 ? (
            <EmptyState
              icon={DownloadCircle01Icon}
              title="Connect qBittorrent"
              description="Add qBittorrent in Settings to manage audiobook downloads."
              action={
                <Button variant="outline" size="sm" asChild>
                  <a href="/dashboard/settings">Go to Settings</a>
                </Button>
              }
            />
          ) : (downloadsData?.records?.length ?? 0) === 0 && (importsData?.jobs ?? []).length === 0 ? (
            <EmptyState
              icon={DownloadCircle01Icon}
              title="No audiobook downloads"
              description="Search for audiobooks and download them to see them here."
            />
          ) : (
            <>
              {(downloadsData?.records?.length ?? 0) > 0 && (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      {downloadsData!.records.length} {downloadsData!.records.length === 1 ? "download" : "downloads"}
                      {downloadCount > 0 && ` · ${downloadCount} active`}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Content downloaded via connected services is your responsibility.
                  </p>
                  <div className="grid gap-2">
                    {downloadsData!.records.map((record) => (
                      <DownloadRow
                        key={record.hash}
                        record={record}
                        onRemove={handleRemoveDownload}
                      />
                    ))}
                  </div>
                </>
              )}

              {/* Audible imports */}
              {audibleConnected && (importsData?.jobs ?? []).length > 0 && (
                <>
                  <div className="flex items-center gap-2 mt-2">
                    <HugeiconsIcon icon={HeadphonesIcon} size={12} className="text-dim-foreground" />
                    <p className="text-xs text-muted-foreground">Audible Imports</p>
                  </div>
                  <div className="grid gap-2">
                    {(importsData?.jobs ?? []).map((job) => (
                      <div key={job.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate">{job.title}</p>
                          <p className="text-xs text-muted-foreground">{job.author}</p>
                        </div>
                        {job.status !== "done" && job.status !== "error" && (
                          <div className="w-24 space-y-0.5">
                            <Progress value={job.progress} className="h-1" />
                            <p className="text-xs text-muted-foreground capitalize text-right">{job.status}</p>
                          </div>
                        )}
                        {job.status === "done" && (
                          <span className="text-xs text-status-healthy/70 flex items-center gap-0.5">
                            <HugeiconsIcon icon={Tick01Icon} size={10} />
                            Done
                          </span>
                        )}
                        {job.status === "error" && (
                          <span className="text-xs text-status-critical/70 truncate max-w-[10rem]" title={job.error}>
                            Failed
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

    </div>
  );
}

/* ── Sort helpers ──────────────────────────────────────── */

function getSortParam(sort: SortKey): string {
  switch (sort) {
    case "title-asc":
    case "title-desc":
      return "media.metadata.title";
    case "duration-asc":
    case "duration-desc":
      return "media.duration";
    case "added-asc":
    case "added-desc":
    default:
      return "addedAt";
  }
}
