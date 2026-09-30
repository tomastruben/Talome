"use client";

import { MotionConfig } from "motion/react";

/**
 * Honours the operating system's reduced-motion setting for every motion/react
 * animation below it: transform and layout animation are dropped and opacity
 * is kept. Rendered once at the root layout (which covers /login, /setup and
 * every desktop window, since each window is an iframe running the same
 * layout) and again at the dashboard and desktop shells, so the rule holds
 * even if a shell is ever mounted outside the root layout.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
