"use client";

import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";
import { motion, useReducedMotion } from "motion/react";
import { memo, useMemo } from "react";

const shimmerElements = {
  p: motion.p,
  span: motion.span,
  div: motion.div,
} as const;

export interface TextShimmerProps {
  children: string;
  as?: keyof typeof shimmerElements;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const MotionComponent = shimmerElements[Component] ?? shimmerElements.p;
  // The sweep is a loop: static text under reduced motion.
  const reduceMotion = useReducedMotion();

  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread]
  );

  return (
    <MotionComponent
      animate={reduceMotion ? undefined : { backgroundPosition: "0% center" }}
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className
      )}
      initial={reduceMotion ? false : { backgroundPosition: "100% center" }}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          backgroundImage:
            "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
        } as CSSProperties
      }
      transition={{
        duration,
        ease: "linear",
        repeat: Number.POSITIVE_INFINITY,
      }}
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);
