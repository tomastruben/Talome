"use client";

import { useEffect, useRef } from "react";
import { useInView } from "motion/react";

/**
 * Animated evolution visualization — a living network of nodes that
 * continuously rewires itself, representing Talome's self-improvement.
 *
 * Nodes pulse, connections form and dissolve, and periodically a "spark"
 * travels along a connection — representing a code change being applied.
 *
 * Rendered on <canvas> for performance. Pauses when offscreen.
 * Fully responsive — nodes reposition proportionally on resize.
 */

interface Node {
  /** Position as 0-1 ratio of canvas dimensions */
  rx: number;
  ry: number;
  vx: number;
  vy: number;
  radius: number;
  pulse: number;
  pulseSpeed: number;
}

interface Spark {
  fromIdx: number;
  toIdx: number;
  progress: number;
  speed: number;
}

const NODE_COUNT = 24;
const CONNECTION_RATIO = 0.14; // fraction of canvas width for connection distance
const SPARK_INTERVAL = 2200;
const NODE_COLOR = "rgba(255, 255, 255, 0.15)";
const SPARK_COLOR = "rgba(210, 175, 110, 0.4)";
const PULSE_COLOR = "rgba(255, 255, 255, 0.06)";

function createNodes(): Node[] {
  const nodes: Node[] = [];
  for (let i = 0; i < NODE_COUNT; i++) {
    nodes.push({
      rx: Math.random(),
      ry: Math.random(),
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      radius: 1.5 + Math.random() * 1,
      pulse: Math.random() * Math.PI * 2,
      pulseSpeed: 0.02 + Math.random() * 0.02,
    });
  }
  return nodes;
}

export function EvolutionVisual({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inView = useInView(containerRef, { margin: "100px" });
  const nodesRef = useRef<Node[]>([]);
  const sparksRef = useRef<Spark[]>([]);
  const lastSparkRef = useRef(0);
  const animRef = useRef<number>(0);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });

  // Initialize nodes once
  useEffect(() => {
    if (nodesRef.current.length === 0) {
      nodesRef.current = createNodes();
    }
  }, []);

  // Handle canvas sizing via ResizeObserver — no accumulating transforms
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

  // Animation loop — reads sizeRef, applies DPR transform per frame
  useEffect(() => {
    if (!inView) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const animate = () => {
      const { w, h, dpr } = sizeRef.current;
      if (w === 0 || h === 0) {
        animRef.current = requestAnimationFrame(animate);
        return;
      }

      const connectionDist = w * CONNECTION_RATIO;

      // Reset transform and clear
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const nodes = nodesRef.current;
      const sparks = sparksRef.current;
      const now = Date.now();

      // Move nodes (using ratios, velocity in pixels)
      for (const node of nodes) {
        const px = node.rx * w;
        const py = node.ry * h;
        const nx = px + node.vx;
        const ny = py + node.vy;

        // Soft bounce
        if (nx < 0 || nx > w) node.vx *= -1;
        if (ny < 0 || ny > h) node.vy *= -1;

        node.rx = Math.max(0, Math.min(1, nx / w));
        node.ry = Math.max(0, Math.min(1, ny / h));
        node.pulse += node.pulseSpeed;
      }

      // Draw connections
      for (let i = 0; i < nodes.length; i++) {
        const ax = nodes[i].rx * w;
        const ay = nodes[i].ry * h;
        for (let j = i + 1; j < nodes.length; j++) {
          const bx = nodes[j].rx * w;
          const by = nodes[j].ry * h;
          const dx = ax - bx;
          const dy = ay - by;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < connectionDist) {
            const alpha = 1 - dist / connectionDist;
            ctx.beginPath();
            ctx.strokeStyle = `rgba(255, 255, 255, ${0.02 * alpha})`;
            ctx.lineWidth = 0.5;
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
          }
        }
      }

      // Draw nodes with pulse
      for (const node of nodes) {
        const px = node.rx * w;
        const py = node.ry * h;
        const pulseSize = Math.sin(node.pulse) * 0.4 + 0.6;

        ctx.beginPath();
        ctx.arc(px, py, node.radius * 3 * pulseSize, 0, Math.PI * 2);
        ctx.fillStyle = PULSE_COLOR;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(px, py, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = NODE_COLOR;
        ctx.fill();
      }

      // Spawn sparks
      if (now - lastSparkRef.current > SPARK_INTERVAL) {
        for (let attempts = 0; attempts < 10; attempts++) {
          const i = Math.floor(Math.random() * nodes.length);
          const j = Math.floor(Math.random() * nodes.length);
          if (i === j) continue;
          const dx = nodes[i].rx * w - nodes[j].rx * w;
          const dy = nodes[i].ry * h - nodes[j].ry * h;
          if (Math.sqrt(dx * dx + dy * dy) < connectionDist) {
            sparks.push({
              fromIdx: i,
              toIdx: j,
              progress: 0,
              speed: 0.015 + Math.random() * 0.01,
            });
            lastSparkRef.current = now;
            break;
          }
        }
      }

      // Draw and update sparks
      for (let s = sparks.length - 1; s >= 0; s--) {
        const spark = sparks[s];
        spark.progress += spark.speed;

        if (spark.progress >= 1) {
          nodes[spark.toIdx].pulse = 0;
          nodes[spark.toIdx].pulseSpeed = 0.08;
          setTimeout(() => {
            if (nodes[spark.toIdx]) {
              nodes[spark.toIdx].pulseSpeed = 0.02 + Math.random() * 0.02;
            }
          }, 400);
          sparks.splice(s, 1);
          continue;
        }

        const from = nodes[spark.fromIdx];
        const to = nodes[spark.toIdx];
        const fx = from.rx * w;
        const fy = from.ry * h;
        const tx = to.rx * w;
        const ty = to.ry * h;
        const sx = fx + (tx - fx) * spark.progress;
        const sy = fy + (ty - fy) * spark.progress;

        // Spark glow
        const gradient = ctx.createRadialGradient(sx, sy, 0, sx, sy, 8);
        gradient.addColorStop(0, SPARK_COLOR);
        gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
        ctx.beginPath();
        ctx.arc(sx, sy, 8, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();

        // Spark core
        ctx.beginPath();
        ctx.arc(sx, sy, 2, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(210, 175, 110, 0.5)";
        ctx.fill();

        // Trail
        const trailStart = Math.max(0, spark.progress - 0.15);
        const tsx = fx + (tx - fx) * trailStart;
        const tsy = fy + (ty - fy) * trailStart;
        ctx.beginPath();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
        ctx.lineWidth = 1;
        ctx.moveTo(tsx, tsy);
        ctx.lineTo(sx, sy);
        ctx.stroke();
      }

      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, [inView]);

  return (
    <div ref={containerRef} className={className} aria-hidden>
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 size-full"
      />
    </div>
  );
}
