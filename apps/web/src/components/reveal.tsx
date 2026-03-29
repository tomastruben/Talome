"use client";

import { motion, useInView } from "motion/react";
import { useRef } from "react";

/**
 * Scroll-triggered reveal with Rauno-grade easing.
 *
 * Easing: cubic-bezier(.2, .8, .2, 1) — snappy settle, no bounce.
 * Duration: 500ms for ambient scroll reveals (not interactions).
 * Motion: opacity + 16px y-translate. No scale (stays honest).
 */
export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 16 }}
      animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }}
      transition={{
        duration: 0.5,
        ease: [0.2, 0.8, 0.2, 1],
        delay,
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
