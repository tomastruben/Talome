"use client";

import { motion } from "motion/react";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { DURATION, enter } from "@/lib/motion";

export interface ThinkingIndicatorProps {
  label?: string;
  state?: OrbState;
  className?: string;
}

/**
 * A small dotted orb and a shimmering label: the assistant is working on it.
 * Under reduced motion the orb draws one still frame (thinking-orbs reads
 * prefers-reduced-motion) and the shimmer stops (globals.css).
 */
export function ThinkingIndicator({ label = "Thinking", state = "breathing", className }: ThinkingIndicatorProps) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={enter(DURATION.base)}
      className={className ?? "flex items-center gap-2 py-1"}
      role="status"
      aria-live="polite"
    >
      <ThinkingOrb state={state} size={20} aria-hidden />
      <Shimmer as="span" className="text-sm" duration={1.8}>
        {label}
      </Shimmer>
    </motion.div>
  );
}
