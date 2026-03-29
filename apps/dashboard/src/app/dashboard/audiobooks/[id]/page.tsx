"use client";

import Image from "next/image";
import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSetAtom } from "jotai";
import { motion } from "framer-motion";
import { pageTitleAtom } from "@/atoms/page-title";
import { pageBackAtom } from "@/atoms/page-back";
import useSWR from "swr";
import { CORE_URL } from "@/lib/constants";
import { AudiobookPlayerControls, type Chapter } from "@/components/audiobooks/audio-player";
import { useAudiobookPlayer } from "@/hooks/use-audiobook-player";
import type { AudioPlayerBook } from "@/atoms/audio-player";
import {
  HugeiconsIcon,
  BookOpen01Icon,
} from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
/** Lazy-load DOMPurify — only needed on this detail page */
let _purify: { sanitize: (dirty: string) => string } | null = null;
function sanitizeHtml(dirty: string): string {
  if (!_purify) {
    // DOMPurify v3 CJS export is a factory; call it with window to get the instance
    const mod = require("dompurify");
    _purify = typeof mod === "function" ? mod(window) : (mod.default ?? mod);
  }
  return _purify!.sanitize(dirty);
}

/* ── Types ─────────────────────────────────────────────── */

interface AudiobookDetail {
  id: string;
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
      isbn?: string;
      asin?: string;
    };
    duration?: number;
    size?: number;
    numChapters?: number;
    numAudioFiles?: number;
    chapters?: Chapter[];
    audioFiles?: {
      index: number;
      ino: string;
      duration: number;
      metadata: { filename: string; size: number };
    }[];
  };
}

interface ProgressData {
  currentTime: number;
  progress: number;
  isFinished: boolean;
}

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

function formatChapterDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function coverUrl(itemId: string, width = 400): string {
  return `${CORE_URL}/api/audiobooks/cover?id=${itemId}&w=${width}`;
}

/* ── Page ──────────────────────────────────────────────── */

