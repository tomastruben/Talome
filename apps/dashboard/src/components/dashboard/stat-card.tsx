"use client";

import { motion, useSpring, useTransform } from "framer-motion";
import { useEffect, useId, useRef, useCallback, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { HugeiconsIcon } from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import type { MetricSample } from "@/hooks/use-system-stats";

// ── Constants ─────────────────────────────────────────────────────────────────

const CHART_WINDOW_MS = 60_000;
const CHART_FPS = 30;

// ── Theme-stable colors ───────────────────────────────────────────────────────
// SVG attributes can't resolve CSS custom properties — use plain rgba().
export const COLORS = {
  normal:   { stroke: "rgba(120,120,130,0.40)", fill: "rgba(120,120,130,0.08)" },
  warning:  { stroke: "rgba(234,179,8,0.50)",   fill: "rgba(234,179,8,0.08)"   },
  critical: { stroke: "rgba(239,68,68,0.55)",   fill: "rgba(239,68,68,0.10)"   },
  rx:       { stroke: "rgba(148,163,184,0.55)",  fill: "rgba(148,163,184,0.08)" },
  tx:       { stroke: "rgba(148,163,184,0.30)",  fill: "rgba(148,163,184,0.04)" },
};

// ── Animated number ──────────────────────────────────────────────────────────

function AnimatedNumber({ value, suffix = "" }: { value: number; suffix?: string }) {
  const spring = useSpring(0, { stiffness: 60, damping: 20 });
  const display = useTransform(spring, (v) =>
    suffix === "%" ? `${v.toFixed(1)}${suffix}` : `${Math.round(v)}${suffix}`
  );
  useEffect(() => { spring.set(value); }, [spring, value]);
  return <motion.span>{display}</motion.span>;
}

// ── Animated bar ─────────────────────────────────────────────────────────────

function AnimatedBar({ value }: { value: number }) {
  const spring = useSpring(0, { stiffness: 40, damping: 20 });
  const width = useTransform(spring, (v) => `${Math.min(v, 100)}%`);
  useEffect(() => { spring.set(value); }, [spring, value]);
  const barColor = value >= 90 ? "bg-status-critical/70" : value >= 70 ? "bg-status-warning/60" : "bg-foreground/20";
  return (
    <div className="h-px w-full overflow-hidden rounded-full bg-border mt-4">
      <motion.div className={`h-full rounded-full ${barColor}`} style={{ width }} />
    </div>
  );
}

interface SparklineProps {
  data: MetricSample[];
  stroke?: string;
  fill?: string;
  strokeWidth?: number;
  height?: number;
}

export function SlidingSparkline({
  data,
  stroke = COLORS.normal.stroke,
  fill   = COLORS.normal.fill,
  strokeWidth = 1,
  height = 48,
}: SparklineProps) {
  const uid = useId();
  const gradId = `sg${uid.replace(/[^a-z0-9]/gi, "")}`;

  const pathRef = useRef<SVGPathElement>(null);
  const areaRef = useRef<SVGPathElement>(null);
  const rafRef = useRef<number>(0);
  const lastDrawRef = useRef<number>(0);
  const dataRef = useRef<MetricSample[]>(data);
  const scaleMaxRef = useRef<number>(1);

  const W = 100;
  const H = 40;

  const buildPath = useCallback((pts: { x: number; y: number }[]) => {
    if (pts.length < 2) return { line: "", area: "" };

    const lineD = pts.reduce((acc, p, i) => {
      if (i === 0) return `M ${p.x.toFixed(3)} ${p.y.toFixed(3)}`;
      const prev = pts[i - 1];
      const cpx = ((prev.x + p.x) / 2).toFixed(3);
      return `${acc} C ${cpx} ${prev.y.toFixed(3)} ${cpx} ${p.y.toFixed(3)} ${p.x.toFixed(3)} ${p.y.toFixed(3)}`;
    }, "");

    const last = pts[pts.length - 1];
    const first = pts[0];
    const areaD = `${lineD} L ${last.x.toFixed(3)} ${H} L ${first.x.toFixed(3)} ${H} Z`;

    return { line: lineD, area: areaD };
  }, [H]);

  const buildVisibleSamples = useCallback((samples: MetricSample[], now: number): MetricSample[] => {
    if (samples.length === 0) return [];

    const cutoff = now - CHART_WINDOW_MS;
    const firstVisibleIndex = samples.findIndex((sample) => sample.ts >= cutoff);

    if (firstVisibleIndex === -1) {
      const last = samples[samples.length - 1];
      return last ? [last, { ts: now, value: last.value }] : [];
    }

    const visible: MetricSample[] = [];

    if (firstVisibleIndex > 0) {
      visible.push({
        ts: cutoff,
        value: samples[firstVisibleIndex - 1].value,
      });
    }

    visible.push(...samples.slice(firstVisibleIndex));

    const last = visible[visible.length - 1];
    if (last && last.ts < now) {
      visible.push({ ts: now, value: last.value });
    }

    return visible;
  }, []);

  const redraw = useCallback((now: number) => {
    const visibleSamples = buildVisibleSamples(dataRef.current, now);
    if (visibleSamples.length < 2) {
      pathRef.current?.setAttribute("d", "");
      areaRef.current?.setAttribute("d", "");
      return;
    }

    const values = visibleSamples.map((sample) => sample.value);
    const dataMax = Math.max(...values, 1);
    scaleMaxRef.current = Math.max(dataMax, scaleMaxRef.current * 0.985);

    const coords = visibleSamples.map((sample) => ({
      x: ((sample.ts - (now - CHART_WINDOW_MS)) / CHART_WINDOW_MS) * W,
      y: H - (sample.value / scaleMaxRef.current) * (H - 6) - 3,
    }));

    const { line, area } = buildPath(coords);
    pathRef.current?.setAttribute("d", line);
    areaRef.current?.setAttribute("d", area);
  }, [H, W, buildPath, buildVisibleSamples]);

  useEffect(() => {
    dataRef.current = data;
    redraw(Date.now());
  }, [data, redraw]);

  useEffect(() => {
    const frameInterval = 1000 / CHART_FPS;

    const tick = (frameTime: number) => {
      if (frameTime - lastDrawRef.current >= frameInterval) {
        lastDrawRef.current = frameTime;
        redraw(Date.now());
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [redraw]);

  if (data.length === 0) return null;

  return (
    <div
      className="absolute inset-0 pointer-events-none overflow-hidden"
      style={{ height }}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 w-full h-full"
        style={{ display: "block" }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={fill} stopOpacity={0.9} />
            <stop offset="100%" stopColor={fill} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path ref={areaRef} fill={`url(#${gradId})`} stroke="none" />
        <path
          ref={pathRef}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}

// ── StatCard ──────────────────────────────────────────────────────────────────

interface StatCardProps {
  title: string;
  value: number;
  suffix?: string;
  subtitle?: string;
  icon?: IconSvgElement;
  showBar?: boolean;
  history?: MetricSample[];
}

export function StatCard({ title, value, suffix, subtitle, icon, showBar = false, history }: StatCardProps) {
  const palette = COLORS.normal;

  return (
    <Card className="relative overflow-hidden min-h-[100px]">
      {icon && (
        <div className="pointer-events-none absolute -right-4 -top-4 opacity-[0.055] dark:opacity-[0.07]">
          <HugeiconsIcon icon={icon} size={88} className="text-foreground" />
        </div>
      )}

      <CardContent className="relative p-3.5 sm:p-5 pb-8">
        <p className="text-xs sm:text-sm text-muted-foreground">{title}</p>
        <p className="mt-0.5 sm:mt-1 text-xl sm:text-2xl font-medium tracking-tight tabular-nums">
          <AnimatedNumber value={value} suffix={suffix} />
        </p>
        {subtitle && (
          <p className="mt-0.5 text-xs sm:text-sm text-muted-foreground truncate">{subtitle}</p>
        )}
        {showBar && <AnimatedBar value={value} />}
      </CardContent>

      {/* Sparkline 4px below the bottom of the card content */}
      {history && history.length > 2 && (
        <div className="absolute bottom-0 left-0 right-0 h-10 translate-y-1">
          <SlidingSparkline
            data={history}
            stroke={palette.stroke}
            fill={palette.fill}
          />
        </div>
      )}
    </Card>
  );
}
