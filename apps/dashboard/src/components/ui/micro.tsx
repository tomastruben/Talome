"use client";

import { useCallback, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { DURATION, enter, exit } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * Small moments that make state changes feel earned. Tuned after
 * transitions.dev by Jakub Antalik (free set, MIT); the keyframes live in
 * globals.css under "Micro-interactions".
 */

/** A check that fades up into place while its stroke draws. */
export function SuccessCheck({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <span className={cn("tm-success-check text-status-healthy", className)} aria-hidden>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.16" />
        <path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/**
 * Text whose changed characters rise into place. Unchanged characters stay
 * put, so a clock ticking from 9:41 to 9:42 only moves the last digit.
 */
export function PopText({ value, className }: { value: string; className?: string }) {
  const [shown, setShown] = useState({ value, before: value, generation: 0 });
  if (shown.value !== value) {
    setShown({ value, before: shown.value, generation: shown.generation + 1 });
  }
  const { before, generation } = shown;
  return (
    <span className={cn("inline-flex tabular-nums", className)} aria-label={value}>
      {value.split("").map((ch, i) => {
        const changed = generation > 0 && before[i] !== ch;
        return (
          <span key={changed ? `${i}-${generation}` : `${i}`} className={changed ? "tm-digit" : undefined} aria-hidden>
            {ch === " " ? "\u00a0" : ch}
          </span>
        );
      })}
    </span>
  );
}

/**
 * A round selection mark: the ring fills and the check draws itself when
 * selected, and unselecting is quick and quiet.
 */
export function SelectMark({ selected, size = 16, className }: { selected: boolean; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      data-selected={selected || undefined}
      className={cn("tm-select-mark", className)}
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" className="tm-select-ring" />
      <path d="M7.5 12.5l3 3 6-6.5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="tm-select-check" />
    </svg>
  );
}

/**
 * Two icons in one slot: the outgoing one shrinks away through a blur as the
 * other arrives (entrance DURATION.base, exit DURATION.exitFast). Under reduced
 * motion the icons swap in place, with no animation at all.
 */
export function IconSwap({ active, a, b, className }: { active: "a" | "b"; a: ReactNode; b: ReactNode; className?: string }) {
  const reduceMotion = useReducedMotion();
  const icon = active === "a" ? a : b;
  if (reduceMotion) {
    return (
      <span className={cn("relative inline-grid place-items-center", className)}>
        <span className="col-start-1 row-start-1 inline-flex">{icon}</span>
      </span>
    );
  }
  return (
    <span className={cn("relative inline-grid place-items-center", className)}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={active}
          className="col-start-1 row-start-1 inline-flex"
          initial={{ opacity: 0, scale: 0.25, filter: "blur(2px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)", transition: enter(DURATION.base) }}
          exit={{ opacity: 0, scale: 0.25, filter: "blur(2px)", transition: exit(DURATION.exitFast) }}
        >
          {icon}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** Shake an element to say "not quite": add `shakeClassName` and call `shake()`. Replays every time. */
export function useShake() {
  const [count, setCount] = useState(0);
  const shake = useCallback(() => setCount((c) => c + 1), []);
  // Alternating animation names restarts the shake without touching layout
  const shakeClassName = count === 0 ? undefined : count % 2 === 1 ? "tm-shake" : "tm-shake-again";
  return { shake, shakeClassName };
}

/**
 * Pointer handlers that tilt a surface a few degrees toward the cursor, with a
 * soft light following it (pair with the `tm-tilt` class). Mouse only — touch
 * and pens get the ordinary press — and nothing under reduced motion (CSS).
 */
export const tiltHandlers = {
  onPointerMove(event: React.PointerEvent<HTMLElement>) {
    if (event.pointerType !== "mouse") return;
    const el = event.currentTarget;
    const rect = el.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    el.style.setProperty("--tm-rx", `${((0.5 - y) * 7).toFixed(2)}deg`);
    el.style.setProperty("--tm-ry", `${((x - 0.5) * 7).toFixed(2)}deg`);
    el.style.setProperty("--tm-gx", `${(x * 100).toFixed(1)}%`);
    el.style.setProperty("--tm-gy", `${(y * 100).toFixed(1)}%`);
    el.dataset.tilting = "";
  },
  onPointerLeave(event: React.PointerEvent<HTMLElement>) {
    const el = event.currentTarget;
    el.style.removeProperty("--tm-rx");
    el.style.removeProperty("--tm-ry");
    delete el.dataset.tilting;
  },
};

// Copy feedback: use `CopyButton` (ui/copy-button — COPY_REVERT_MS, the
// plain-http clipboard fallback and the live announcer), not a hook here.
