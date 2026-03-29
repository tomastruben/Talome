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
    "Every home server today works the same way: a dashboard, a list of apps, and you as the operator. You install. You configure. You debug at midnight. You are the intelligence. What if the server itself could think? Read its own source code. Spot problems before you notice them. Fix crashes at 3 AM while you sleep. Learn your preferences and remember everything. Rewrite its own code to get faster. This is Talome. Running on your hardware. Right now.";
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
