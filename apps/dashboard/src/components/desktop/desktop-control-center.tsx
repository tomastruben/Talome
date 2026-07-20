"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import Image from "next/image";
import { useTheme } from "next-themes";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  AudioBook01Icon,
  Cancel01Icon,
  DashboardSquare02Icon,
  Download01Icon,
  HeadphonesIcon,
  HugeiconsIcon,
  Image01Icon,
  Moon02Icon,
  PauseIcon,
  PlayIcon,
  Sun01Icon,
} from "@/components/icons";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { useAudiobookPlayer } from "@/hooks/use-audiobook-player";
import { useDownloads } from "@/hooks/use-downloads";
import { formatBytes } from "@/lib/format";

interface DesktopControlCenterProps {
  onOpenAudiobooks: () => void;
  onOpenDownloads: () => void;
  onOpenDashboard: () => void;
  onOpenWallpaper: () => void;
}

const subscribeToHydration = () => () => {};

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

function formatDownloadSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond) return "";
  return bytesPerSecond >= 1048576
    ? `${(bytesPerSecond / 1048576).toFixed(1)} MB/s`
    : `${Math.round(bytesPerSecond / 1024)} KB/s`;
}

function ControlCenterDetailHeader({
  title,
  onBack,
  onOpenApp,
}: {
  title: string;
  onBack: () => void;
  onOpenApp: () => void;
}) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border/70 px-3 py-2.5">
      <button
        type="button"
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-muted hover:text-foreground active:scale-90 motion-reduce:transition-none"
        aria-label="Back to Control Center"
        onClick={onBack}
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} size={16} />
      </button>
      <h2 className="min-w-0 flex-1 truncate text-base font-medium">{title}</h2>
      <button
        type="button"
        className="rounded-full bg-muted px-3 py-1.5 text-xs font-medium transition-[background-color,transform] duration-150 hover:bg-muted/70 active:scale-95 motion-reduce:transition-none"
        onClick={onOpenApp}
      >
        Open app
      </button>
    </header>
  );
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
      className="flex min-h-16 items-center gap-3 rounded-xl border border-border/80 bg-card/75 p-3 text-left transition-[background-color,transform] duration-150 hover:bg-muted/45 active:scale-[0.985] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/40 motion-reduce:transition-none"
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
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const isDark = mounted && resolvedTheme === "dark";
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
        <div className="flex min-h-14 items-center gap-3 p-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <HugeiconsIcon icon={isDark ? Moon02Icon : Sun01Icon} size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Dark Mode</span>
            <span className="block text-xs text-muted-foreground">
              {isDark ? "Dark appearance" : "Light appearance"}
            </span>
          </span>
          <Switch
            checked={isDark}
            disabled={!mounted}
            aria-label="Dark mode"
            onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
          />
        </div>
      </ControlCenterSection>

      <ControlCenterSection>
        {book ? (
          <div className="p-3">
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="shrink-0 rounded-lg transition-transform duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/40 motion-reduce:transition-none"
                aria-label="Open audiobook"
                onClick={onOpenAudiobooks}
              >
                <AudiobookCover key={book.bookId} src={book.coverUrl} title={book.title} />
              </button>
              <button
                type="button"
                className="min-w-0 flex-1 text-left transition-opacity duration-150 active:opacity-70 focus-visible:outline-none motion-reduce:transition-none"
                onClick={onOpenAudiobooks}
              >
                <span className="block text-xs text-muted-foreground">Audiobooks</span>
                <span className="block truncate text-sm font-medium">{book.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{book.author}</span>
              </button>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className="flex size-8 items-center justify-center rounded-full bg-foreground text-background transition-[opacity,transform] duration-150 hover:opacity-80 active:scale-90 motion-reduce:transition-none"
                  aria-label={state.isPlaying ? "Pause audiobook" : "Play audiobook"}
                  onClick={togglePlay}
                >
                  <HugeiconsIcon icon={state.isPlaying ? PauseIcon : PlayIcon} size={15} />
                </button>
                <button
                  type="button"
                  className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-muted hover:text-foreground active:scale-90 motion-reduce:transition-none"
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
            className="group flex w-full items-center gap-3 p-3 text-left transition-[background-color,transform] duration-150 hover:bg-muted/35 active:scale-[0.99] motion-reduce:transition-none"
            onClick={onOpenAudiobooks}
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <HugeiconsIcon icon={AudioBook01Icon} size={19} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Audiobooks</span>
              <span className="block text-xs text-muted-foreground">Nothing playing</span>
            </span>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={14}
              className="text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none"
            />
          </button>
        )}
      </ControlCenterSection>

      <ControlCenterSection>
        <button
          type="button"
          className="group grid w-full gap-2 p-3 text-left transition-[background-color,transform] duration-150 hover:bg-muted/35 active:scale-[0.99] motion-reduce:transition-none"
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
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={14}
              className="text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none"
            />
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

export function DesktopAudiobooksControlCenter({
  onBack,
  onOpenApp,
}: {
  onBack: () => void;
  onOpenApp: () => void;
}) {
  const { book, state, togglePlay, stop } = useAudiobookPlayer();
  const audiobookProgress = book && book.totalDuration > 0
    ? Math.min(100, (state.currentTime / book.totalDuration) * 100)
    : 0;

  return (
    <div className="flex min-h-[18rem] flex-col">
      <ControlCenterDetailHeader
        title="Audiobooks"
        onBack={onBack}
        onOpenApp={onOpenApp}
      />
      <div className="flex min-h-0 flex-1 flex-col justify-center p-4">
        {book ? (
          <div className="grid gap-4">
            <div className="flex items-center gap-4">
              <AudiobookCover key={book.bookId} src={book.coverUrl} title={book.title} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{book.title}</p>
                <p className="truncate text-xs text-muted-foreground">{book.author}</p>
              </div>
              <button
                type="button"
                className="flex size-10 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-[opacity,transform] duration-150 hover:opacity-80 active:scale-90 motion-reduce:transition-none"
                aria-label={state.isPlaying ? "Pause audiobook" : "Play audiobook"}
                onClick={togglePlay}
              >
                <HugeiconsIcon icon={state.isPlaying ? PauseIcon : PlayIcon} size={17} />
              </button>
            </div>
            <div className="grid gap-2 rounded-xl border border-border/80 bg-card/75 p-3">
              <Progress value={audiobookProgress} className="h-1" />
              <div className="flex items-center justify-between text-xs tabular-nums text-muted-foreground">
                <span>{state.isBuffering ? "Buffering…" : state.isPlaying ? "Playing" : "Paused"}</span>
                <span>
                  {formatPlaybackTime(state.currentTime)} / {formatPlaybackTime(book.totalDuration)}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="justify-self-center rounded-full px-3 py-1.5 text-xs text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-muted hover:text-foreground active:scale-95 motion-reduce:transition-none"
              onClick={stop}
            >
              Stop playback
            </button>
          </div>
        ) : (
          <div className="grid justify-items-center gap-3 py-6 text-center">
            <span className="flex size-16 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <HugeiconsIcon icon={AudioBook01Icon} size={26} />
            </span>
            <div>
              <p className="text-sm font-medium">Nothing playing</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Choose a title from your audiobook library.
              </p>
            </div>
            <button
              type="button"
              className="rounded-full bg-foreground px-4 py-2 text-xs font-medium text-background transition-[opacity,transform] duration-150 hover:opacity-80 active:scale-95 motion-reduce:transition-none"
              onClick={onOpenApp}
            >
              Browse Audiobooks
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function DesktopDownloadsControlCenter({
  onBack,
  onOpenApp,
}: {
  onBack: () => void;
  onOpenApp: () => void;
}) {
  const { queue, torrents, isLoading, error } = useDownloads();
  const activeTorrents = torrents.filter((torrent) => torrent.state === "downloading");
  const downloads = [
    ...queue.map((item) => ({
      id: `queue-${item.id}`,
      title: item.title,
      progress: item.progress ?? 0,
      speed: item.dlspeed ?? 0,
      size: item.size,
    })),
    ...activeTorrents.map((torrent) => ({
      id: `torrent-${torrent.hash}`,
      title: torrent.name,
      progress: torrent.progress,
      speed: torrent.dlspeed,
      size: torrent.size,
    })),
  ];

  return (
    <div className="flex min-h-[18rem] max-h-[min(34rem,calc(100dvh-4rem))] flex-col">
      <ControlCenterDetailHeader
        title="Downloads"
        onBack={onBack}
        onOpenApp={onOpenApp}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {isLoading ? (
          <p className="py-12 text-center text-sm text-muted-foreground">Checking downloads…</p>
        ) : error ? (
          <p className="py-12 text-center text-sm text-muted-foreground">Download status is unavailable.</p>
        ) : downloads.length === 0 ? (
          <div className="grid justify-items-center gap-3 py-10 text-center">
            <span className="flex size-16 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <HugeiconsIcon icon={Download01Icon} size={26} />
            </span>
            <div>
              <p className="text-sm font-medium">No active downloads</p>
              <p className="mt-1 text-xs text-muted-foreground">New activity will appear here.</p>
            </div>
          </div>
        ) : (
          <div className="grid gap-2">
            {downloads.map((download) => {
              const progress = Math.round(download.progress * 100);
              const speed = formatDownloadSpeed(download.speed);
              return (
                <div
                  key={download.id}
                  className="grid gap-2 rounded-xl border border-border/80 bg-card/75 p-3"
                >
                  <div className="flex items-start gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <HugeiconsIcon icon={Download01Icon} size={16} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{download.title}</p>
                      <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                        {formatBytes(download.size * download.progress)} of {formatBytes(download.size)}
                        {speed ? ` · ${speed}` : ""}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{progress}%</span>
                  </div>
                  <Progress value={progress} className="h-1" />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
