"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { EvolutionVisual } from "./evolution-visual";

function RevealWord({
  word,
  index,
  total,
  progress,
}: {
  word: string;
  index: number;
  total: number;
  progress: ReturnType<typeof useScroll>["scrollYProgress"];
}) {
  const opacity = useTransform(
    progress,
    [index / total, (index + 1) / total],
    [0.25, 1]
  );

  return (
    <motion.span style={{ opacity }} className="mr-[0.25em] inline-block">
      {word}
    </motion.span>
  );
}

export function StorySection() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start 0.9", "end 0.5"],
  });

  const text =
    "Most home servers still work the same way: one dashboard, one page at a time, and you as the operator. Talome gives everything on your machine a shared workspace — then gives that workspace intelligence. It can read logs, connect apps, spot problems before you notice them, and fix crashes while you sleep. It remembers how your system works. It can even improve its own code. This is Talome. Your server, working as one system.";
  const words = text.split(" ");

  return (
    <section className="relative py-24 md:py-40">
      {/* Evolution network — lives behind the text */}
      <EvolutionVisual className="absolute inset-0 overflow-hidden" />

      <div ref={containerRef} className="relative z-10 mx-auto max-w-3xl px-6">
        <p className="flex flex-wrap justify-center text-center text-2xl font-medium leading-relaxed tracking-tight text-foreground md:text-3xl md:leading-relaxed">
          {words.map((word, i) => (
            <RevealWord
              key={`${word}-${i}`}
              word={word}
              index={i}
              total={words.length}
              progress={scrollYProgress}
            />
          ))}
        </p>
      </div>
    </section>
  );
}
