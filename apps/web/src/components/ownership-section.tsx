"use client";

import { Reveal } from "./reveal";

const pillars = [
  {
    title: "Self-hosted",
    desc: "Runs on your hardware. Your living room, your closet, your rack. Complete independence, complete control, always yours.",
  },
  {
    title: "Fully open source",
    desc: "AGPL-3.0 licensed. Read every line, fork it, modify it, contribute back. The entire codebase is yours to inspect and extend.",
  },
  {
    title: "Private by design",
    desc: "Your server talks to you and only you. Every byte of data stays on your machine, always.",
  },
];

export function OwnershipSection() {
  return (
    <section className="py-24 md:py-40">
      <div className="mx-auto max-w-5xl px-6">
        <Reveal>
          <div className="text-center">
            <h2 className="text-balance text-4xl font-medium tracking-tight lg:text-5xl">
              Your server. Your data.
              <br className="hidden sm:block" /> Your rules.
            </h2>
            <p className="mx-auto mt-6 max-w-lg text-[15px] leading-relaxed text-muted-foreground">
              Your intelligence runs entirely on your hardware. Full control.
              Full ownership. Always.
            </p>
          </div>
        </Reveal>

        <div className="mx-auto mt-16 grid max-w-4xl gap-3 md:mt-24 md:grid-cols-3">
          {pillars.map((pillar, i) => (
            <Reveal key={pillar.title} delay={i * 0.06}>
              <div className="flex h-full flex-col rounded-2xl border border-border/15 bg-card/8 p-8 md:p-10">
                <h3 className="text-base font-medium">{pillar.title}</h3>
                <p className="mt-3 text-[15px] leading-[1.7] text-muted-foreground">
                  {pillar.desc}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
