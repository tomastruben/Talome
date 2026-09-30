/**
 * Motion tokens for Talome.
 *
 * Every duration, easing curve and travel distance used by motion/react
 * comes from here. The CSS mirror lives in `app/globals.css` (`--ease-*`,
 * `--duration-*`), so class-based transitions and JS animations agree.
 *
 * Rules (see CLAUDE.md, "Motion restraint"):
 * - Entrances are at most 200ms (180ms default) on EASE_ENTER.
 * - Exits are 120 to 140ms on EASE_EXIT, always faster than the entrance.
 * - Opacity finishes before transform, at about 60% of the duration.
 * - Direction comes from short travel (TRAVEL), never full-width slides.
 * - The only spring is DRAG_SETTLE_SPRING, after a drag is released.
 */

// ── Curves ──────────────────────────────────────────────────────────────────

/** Anything appearing or moving into place. */
export const EASE_ENTER = [0.22, 1, 0.36, 1] as const;
/** Anything leaving. Short, so it never "hangs". */
export const EASE_EXIT = [0.4, 0, 1, 1] as const;
/** Progress fills and loops only. */
export const EASE_LINEAR = "linear" as const;

/** CSS equivalents, for inline `transition` strings and Web Animations. */
export const CSS_EASE_ENTER = "cubic-bezier(0.22, 1, 0.36, 1)";
export const CSS_EASE_EXIT = "cubic-bezier(0.4, 0, 1, 1)";

// ── Durations (seconds, for motion/react) ───────────────────────────────────

export const DURATION = {
  /** Press feedback, tooltip fade. */
  press: 0.1,
  /** Hover, colour, small reveals, menus and popovers in, tabs indicator, height glide. */
  fast: 0.15,
  /** Dialogs, stack push, window open, sheet content, toasts in. */
  base: 0.18,
  /** Edge-anchored sheets in. The 200ms ceiling. */
  sheet: 0.2,
  /** Overlays out (dialog, sheet, stack exit, window close). */
  exit: 0.14,
  /** Menus, popovers, toasts and pills out; the reduced-motion crossfade. */
  exitFast: 0.12,
  /** Maximum per progress update, linear. */
  progress: 0.25,
} as const;

/** Durations in milliseconds, for timers and CSS strings. */
export const DURATION_MS = {
  press: 100,
  fast: 150,
  base: 180,
  sheet: 200,
  exit: 140,
  exitFast: 120,
  progress: 250,
} as const satisfies Record<keyof typeof DURATION, number>;

// ── Travel (px) ─────────────────────────────────────────────────────────────

/** Direction through short distance, never full-width slides. */
export const TRAVEL = { nudge: 2, rise: 4, lift: 6, push: 24, pushExit: -12 } as const;

// ── Transitions ─────────────────────────────────────────────────────────────

type Bezier = readonly [number, number, number, number];

export interface TweenTransition {
  duration: number;
  ease: Bezier | typeof EASE_LINEAR;
  opacity?: { duration: number; ease: Bezier };
}

/** Entrance: opacity finishes at ~60% of the duration, transform runs the full length. */
export function enter(d: number = DURATION.base): TweenTransition {
  return {
    duration: d,
    ease: EASE_ENTER,
    opacity: { duration: round(d * 0.6), ease: EASE_ENTER },
  };
}

/** Exit: one short curve for everything. */
export function exit(d: number = DURATION.exit): TweenTransition {
  return { duration: d, ease: EASE_EXIT };
}

/** A tween for values that change after mount (stat numbers, bars). */
export function tween(d: number = DURATION.fast): TweenTransition {
  return { duration: d, ease: EASE_ENTER };
}

/** Progress fills track real data: linear, at most 250ms per update. */
export const progress = { duration: DURATION.progress, ease: EASE_LINEAR } as const;

/** The only spring: settling after a drag release. Damping ratio ≈ 1.03, so no overshoot. */
export const DRAG_SETTLE_SPRING = { type: "spring", stiffness: 500, damping: 46, mass: 1 } as const;

/** Damping ratio of a spring. Anything below 1 overshoots. Exported for tests and reviews. */
export function dampingRatio(spring: { stiffness: number; damping: number; mass?: number }): number {
  const mass = spring.mass ?? 1;
  return spring.damping / (2 * Math.sqrt(spring.stiffness * mass));
}

// ── Presets ─────────────────────────────────────────────────────────────────

export const fadeRise = {
  initial: { opacity: 0, y: TRAVEL.rise },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: TRAVEL.rise },
} as const;

export const fadeScale = {
  initial: { opacity: 0, scale: 0.98 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.98 },
} as const;

export const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
} as const;

// ── Timing thresholds (ms) ──────────────────────────────────────────────────

/** Show nothing for this long before a skeleton appears. */
export const SKELETON_DELAY_MS = 200;
/** Once shown, a skeleton stays at least this long. */
export const SKELETON_MIN_VISIBLE_MS = 300;
/** A busy button shows its spinner only after this delay, so fast work never flashes. */
export const BUSY_DELAY_MS = 150;
/** CopyButton reverts from "Copied" after this long. */
export const COPY_REVERT_MS = 2000;
/** Undo toasts stay this long. */
export const UNDO_WINDOW_MS = 6000;

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
