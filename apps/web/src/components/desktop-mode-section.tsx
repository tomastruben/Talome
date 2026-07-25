"use client";

import {
  ComputerTerminal01Icon,
  HugeiconsIcon,
  Layers01Icon,
  Layout03Icon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import { Reveal } from "./reveal";

const benefits: Array<{
  title: string;
  description: string;
  icon: IconSvgElement;
}> = [
  {
    title: "Work side by side",
    description:
      "Open Files beside Terminal, keep Media visible, and let the assistant work without giving up the rest of your screen.",
    icon: Layout03Icon,
  },
  {
    title: "Keep your context",
    description:
      "Resize, minimize, and switch between Talome tools and installed apps while windows keep their place and state.",
    icon: Layers01Icon,
  },
  {
    title: "Choose how you work",
    description:
      "Use Desktop Mode for spatial workflows or return to the focused classic interface. The same server and features power both.",
    icon: ComputerTerminal01Icon,
  },
];

export function DesktopModeSection() {
  return (
    <section id="desktop-mode" className="relative py-24 md:py-36">
      <div className="mx-auto max-w-6xl px-6 lg:px-12">
        <Reveal>
          <div className="mx-auto max-w-3xl text-center">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary/80">
              Desktop mode
            </p>
            <h2 className="mt-5 text-balance text-4xl font-medium tracking-tight md:text-5xl lg:text-6xl">
              Everything your server does.
              <br className="hidden sm:block" /> One workspace.
            </h2>
            <p className="mx-auto mt-6 max-w-2xl text-balance text-base leading-relaxed text-muted-foreground md:text-lg">
              Talome turns the browser into a persistent workspace for your
              server. Launch tools and installed apps, arrange them around the
              task, and keep the assistant close while everything else stays in
              motion.
            </p>
          </div>
        </Reveal>

        <div className="mt-14 grid gap-3 md:mt-20 md:grid-cols-3">
          {benefits.map((benefit, index) => (
            <Reveal key={benefit.title} delay={index * 0.06}>
              <article className="feature-card flex h-full flex-col rounded-2xl border border-border/15 p-7 md:p-8">
                <div className="flex size-10 items-center justify-center rounded-xl border border-primary/15 bg-primary/[0.07] text-primary">
                  <HugeiconsIcon icon={benefit.icon} size={20} />
                </div>
                <h3 className="mt-8 text-xl font-medium tracking-tight">
                  {benefit.title}
                </h3>
                <p className="mt-3 text-[15px] leading-[1.7] text-muted-foreground">
                  {benefit.description}
                </p>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal delay={0.12}>
          <p className="mx-auto mt-10 max-w-2xl text-center text-sm leading-relaxed text-muted-foreground/75">
            Desktop Mode is available on desktop-class browsers. Phones and
            touch-first devices keep Talome&rsquo;s responsive mobile experience.
          </p>
        </Reveal>
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent, oklch(0.82 0.12 75 / 12%), transparent)",
        }}
      />
    </section>
  );
}
