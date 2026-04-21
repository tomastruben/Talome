"use client";

import { useRef, useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import type { ChapterInfo } from "./types";

export interface MediaSliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (val: number) => void;
  /** Fires on pointer hover with {clientX, value}, null on leave. */
  onHoverPosition?: (pos: { clientX: number; value: number } | null) => void;
  /** Chapter markers to render on the timeline. */
  chapters?: ChapterInfo[];
  /** Buffered position (same unit as value) — shown as a buffer bar ahead of the fill. */
  buffered?: number;
  className?: string;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function MediaSlider({ value, min, max, step, onChange, onHoverPosition, chapters, buffered, className }: MediaSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [hoveredChapter, setHoveredChapter] = useState<{ name: string; pct: number } | null>(null);

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
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;
    onChange(valFromPointer(e.clientX));
  }, [onChange, valFromPointer]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (dragging.current) {
      onChange(valFromPointer(e.clientX));
    }
  }, [onChange, valFromPointer]);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const range = max - min || 1;
  const pct = ((clamp(value) - min) / range) * 100;
  const bufferedPct = buffered != null ? ((clamp(buffered) - min) / range) * 100 : 0;

  // Find which chapter the cursor is hovering over
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const hoverVal = valFromPointer(e.clientX);
    onHoverPosition?.({ clientX: e.clientX, value: hoverVal });

    if (chapters && chapters.length > 0) {
      for (let i = chapters.length - 1; i >= 0; i--) {
        if (hoverVal >= chapters[i].startSeconds) {
          const chPct = ((chapters[i].startSeconds - min) / range) * 100;
          const nextPct = i + 1 < chapters.length
            ? ((chapters[i + 1].startSeconds - min) / range) * 100
            : 100;
          const midPct = (chPct + nextPct) / 2;
          setHoveredChapter({ name: chapters[i].name, pct: midPct });
          return;
        }
      }
    }
    setHoveredChapter(null);
  }, [onHoverPosition, valFromPointer, chapters, min, range]);

  const onMouseLeave = useCallback(() => {
    onHoverPosition?.(null);
    setHoveredChapter(null);
  }, [onHoverPosition]);

  // Chapter marks: skip the first (always at 0) — it's the start of the video
  const chapterMarks = chapters && chapters.length > 1
    ? chapters.slice(1).map((ch) => ((ch.startSeconds - min) / range) * 100)
    : [];

  return (
    <div
      ref={trackRef}
      className={cn("media-slider", className)}
      data-dragging={dragging.current ? "" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      <div className="media-slider-track">
        {bufferedPct > 0 && (
          <div className="media-slider-buffer" style={{ width: `${bufferedPct}%` }} />
        )}
        <div className="media-slider-fill" style={{ width: `${pct}%` }} />
      </div>

      {/* Chapter dividers — hairline gaps in the track */}
      {chapterMarks.map((markPct, i) => (
        <div
          key={i}
          className="media-slider-chapter-mark"
          style={{ left: `${markPct}%` }}
        />
      ))}

      {/* Chapter name — appears on hover, centered over the chapter region */}
      {hoveredChapter && (
        <div
          className="media-slider-chapter-label"
          style={{ left: `${hoveredChapter.pct}%` }}
        >
          {hoveredChapter.name}
        </div>
      )}

      <div className="media-slider-thumb" style={{ left: `${pct}%` }} />
    </div>
  );
}
