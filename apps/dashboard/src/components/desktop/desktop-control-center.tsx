"use client";

import { useState, type ReactNode } from "react";
import Image from "next/image";
import {
  ArrowRight01Icon,
  AudioBook01Icon,
  Cancel01Icon,
  DashboardSquare02Icon,
  Download01Icon,
  HeadphonesIcon,
  HugeiconsIcon,
  Image01Icon,
  PauseIcon,
  PlayIcon,
} from "@/components/icons";
import { Progress } from "@/components/ui/progress";
import { useAudiobookPlayer } from "@/hooks/use-audiobook-player";
import { useDownloads } from "@/hooks/use-downloads";

interface DesktopControlCenterProps {
  onOpenAudiobooks: () => void;
  onOpenDownloads: () => void;
  onOpenDashboard: () => void;
  onOpenWallpaper: () => void;
}

function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function ControlCenterTile({
  icon,
  label,
  detail,
  onClick,
}: {
  icon: typeof DashboardSquare02Icon;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex min-h-16 items-center gap-3 rounded-xl border border-border/80 bg-card/75 p-3 text-left transition-colors duration-150 hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/40"
      onClick={onClick}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
        <HugeiconsIcon icon={icon} size={16} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}

function AudiobookCover({ src, title }: { src: string; title: string }) {
  const [failed, setFailed] = useState(false);

  return (
    <span className="relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
      {!failed && src ? (
        <Image
          src={src}
          alt={`${title} cover`}
          fill
          sizes="48px"
          className="object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <HugeiconsIcon icon={HeadphonesIcon} size={20} className="text-muted-foreground" />
      )}
    </span>
  );
}

function ControlCenterSection({ children }: { children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/80 bg-card/75">
      {children}
    </section>
  );
}

export function DesktopControlCenter({
  onOpenAudiobooks,
  onOpenDownloads,
  onOpenDashboard,
  onOpenWallpaper,
}: DesktopControlCenterProps) {
  const { book, state, togglePlay, stop } = useAudiobookPlayer();
  const {
    queue,
    torrents,
    isLoading,
    error,
    isActivelyDownloading,
  } = useDownloads();
  const activeTorrents = torrents.filter((torrent) => torrent.state === "downloading");
  const activeCount = queue.length + activeTorrents.length;
  const primaryQueueItem = queue[0];
  const primaryTorrent = activeTorrents[0];
  const downloadTitle = primaryQueueItem?.title ?? primaryTorrent?.name;
  const downloadProgress = Math.round(
    (primaryQueueItem?.progress ?? primaryTorrent?.progress ?? 0) * 100,
  );
  const audiobookProgress = book && book.totalDuration > 0
    ? Math.min(100, (state.currentTime / book.totalDuration) * 100)
    : 0;

  return (
    <div className="grid gap-2 p-3" aria-label="Control Center panel">
      <div className="flex items-center justify-between px-1 pb-1">
        <h2 className="text-base font-medium">Control Center</h2>
        {(state.isPlaying || isActivelyDownloading) ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-status-healthy" />
            Active
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <ControlCenterTile
          icon={DashboardSquare02Icon}
          label="Dashboard"
          detail="Classic widget layout"
          onClick={onOpenDashboard}
        />
        <ControlCenterTile
          icon={Image01Icon}
          label="Wallpaper"
          detail="Change desktop"
          onClick={onOpenWallpaper}
        />
      </div>

      <ControlCenterSection>
        {book ? (
          <div className="p-3">
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="shrink-0 rounded-lg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/40"
                aria-label="Open audiobook"
                onClick={onOpenAudiobooks}
              >
                <AudiobookCover key={book.bookId} src={book.coverUrl} title={book.title} />
              </button>
              <button
                type="button"
                className="min-w-0 flex-1 text-left focus-visible:outline-none"
                onClick={onOpenAudiobooks}
              >
                <span className="block text-xs text-muted-foreground">Audiobooks</span>
                <span className="block truncate text-sm font-medium">{book.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{book.author}</span>
              </button>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className="flex size-8 items-center justify-center rounded-full bg-foreground text-background transition-opacity duration-150 hover:opacity-80"
                  aria-label={state.isPlaying ? "Pause audiobook" : "Play audiobook"}
                  onClick={togglePlay}
                >
                  <HugeiconsIcon icon={state.isPlaying ? PauseIcon : PlayIcon} size={15} />
                </button>
                <button
                  type="button"
                  className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
                  aria-label="Stop audiobook"
                  onClick={stop}
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={13} />
                </button>
              </div>
            </div>
            <Progress value={audiobookProgress} className="mt-3 h-1" />
            <div className="mt-1.5 flex items-center justify-between text-xs tabular-nums text-muted-foreground">
              <span>{state.isBuffering ? "Buffering…" : state.isPlaying ? "Playing" : "Paused"}</span>
              <span>
                {formatPlaybackTime(state.currentTime)} / {formatPlaybackTime(book.totalDuration)}
              </span>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="flex w-full items-center gap-3 p-3 text-left transition-colors duration-150 hover:bg-muted/35"
            onClick={onOpenAudiobooks}
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <HugeiconsIcon icon={AudioBook01Icon} size={19} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Audiobooks</span>
              <span className="block text-xs text-muted-foreground">Nothing playing</span>
            </span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={14} className="text-muted-foreground" />
          </button>
        )}
      </ControlCenterSection>

      <ControlCenterSection>
        <button
          type="button"
          className="grid w-full gap-2 p-3 text-left transition-colors duration-150 hover:bg-muted/35"
          aria-label="Open downloads"
          onClick={onOpenDownloads}
        >
          <span className="flex items-center gap-3">
            <span className="relative flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <HugeiconsIcon icon={Download01Icon} size={18} />
              {isActivelyDownloading ? (
                <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-status-healthy" />
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Downloads</span>
              <span className="block truncate text-xs text-muted-foreground">
                {isLoading
                  ? "Checking activity…"
                  : error
                    ? "Status unavailable"
                    : activeCount > 0
                      ? `${activeCount} active`
                      : "No active downloads"}
              </span>
            </span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={14} className="text-muted-foreground" />
          </span>
          {downloadTitle ? (
            <span className="grid gap-1">
              <span className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span className="truncate">{downloadTitle}</span>
                <span className="shrink-0 tabular-nums">{downloadProgress}%</span>
              </span>
              <Progress value={downloadProgress} className="h-1" />
            </span>
          ) : null}
        </button>
      </ControlCenterSection>
    </div>
  );
}
