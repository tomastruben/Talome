"use client";

import { useMemo, useRef, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  HugeiconsIcon,
  PlayIcon,
  PauseIcon,
  GoForward15SecIcon,
  GoBackward15SecIcon,
  NextIcon,
  PreviousIcon,
  VolumeHighIcon,
  VolumeLowIcon,
  VolumeMute01Icon,
  VolumeOffIcon,
  DashboardSpeed01Icon,
} from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { IconSvgElement } from "@/components/icons";
import type { AudioPlayerChapter } from "@/atoms/audio-player";

/* ── Types ─────────────────────────────────────────────── */

export type { AudioPlayerChapter as Chapter };

export interface AudiobookPlayerControlsProps {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  speed: number;
  volume: number;
  muted: boolean;
  chapters: AudioPlayerChapter[];
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onSkip: (delta: number) => void;
  onSpeedChange: (speed: number) => void;
  onVolumeToggleMute: () => void;
}

/* ── Helpers ───────────────────────────────────────────── */

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function getVolumeIcon({ volume, muted }: { volume: number; muted: boolean }): IconSvgElement {
  if (muted || volume === 0) return VolumeOffIcon;
  if (volume < 0.33) return VolumeMute01Icon;
  if (volume < 0.66) return VolumeLowIcon;
  return VolumeHighIcon;
}

/* ── MediaSlider ───────────────────────────────────────── */

function MediaSlider({ value, min, max, step, onChange, className }: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (val: number) => void;
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const clamp = useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max]);

  const valFromPointer = useCallback((clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return value;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const raw = min + ratio * (max - min);
    if (step && step > 0) return clamp(Math.round(raw / step) * step);
    return clamp(raw);
  }, [min, max, step, value, clamp]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    onChange(valFromPointer(e.clientX));

    const onMove = (ev: PointerEvent) => {
      onChange(valFromPointer(ev.clientX));
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [onChange, valFromPointer]);

  const range = max - min || 1;
  const pct = ((clamp(value) - min) / range) * 100;

  return (
    <div
      ref={trackRef}
      className={cn("media-slider media-slider-audiobook", className)}
      onPointerDown={onPointerDown}
    >
      <div className="media-slider-track">
        <div className="media-slider-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="media-slider-thumb" style={{ left: `${pct}%` }} />
    </div>
  );
}

/* ── AudiobookPlayerControls ─────────────────────────── */

export function AudiobookPlayerControls({
  isPlaying,
  currentTime,
  duration,
  speed,
  volume,
  muted,
  chapters,
  onTogglePlay,
  onSeek,
  onSkip,
  onSpeedChange,
  onVolumeToggleMute,
}: AudiobookPlayerControlsProps) {
  // Find current chapter
  const currentChapter = useMemo(
    () => chapters.find((ch) => currentTime >= ch.start && currentTime < ch.end),
    [chapters, currentTime],
  );

  const currentChapterIndex = currentChapter
    ? chapters.findIndex((ch) => ch.id === currentChapter.id)
    : -1;

  const goToChapter = useCallback((direction: "prev" | "next") => {
    if (chapters.length === 0) return;
    let targetIdx: number;
    if (direction === "prev") {
      if (currentChapter && currentTime - currentChapter.start > 3 && currentChapterIndex >= 0) {
        targetIdx = currentChapterIndex;
      } else {
        targetIdx = Math.max(0, currentChapterIndex - 1);
      }
    } else {
      targetIdx = Math.min(chapters.length - 1, currentChapterIndex + 1);
    }
    const target = chapters[targetIdx];
    if (target) onSeek(target.start);
  }, [chapters, currentChapter, currentChapterIndex, currentTime, onSeek]);

  const hasChapters = chapters.length > 0;
  const totalDuration = duration || 1;

  return (
    <div className="w-full space-y-4">
      {/* Chapter name */}
      <AnimatePresence mode="wait">
        {currentChapter && (
          <motion.p
            key={currentChapter.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="text-xs text-muted-foreground text-center truncate"
          >
            {currentChapter.title}
          </motion.p>
        )}
      </AnimatePresence>

      {/* Progress slider */}
      <div className="space-y-1.5">
        <MediaSlider
          min={0}
          max={totalDuration}
          step={0.5}
          value={currentTime}
          onChange={onSeek}
        />
        <div className="flex justify-between">
          <span className="text-sm text-muted-foreground tabular-nums">
            {formatTime(currentTime)}
          </span>
          <span className="text-sm text-muted-foreground tabular-nums">
            {totalDuration > 0 ? `-${formatTime(totalDuration - currentTime)}` : "0:00"}
          </span>
        </div>
      </div>

      {/* Transport controls */}
      <div className="flex items-center justify-center gap-6">
        {hasChapters && (
          <button
            onClick={() => goToChapter("prev")}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Previous chapter"
          >
            <HugeiconsIcon icon={PreviousIcon} size={18} />
          </button>
        )}

        <button
          onClick={() => onSkip(-15)}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <HugeiconsIcon icon={GoBackward15SecIcon} size={22} />
        </button>

        <button
          onClick={onTogglePlay}
          className="size-14 rounded-full bg-foreground/10 hover:bg-foreground/15 flex items-center justify-center transition-colors active:scale-[0.96]"
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={isPlaying ? "pause" : "play"}
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.8, opacity: 0 }}
              transition={{ duration: 0.12, ease: "easeOut" }}
              className={cn("flex items-center justify-center", !isPlaying && "ml-0.5")}
            >
              <HugeiconsIcon
                icon={isPlaying ? PauseIcon : PlayIcon}
                size={24}
                className="text-foreground"
              />
            </motion.div>
          </AnimatePresence>
        </button>

        <button
          onClick={() => onSkip(15)}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <HugeiconsIcon icon={GoForward15SecIcon} size={22} />
        </button>

        {hasChapters && (
          <button
            onClick={() => goToChapter("next")}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Next chapter"
          >
            <HugeiconsIcon icon={NextIcon} size={18} />
          </button>
        )}
      </div>

      {/* Speed + volume */}
      <div className="flex items-center justify-between">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <HugeiconsIcon icon={DashboardSpeed01Icon} size={14} />
              {speed}x
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-20">
            {SPEED_OPTIONS.map((s) => (
              <DropdownMenuItem
                key={s}
                onClick={() => onSpeedChange(s)}
                className={cn(s === speed && "font-medium text-foreground")}
              >
                {s}x
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          onClick={onVolumeToggleMute}
          className="text-dim-foreground hover:text-muted-foreground transition-colors"
        >
          <HugeiconsIcon icon={getVolumeIcon({ volume, muted })} size={16} />
        </button>
      </div>
    </div>
  );
}
