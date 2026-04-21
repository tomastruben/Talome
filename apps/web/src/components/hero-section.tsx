import Link from "next/link";
import { Button } from "@/components/ui/button";
import { HeroHeader } from "./header";
import { InstallCommand } from "./install-command";
import { HelixBg } from "./helix-bg";

export default function HeroSection() {
  return (
    <>
      <HeroHeader />
      <main className="overflow-x-hidden">
        <section className="relative">
          <div className="relative z-10 mx-auto max-w-7xl px-6 pb-24 pt-44 text-center lg:px-12 lg:pt-56 lg:pb-32">
            <div className="mb-8">
              <span className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-primary">Public Alpha</span>
            </div>

            <h1 className="gradient-heading mx-auto max-w-4xl text-balance text-5xl font-medium leading-[1.06] tracking-tight md:text-6xl lg:text-7xl">
              Install apps. Fix problems.
              <br />
              Improve its own code.
            </h1>

            <p className="mx-auto mt-8 max-w-2xl text-balance text-lg leading-relaxed text-muted-foreground">
              A reasoning system that lives on your machine. 219 tools,
              17 deep integrations, autonomous monitoring, and — we checked
              twice — the ability to rewrite its own source code.
              Your hardware. Your house. Still a bit of a weird sentence
              to type.
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
                autoPlay
                muted
                loop
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
