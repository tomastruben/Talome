"use client";

import Link from "next/link";
import { useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { HeroHeader } from "./header";
import { InstallCommand } from "./install-command";
import { HelixBg } from "./helix-bg";

export default function HeroSection() {
  const reduceMotion = useReducedMotion();

  return (
    <>
      <HeroHeader />
      <main className="overflow-x-hidden">
        <section className="relative">
          <div className="relative z-10 mx-auto max-w-7xl px-6 pb-24 pt-44 text-center lg:px-12 lg:pt-56 lg:pb-32">
            <div className="mb-8 flex flex-wrap items-center justify-center gap-2">
              <span className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-primary">
                Desktop mode
              </span>
              <span className="rounded-full border border-border/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                Public alpha
              </span>
            </div>

            <h1 className="gradient-heading mx-auto max-w-4xl text-balance text-5xl font-medium leading-[1.06] tracking-tight md:text-6xl lg:text-7xl">
              Your server, now a desktop
              <br />
              that thinks.
            </h1>

            <p className="mx-auto mt-8 max-w-2xl text-balance text-lg leading-relaxed text-muted-foreground">
              Apps, files, media, terminals, and AI working side by side in one
              spatial workspace. Talome installs, connects, diagnoses, and
              improves the system behind it. Your hardware. Your data. Your
              desktop.
            </p>

            <div className="mt-12 space-y-6">
              <div className="flex flex-wrap items-center justify-center gap-3">
                <Button
                  asChild
                  size="lg"
                  className="h-12 rounded-full px-8 text-base"
                >
                  <Link href="#install">
                    <span>Install Talome</span>
                  </Link>
                </Button>
                <Button
                  asChild
                  size="lg"
                  variant="outline"
                  className="h-12 rounded-full border-border/30 px-8 text-base text-muted-foreground hover:text-foreground"
                >
                  <Link href="https://github.com/tomastruben/Talome">
                    <span>GitHub</span>
                  </Link>
                </Button>
              </div>
              <InstallCommand />
            </div>

            <div className="relative mx-auto mt-24 max-w-4xl lg:mt-28">
              <video
                autoPlay={!reduceMotion}
                muted
                loop={!reduceMotion}
                playsInline
                preload="metadata"
                poster="/hero-poster.jpg"
                className="w-full rounded-2xl border border-border/10 object-cover"
                style={{ aspectRatio: "1724/1080" }}
                aria-label="Talome product demo"
              >
                <source src="/hero.webm" type="video/webm" media="(min-width: 768px)" />
                <source src="/hero.mp4" type="video/mp4" media="(min-width: 768px)" />
                <source src="/hero-low.mp4" type="video/mp4" />
              </video>
            </div>

            {/* Scroll indicator */}
            <div className="mt-16 flex flex-col items-center gap-2">
              <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground/30">
                Scroll
              </span>
              <div className="h-8 w-px bg-gradient-to-b from-muted-foreground/30 to-transparent" />
            </div>
          </div>

          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-20"
            style={{
              background:
                "radial-gradient(ellipse 80% 50% at 50% 0%, oklch(0.22 0 0) 0%, oklch(0.145 0 0) 100%)",
            }}
          />

          <HelixBg className="absolute inset-0 -z-10 overflow-hidden" />

          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 -z-[5] h-40"
            style={{
              background:
                "linear-gradient(to bottom, transparent, oklch(0.145 0 0))",
            }}
          />
        </section>
      </main>
    </>
  );
}
