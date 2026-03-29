"use client";

import { useEffect, useRef } from "react";

/**
 * Dot-only double helix — a field of particles tracing a helical path.
 *
 * No strands, no rungs, no lines. Just dots whose size and opacity
 * encode depth: large bright dots are close, small dim dots are far.
 * The brain fills in the helix structure from the pattern alone.
 *
 * Metaphor: signals flowing, data assembling, code evolving.
 * Drifts upward continuously. Fully responsive via ResizeObserver.
 */
export function HelixBg({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<number>(0);
  const timeRef = useRef(0);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width === 0 || height === 0) continue;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        sizeRef.current = { w: width, h: height, dpr };
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const ROTATION_SPEED = 0.005;
    const DRIFT_SPEED = 0.25;
    const TWIST_FREQ = 0.014;
    const DOT_SPACING = 10;

    const animate = () => {
      const { w, h, dpr } = sizeRef.current;
      if (w === 0 || h === 0) {
        animRef.current = requestAnimationFrame(animate);
        return;
      }

      timeRef.current += ROTATION_SPEED;
      const time = timeRef.current;
      const centerX = w * 0.5;
      const amplitude = Math.min(w * 0.12, 110);

      const period = (2 * Math.PI) / TWIST_FREQ;
      const drift = (performance.now() * DRIFT_SPEED * 0.01) % period;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const extra = Math.ceil(period);
      const count = Math.ceil((h + extra + 60) / DOT_SPACING);

      // Collect all dots, then sort by Z for correct layering
      const dots: { x: number; y: number; z: number }[] = [];

      for (let i = 0; i < count; i++) {
        const rawY = -40 + i * DOT_SPACING;
        const displayY = rawY - drift;
        const angle = rawY * TWIST_FREQ + time;

        // Strand A
        dots.push({
          x: centerX + amplitude * Math.sin(angle),
          y: displayY,
          z: Math.cos(angle),
        });

        // Strand B
        dots.push({
          x: centerX + amplitude * Math.sin(angle + Math.PI),
          y: displayY,
          z: Math.cos(angle + Math.PI),
        });
      }

      // Sort back-to-front so closer dots paint on top
      dots.sort((a, b) => a.z - b.z);

      for (const dot of dots) {
        // Skip dots outside visible area
        if (dot.y < -10 || dot.y > h + 10) continue;

        // depth: 0 = far back, 1 = close front
        // Use cubic easing for smoother depth transition
        const linear = (dot.z + 1) / 2;
        const depth = linear * linear * (3 - 2 * linear); // smoothstep

        const radius = 0.6 + depth * 2.2;
        const alpha = 0.015 + depth * 0.15;

        // Blend from neutral white to warm amber based on depth
        const warm = Math.max(0, (depth - 0.4) / 0.6); // 0 below 0.4, ramps to 1
        const r = Math.round(255 + (210 - 255) * warm);
        const g = Math.round(255 + (175 - 255) * warm);
        const b = Math.round(255 + (110 - 255) * warm);

        ctx.beginPath();
        ctx.arc(dot.x, dot.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
        ctx.fill();
      }

      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, []);

  return (
    <div ref={containerRef} className={className} aria-hidden>
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 size-full"
      />
    </div>
  );
}