export default function AudiobookDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const setPageTitle = useSetAtom(pageTitleAtom);
  const setPageBack = useSetAtom(pageBackAtom);

  const [imgFailed, setImgFailed] = useState(false);
  const activeChapterRef = useRef<HTMLDivElement>(null);

  // Global player state
  const player = useAudiobookPlayer();
  const isThisBookActive = player.isActiveBook(id);
  const globalCurrentTime = isThisBookActive ? player.state.currentTime : 0;

  // Local scrub position for when book isn't loaded in engine yet
  const [localSeekTime, setLocalSeekTime] = useState<number | null>(null);

  const { data: item, isLoading } = useSWR<AudiobookDetail>(
    id ? `${CORE_URL}/api/audiobooks/item/${id}` : null,
    fetcher,
    { revalidateOnFocus: false },
  );

  const { data: progress } = useSWR<ProgressData>(
    id ? `${CORE_URL}/api/audiobooks/progress/${id}` : null,
    fetcher,
    { revalidateOnFocus: false },
  );

  useEffect(() => {
    const title = item?.media?.metadata?.title;
    if (title) setPageTitle(title);
    setPageBack(() => () => router.push("/dashboard/audiobooks"));
    return () => { setPageTitle(null); setPageBack(null); };
  }, [item?.media?.metadata?.title, setPageTitle, setPageBack, router]);

  // Auto-scroll to active chapter
  const activeChapterId = (() => {
    if (!isThisBookActive) return null;
    const chapters = item?.media?.chapters ?? [];
    const ch = chapters.find((c) => globalCurrentTime >= c.start && globalCurrentTime < c.end);
    return ch?.id ?? null;
  })();

  useEffect(() => {
    if (activeChapterRef.current) {
      activeChapterRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeChapterId]);

  const startPlayback = useCallback((initialTime?: number) => {
    if (!item) return;
    const meta = item.media?.metadata;
    const audioFiles = item.media?.audioFiles ?? [];
    const chapters = item.media?.chapters ?? [];

    const bookPayload: AudioPlayerBook = {
      bookId: id,
      title: meta?.title ?? "Untitled",
      author: meta?.authorName ?? "",
      coverUrl: coverUrl(id),
      chapters: chapters.map((c) => ({ id: c.id, start: c.start, end: c.end, title: c.title })),
      trackMetas: audioFiles.map((f) => ({ index: f.index, duration: f.duration })),
      totalDuration: item.media?.duration ?? 0,
    };

    const time = initialTime ?? progress?.currentTime ?? 0;
    player.loadBook(bookPayload, time);
  }, [item, id, progress, player]);

  // Effective state: uses engine state when active, local state otherwise
  const effectiveCurrentTime = isThisBookActive
    ? player.state.currentTime
    : (localSeekTime ?? progress?.currentTime ?? 0);

  const handleTogglePlay = useCallback(() => {
    if (isThisBookActive) {
      player.togglePlay();
    } else {
      startPlayback(localSeekTime ?? progress?.currentTime ?? 0);
    }
  }, [isThisBookActive, player, startPlayback, localSeekTime, progress?.currentTime]);

  const handleSeek = useCallback((time: number) => {
    if (isThisBookActive) {
      player.seekTo(time);
    } else {
      setLocalSeekTime(time);
    }
  }, [isThisBookActive, player]);

  const handleSkip = useCallback((delta: number) => {
    const current = isThisBookActive
      ? player.state.currentTime
      : (localSeekTime ?? progress?.currentTime ?? 0);
    const dur = item?.media?.duration ?? 0;
    const target = Math.max(0, Math.min(dur, current + delta));
    if (isThisBookActive) {
      player.seekTo(target);
    } else {
      setLocalSeekTime(target);
    }
  }, [isThisBookActive, player, localSeekTime, progress?.currentTime, item?.media?.duration]);

  const handleChapterClick = useCallback((chapter: Chapter) => {
    if (isThisBookActive) {
      player.seekTo(chapter.start);
      if (!player.state.isPlaying) {
        player.play();
      }
    } else {
      startPlayback(chapter.start);
    }
  }, [isThisBookActive, player, startPlayback]);

  if (isLoading || !item) {
    return (
      <div className="pb-24 lg:pb-0 lg:flex lg:flex-col lg:flex-1 lg:min-h-0">
        {/* Mobile */}
        <div className="lg:hidden flex flex-col items-center text-center gap-5">
          <Skeleton className="w-[180px] h-[180px] sm:w-[220px] sm:h-[220px] rounded-xl" />
          <div className="space-y-2 w-full max-w-sm">
            <Skeleton className="h-7 w-3/4 mx-auto" />
            <Skeleton className="h-4 w-1/2 mx-auto" />
            <Skeleton className="h-4 w-2/5 mx-auto" />
          </div>
          <div className="flex items-center gap-3">
            <Skeleton className="h-3.5 w-12" />
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-3.5 w-10" />
          </div>
          <div className="w-full max-w-sm space-y-3">
            <Skeleton className="h-2 w-full rounded-full" />
            <div className="flex items-center justify-center gap-6">
              <Skeleton className="size-8 rounded-full" />
              <Skeleton className="size-11 rounded-full" />
              <Skeleton className="size-8 rounded-full" />
            </div>
          </div>
        </div>
        {/* Desktop */}
        <div className="hidden lg:grid grid-cols-[minmax(0,520px)_minmax(0,420px)] justify-center gap-8 flex-1 min-h-0">
          <div className="flex flex-col items-center text-center space-y-4">
            <Skeleton className="w-[240px] h-[240px] rounded-xl" />
            <div className="space-y-2 w-full max-w-sm">
              <Skeleton className="h-7 w-3/4 mx-auto" />
              <Skeleton className="h-4 w-1/2 mx-auto" />
            </div>
            <div className="flex items-center gap-3">
              <Skeleton className="h-3.5 w-12" />
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-3.5 w-10" />
            </div>
            <div className="w-full max-w-sm space-y-3">
              <Skeleton className="h-2 w-full rounded-full" />
              <div className="flex items-center justify-center gap-6">
                <Skeleton className="size-8 rounded-full" />
                <Skeleton className="size-11 rounded-full" />
                <Skeleton className="size-8 rounded-full" />
              </div>
            </div>
            <div className="w-full pt-4 space-y-2">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          </div>
          <div className="space-y-1">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 py-2.5 px-3">
                <Skeleton className="h-3.5 w-5 shrink-0" />
                <Skeleton className="h-3.5" style={{ width: `${50 + (i * 17) % 40}%` }} />
                <Skeleton className="h-3.5 w-10 shrink-0" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const meta = item.media?.metadata;
  const chapters = item.media?.chapters ?? [];
  const totalDuration = item.media?.duration ?? 0;
  /* ── Shared elements ───────────────────────────────── */

  const coverWithGlow = (
    <div className="relative">
      {/* Ambient glow */}
      {!imgFailed && (
        <Image
          src={coverUrl(id)}
          alt=""
          aria-hidden
          width={400}
          height={400}
          className="audiobook-detail-glow"
          unoptimized
        />
      )}
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        <div className="audiobook-card-cover">
          {!imgFailed ? (
            <Image
              src={coverUrl(id)}
              alt={meta?.title ?? ""}
              className="object-cover"
              fill
              onError={() => setImgFailed(true)}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <HugeiconsIcon icon={BookOpen01Icon} size={40} className="text-dim-foreground" />
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );

  const statsRow = (
    <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
      {totalDuration > 0 && <span>{formatDuration(totalDuration)}</span>}
      {chapters.length > 0 && <span>{chapters.length} chapters</span>}
      {item.media?.size && <span>{formatSize(item.media.size)}</span>}
      {meta?.publishedYear && <span>{meta.publishedYear}</span>}
    </div>
  );

  const playerWidget = (
    <div>
      <AudiobookPlayerControls
        isPlaying={isThisBookActive ? player.state.isPlaying : false}
        currentTime={effectiveCurrentTime}
        duration={totalDuration}
        speed={isThisBookActive ? player.state.speed : 1}
        volume={isThisBookActive ? player.state.volume : 1}
        muted={isThisBookActive ? player.state.muted : false}
        chapters={chapters}
        onTogglePlay={handleTogglePlay}
        onSeek={handleSeek}
        onSkip={handleSkip}
        onSpeedChange={player.setSpeed}
        onVolumeToggleMute={() => player.setVolume(player.state.volume, !player.state.muted)}
      />
    </div>
  );

  const chapterRows = (
    <div className="space-y-0.5">
      {chapters.map((chapter, i) => {
        const isActive = activeChapterId === chapter.id;
        const chapterDuration = chapter.end - chapter.start;
        return (
          <div
            key={chapter.id}
            ref={isActive ? activeChapterRef : undefined}
            className={cn(
              "flex items-center gap-3 py-2.5 px-3 rounded-lg transition-colors cursor-pointer",
              isActive ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.03]",
            )}
            onClick={() => handleChapterClick(chapter)}
          >
            <span className={cn(
              "text-sm tabular-nums w-5 text-right shrink-0",
              isActive ? "text-muted-foreground" : "text-muted-foreground",
            )}>
              {i + 1}
            </span>
            <span className={cn(
              "text-sm flex-1 truncate",
              isActive ? "font-medium text-foreground" : "text-muted-foreground",
            )}>
              {chapter.title}
            </span>
            <span className="text-sm text-muted-foreground tabular-nums shrink-0">
              {formatChapterDuration(chapterDuration)}
            </span>
          </div>
        );
      })}
    </div>
  );

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className="pb-24 lg:pb-0 lg:flex lg:flex-col lg:flex-1 lg:min-h-0"
    >
      {/* ─────────────────── MOBILE ─────────────────────── */}
      <div className="lg:hidden flex flex-col items-center text-center gap-5">
        <div className="w-[180px] sm:w-[220px]">{coverWithGlow}</div>

        <div className="space-y-1 max-w-sm">
          <h1 className="text-2xl font-medium leading-tight">{meta?.title}</h1>
          {meta?.subtitle && <p className="text-sm text-muted-foreground">{meta.subtitle}</p>}
          {meta?.authorName && (
            <p className="text-sm text-muted-foreground mt-1 line-clamp-1">
              {meta.authorName}
            </p>
          )}
          {meta?.narratorName && meta.narratorName !== meta.authorName && (
            <p className="text-sm text-muted-foreground line-clamp-1">
              Narrated by {meta.narratorName.split(",")[0]}
            </p>
          )}
        </div>

        <div className="flex justify-center">{statsRow}</div>
        <div className="w-full max-w-sm">{playerWidget}</div>

        {meta?.description && (
          <div className="text-left w-full">
            <h2 className="text-sm font-medium mb-2">About</h2>
            <div
              className="text-sm text-muted-foreground leading-relaxed prose-sm [&_p]:mb-2 [&_p:last-child]:mb-0"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(meta.description) }}
            />
          </div>
        )}

        {meta?.genres && meta.genres.length > 0 && (
          <div className="flex flex-wrap gap-2 w-full">
            {meta.genres.map((g) => <span key={g} className="media-genre-pill">{g}</span>)}
          </div>
        )}

        {chapters.length > 0 && (
          <div className="w-full text-left">
            <ScrollArea className="max-h-[400px]">
              <div className="pb-4">{chapterRows}</div>
            </ScrollArea>
          </div>
        )}
      </div>

      {/* ─────────────────── DESKTOP ────────────────────── */}
      <div className={cn(
        "hidden lg:grid gap-8 flex-1 min-h-0",
        chapters.length > 0
          ? "grid-cols-[minmax(0,520px)_minmax(0,420px)] justify-center"
          : "max-w-lg mx-auto",
      )}>
        {/* ── Left column: cover, metadata, player ────── */}
        <ScrollArea className="h-full">
          <div className="flex flex-col items-center text-center space-y-4 pb-8">
            <div className="w-[240px]">{coverWithGlow}</div>

            <div className="space-y-1 max-w-sm">
              <h1 className="text-2xl font-medium leading-tight">{meta?.title}</h1>
              {meta?.subtitle && <p className="text-sm text-muted-foreground">{meta.subtitle}</p>}
              {meta?.authorName && (
                <p className="text-sm text-muted-foreground mt-1 line-clamp-1">
                  Written By {meta.authorName}{meta?.narratorName ? `, Narrated By ${meta.narratorName.split(",")[0]}` : ""}
                </p>
              )}
            </div>

            {statsRow}
            <div className="w-full max-w-sm">{playerWidget}</div>

            {meta?.description && (
              <div className="text-left w-full pt-2">
                <h2 className="text-sm font-medium mb-2">About</h2>
                <div
                  className="text-sm text-muted-foreground leading-relaxed prose-sm [&_p]:mb-2 [&_p:last-child]:mb-0"
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(meta.description) }}
                />
              </div>
            )}
            {meta?.genres && meta.genres.length > 0 && (
              <div className="flex flex-wrap gap-2 w-full">
                {meta.genres.map((g) => <span key={g} className="media-genre-pill">{g}</span>)}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* ── Right column: chapters ── */}
        {chapters.length > 0 && (
          <div className="flex flex-col min-h-0">
            <ScrollArea className="flex-1 min-h-0">
              <div className="pb-6">{chapterRows}</div>
            </ScrollArea>
          </div>
        )}
      </div>
    </motion.div>
  );
}
