"use client";

import { Button } from "@/components/ui/button";
import Link from "next/link";
import { InstallCommand } from "./install-command";
import { Reveal } from "./reveal";

const steps = [
  {
    num: "01",
    title: "Install",
    desc: "One command. Under a minute.",
  },
  {
    num: "02",
    title: "Talk",
    desc: "Tell it what you want.",
  },
  {
    num: "03",
    title: "Done",
    desc: "Apps running. Monitoring active.",
  },
];

export default function CallToAction() {
  return (
    <section id="install" className="relative py-24 md:py-40">
      <div className="mx-auto max-w-5xl px-6">
        <Reveal>
          <h2 className="text-center text-balance text-4xl font-medium tracking-tight lg:text-5xl">
            Ready in 60 seconds
          </h2>
          <p className="mx-auto mt-4 max-w-md text-center text-muted-foreground">
            Just your server and a single command. You'll be up and running
            before your coffee gets cold.
          </p>
        </Reveal>

        {/* Three steps */}
        <Reveal delay={0.06}>
          <div className="mx-auto mt-16 grid max-w-2xl gap-8 text-center sm:grid-cols-3 md:mt-20">
            {steps.map((step) => (
              <div key={step.num}>
                <span className="block text-3xl font-extralight tabular-nums text-muted-foreground/25">
                  {step.num}
                </span>
                <p className="mt-2 text-sm font-medium">{step.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {step.desc}
                </p>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal delay={0.12}>
          <div className="mt-16 text-center md:mt-20">
            <InstallCommand />

            <div className="mt-14 flex flex-wrap justify-center gap-3">
              <Button
                asChild
                size="lg"
                className="h-12 rounded-full px-8 text-base"
              >
                <Link href="/docs">
                  <span>Read the Docs</span>
                </Link>
              </Button>

              <Button
                asChild
                size="lg"
                variant="outline"
                className="h-12 rounded-full border-border/30 px-8 text-base text-muted-foreground hover:text-foreground"
              >
                <Link href="https://github.com/tomastruben/Talome">
                  <span>Star on GitHub</span>
                </Link>
              </Button>
            </div>
          </div>
        </Reveal>
      </div>

      {/* Separator glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent, oklch(0.76 0 0 / 8%), transparent)",
        }}
      />
    </section>
  );
}
