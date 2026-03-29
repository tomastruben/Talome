"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import {
  motion,
  useScroll,
  useTransform,
  useInView,
  AnimatePresence,
} from "motion/react";
import { HugeiconsIcon } from "@/components/icons";
import { PlayIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";

const features = [
  {
    label: "Intelligence",
    title: "It observes. It improves.",
    description:
      "Talome watches your services around the clock. It reads logs, spots anomalies, and surfaces improvement suggestions ranked by impact. Click one, and it delegates to Claude Code with full context \u2014 the right tools loaded via internal MCP servers, the exact files to touch, and a supervisor that validates each change compiles cleanly before saving. Fully autonomous or user-triggered. At 3\u202FAM when your media server runs out of memory, it detects, diagnoses, and resolves it before you wake up. Every change is logged and reversible.",
    videoSlug: "intelligence-dashboard",
    videoCaption:
      "Screen recording: open the Intelligence page, see a suggestion from Jellyfin log analysis, click to execute, watch Claude Code edit the code, compiler passes, change saved",
  },
  {
    label: "Bug hunt",
    title: "Point at it. It understands.",
    description:
      "Hit \u21e7\u2318X from anywhere. Talome captures your screen, your exact position in the app, viewport dimensions, every console error and failed network request \u2014 the full diagnostic context behind what you\u2019re seeing. Describe the problem in a sentence. AI augments your report into a structured diagnosis with steps to reproduce, root cause analysis, and a fix strategy. Execute immediately or queue it. Your bug report becomes a resolved issue in minutes.",
    videoSlug: "bug-hunt",
    videoCaption:
      "Screen recording: hit \u21e7\u2318X, see the screenshot with captured signals, type a description, AI generates a structured bug report, click execute, watch the fix happen in the terminal",
  },
  {
    label: "Conversation",
    title: "One conversation. Fully configured.",
    description:
      "\u2018Set up a media server.\u2019 Five apps installed. Downloads, media management, and search all wired together automatically. Health verified, URLs ready to go. A full orchestration engine with 230+ purpose-built tools. It remembers your preferences, your setup, your file paths. Ask once, and it remembers forever.",
    videoSlug: "conversational-intelligence",
    videoCaption:
      "Screen recording: type \u2018set up a media server with automatic downloads\u2019 in the chat, watch tools fire in sequence installing Jellyfin, Sonarr, Radarr, qBittorrent, wiring them together, and returning live URLs",
  },
  {
    label: "Media",
    title: "Your entire library. One place.",
    description:
      "Browse everything you\u2019re watching, downloading, and waiting for. Search across all your media apps at once. See upcoming releases on the calendar. Track watch progress from Plex and Jellyfin. Search for specific releases and pick your quality tier. Request movies and shows with a single tap. When Plex or Jellyfin isn\u2019t available, switch to cinema mode \u2014 a built-in player that streams directly from your files, right in the browser. Works perfectly on your TV in the living room.",
    videoSlug: "media-management",
    videoCaption:
      "Screen recording: open the Media page, browse wanted items, switch to the calendar showing upcoming releases, tap a movie to see its detail sheet with poster art and streaming link, then search for a specific release",
  },
  {
    label: "Files",
    title: "Every file. Right here.",
    description:
      "Navigate your server\u2019s file systems with a full-featured browser. Preview videos in cinema mode with a built-in player that handles MKV, MP4, and most formats with subtitle support. Listen to audio, view images, read code with syntax highlighting. Manage files across all your mounted drives. Create folders, rename, move, organize. Your AI assistant can work with files too. Say \u2018clean up my downloads folder\u2019 and watch it go.",
    videoSlug: "file-browser",
    videoCaption:
      "Screen recording: open the Files page, navigate into a media folder, click a video file to preview it inline with the built-in player, then browse an external drive showing images and code files with syntax highlighting",
  },
  {
    label: "Automations",
    title: "Workflows that think.",
    description:
      "Build automations that go beyond simple if-then rules. Set a trigger: a container crashes, disk usage hits a threshold, a new app gets installed, or a cron schedule fires. Then chain steps: send a notification, call a tool, or hand the situation to the AI and let it reason about what to do. Your server responds to events intelligently, even when you\u2019re away.",
    videoSlug: "automations",
    videoCaption:
      "Screen recording: open the Automations page, create a new automation with a \u2018container stopped\u2019 trigger, add an AI reasoning step, save it, then show it firing when a container is stopped",
  },
  {
    label: "Integrations",
    title: "Your entire stack, understood.",
    description:
      "Talome understands how your apps relate to each other: media libraries, network settings, backup systems, home automation, all of it. Ask \u2018why are my new files missing in Jellyfin?\u2019 and it checks storage paths, scans folders, inspects permissions, and tells you exactly what to fix. It thinks across everything you run.",
    videoSlug: "deep-integrations",
    videoCaption:
      "Screen recording: ask the assistant \u2018why are my downloads stuck?\u2019 and watch it check qBittorrent status, read Sonarr logs, inspect network connectivity, and pinpoint the issue across three apps",
  },
  {
    label: "App creation",
    title: "Describe an app. It builds it.",
    description:
      "Describe what you need in a sentence. AI generates a structured blueprint \u2014 Docker services, ports, volumes, environment variables, UI surfaces \u2014 then delegates to Claude Code with Talome\u2019s design system rules, component references, and source snapshots loaded into the workspace. It builds against the same primitives the dashboard uses, validates with TypeScript and design checks, and publishes to your personal app store. Installable with one click. Or open the persistent AI terminal: a full coding session that survives page refreshes, browser crashes, even reboots.",
    videoSlug: "app-creation",
    videoCaption:
      "Screen recording: type \u2018create a recipe manager app\u2019 in the assistant, watch the blueprint form fill out, then the terminal opens and builds the full application with a web UI, ending with a one-click install",
  },
  {
    label: "Everywhere",
    title: "Your server in your pocket.",
    description:
      "Fully responsive dashboard that works on any screen. Add Talome to your home screen on iOS or Android for an app-like experience. Open the terminal from your phone and you have a full coding session \u2014 persistent, resumable, right in your pocket. Or message your server directly through Telegram or Discord \u2014 install apps, check status, get alerts, and troubleshoot issues from the same apps you use every day. Your server becomes a contact in your messaging app.",
    videoSlug: "mobile-messaging",
    videoCaption:
      "Screen recording: open Talome on a phone, browse the dashboard, then switch to Telegram and send a message asking for server status \u2014 Talome replies with container health and disk usage",
  },
];

// Map videoSlug → actual video files (only for features that have videos ready)
const VIDEO_ASSETS: Record<string, { mp4: string; webm: string; low: string; poster: string; aspect: string }> = {
  "media-management": { mp4: "/media.mp4", webm: "/media.webm", low: "/media-low.mp4", poster: "/media-poster.jpg", aspect: "1728/1080" },
  "automations": { mp4: "/automations.mp4", webm: "/automations.webm", low: "/automations-low.mp4", poster: "/automations-poster.jpg", aspect: "1620/1080" },
  "file-browser": { mp4: "/files.mp4", webm: "/files.webm", low: "/files-low.mp4", poster: "/files-poster.jpg", aspect: "1724/1080" },
  "conversational-intelligence": { mp4: "/conversation.mp4", webm: "/conversation.webm", low: "/conversation-low.mp4", poster: "/conversation-poster.jpg", aspect: "1724/1080" },
  "deep-integrations": { mp4: "/integrations.mp4", webm: "/integrations.webm", low: "/integrations-low.mp4", poster: "/integrations-poster.jpg", aspect: "1724/1080" },
  "intelligence-dashboard": { mp4: "/intelligence.mp4", webm: "/intelligence.webm", low: "/intelligence-low.mp4", poster: "/intelligence-poster.jpg", aspect: "1724/1080" },
  "bug-hunt": { mp4: "/bughunt.mp4", webm: "/bughunt.webm", low: "/bughunt-low.mp4", poster: "/bughunt-poster.jpg", aspect: "1724/1080" },
  "app-creation": { mp4: "/appcreation.mp4", webm: "/appcreation.webm", low: "/appcreation-low.mp4", poster: "/appcreation-poster.jpg", aspect: "1724/1080" },
  "mobile-messaging": { mp4: "/mobile.mp4", webm: "/mobile.webm", low: "/mobile-low.mp4", poster: "/mobile-poster.jpg", aspect: "1440/1080" },
};

const EASE = [0.2, 0.8, 0.2, 1] as const;

/* ---------- Nav ---------- */

function FeatureNav({
  activeIndex,
  onSelect,
}: {
  activeIndex: number;
  onSelect: (i: number) => void;
}) {
  return (
    <nav className="relative hidden w-48 shrink-0 lg:flex lg:flex-col lg:justify-center">
      <ul className="relative space-y-0.5">
        {features.map((f, i) => (
          <li key={i}>
            <button
              onClick={() => onSelect(i)}
              className={cn(
                "group relative flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] transition-all duration-300",
                activeIndex === i
                  ? "text-foreground"
                  : "text-muted-foreground/45 hover:text-muted-foreground/70"
              )}
            >
              <span
                className={cn(
                  "relative z-10 size-1.5 shrink-0 rounded-full transition-all duration-300",
                  activeIndex === i ? "bg-primary" : "bg-white/15 group-hover:bg-white/25"
                )}
              />
              <span className="truncate leading-tight">{f.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* ---------- Stacked card ---------- */

function StackedCard({
  feature,
  index,
  total,
  scrollYProgress,
}: {
  feature: (typeof features)[number];
  index: number;
  total: number;
  scrollYProgress: ReturnType<typeof useScroll>["scrollYProgress"];
}) {
  const step = 1 / (total - 1);
  const slideFrom = Math.max(0, (index - 1) * step);
  const slideTo = index * step;
  const scaleFrom = index * step;
  const scaleTo = Math.min(1, (index + 1) * step);

  const yNum = useTransform(
    scrollYProgress,
    [slideFrom, slideTo],
    index === 0 ? [0, 0] : [100, 0]
  );
  const y = useTransform(yNum, (v: number) => `${v}%`);
  const scale = useTransform(
    scrollYProgress,
    [scaleFrom, scaleTo],
    index === total - 1 ? [1, 1] : [1, 0.93]
  );
  const brightness = useTransform(
    scrollYProgress,
    [scaleFrom, scaleTo],
    index === total - 1 ? [1, 1] : [1, 0.3]
  );
  const filter = useTransform(brightness, (v: number) => `brightness(${v})`);

  return (
    <motion.div
      style={{ y, scale, filter, zIndex: index }}
      className="absolute inset-0 overflow-hidden rounded-2xl"
    >
      <div className="feature-card flex h-full flex-col p-6 md:p-8">
        <div className="shrink-0">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary/70">
              {feature.label}
            </p>
            <span className="text-[11px] tabular-nums text-muted-foreground/25">
              {String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}
            </span>
          </div>
          <h3 className="mt-4 text-3xl font-medium leading-[1.1] tracking-tight text-foreground md:text-4xl lg:text-5xl">
            {feature.title}
          </h3>
          <p className="mt-4 max-w-2xl text-[15px] leading-[1.7] text-muted-foreground/90">
            {feature.description}
          </p>
        </div>
        {VIDEO_ASSETS[feature.videoSlug] ? (() => {
          const v = VIDEO_ASSETS[feature.videoSlug];
          return (
            <div className="mt-5 flex min-h-0 flex-1 items-center justify-center">
              <video
                autoPlay muted loop playsInline
                preload="metadata"
                poster={v.poster}
                className="max-h-full max-w-full rounded-xl"
              >
                <source src={v.webm} type="video/webm" media="(min-width: 768px)" />
                <source src={v.mp4} type="video/mp4" media="(min-width: 768px)" />
                <source src={v.low} type="video/mp4" />
              </video>
            </div>
          );
        })() : (
          <div className="relative mt-5 min-h-0 flex-1 overflow-hidden rounded-xl bg-white/[0.02]">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
              <div className="flex size-12 items-center justify-center rounded-full bg-white/[0.04]">
                <HugeiconsIcon icon={PlayIcon} size={20} className="ml-0.5 text-white/20" />
              </div>
              <p className="max-w-[18rem] text-center text-[11px] leading-relaxed text-muted-foreground/20">
                {feature.videoCaption}
              </p>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

/* ---------- Desktop ---------- */

function DesktopFeatures() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start start", "end end"],
  });

  useEffect(() => {
    const unsubscribe = scrollYProgress.on("change", (latest: number) => {
      if (!isFinite(latest)) return;
      const idx = Math.min(
        features.length - 1,
        Math.max(0, Math.round(latest * (features.length - 1)))
      );
      setActiveIndex((prev) => (prev !== idx ? idx : prev));
    });
    return () => unsubscribe();
  }, [scrollYProgress]);

  const scrollToFeature = useCallback((i: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const containerTop = window.scrollY + rect.top;
    const scrollableHeight = rect.height - window.innerHeight;
    const target =
      containerTop + (i / (features.length - 1)) * scrollableHeight;
    window.scrollTo({ top: target, behavior: "smooth" });
  }, []);

  return (
    <div
      ref={containerRef}
      className="hidden md:block"
      style={{ height: `${features.length * 50}vh` }}
    >
      <div className="sticky top-0 flex h-screen items-center">
        <div className="mx-auto flex w-full max-w-6xl items-start gap-16 px-6 lg:px-12">
          <FeatureNav activeIndex={activeIndex} onSelect={scrollToFeature} />
          <div
            className="relative min-w-0 flex-1 overflow-hidden rounded-2xl"
            style={{ height: "min(90vh, 900px)" }}
          >
            {features.map((feature, i) => (
              <StackedCard
                key={i}
                feature={feature}
                index={i}
                total={features.length}
                scrollYProgress={scrollYProgress}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Mobile accordion ---------- */

function MobileFeatureAccordion({
  feature,
  index,
  isOpen,
  onToggle,
}: {
  feature: (typeof features)[number];
  index: number;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 16 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, ease: EASE, delay: Math.min(index * 0.04, 0.25) }}
      className="feature-card overflow-hidden rounded-xl"
    >
      <button
        onClick={onToggle}
        className="w-full cursor-pointer p-5 text-left"
      >
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-primary/50">
            {feature.label}
          </p>
          <span className="text-[10px] tabular-nums text-muted-foreground/15">
            {String(index + 1).padStart(2, "0")}
          </span>
        </div>
        <h3
          className={cn(
            "mt-2 whitespace-pre-line text-lg font-medium leading-[1.15] tracking-tight transition-colors duration-300",
            isOpen ? "text-foreground" : "text-foreground/60"
          )}
        >
          {feature.title}
        </h3>
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="px-5 pb-5">
              <p className="text-[13px] leading-[1.7] text-muted-foreground">
                {feature.description}
              </p>
              {VIDEO_ASSETS[feature.videoSlug] ? (() => {
                const v = VIDEO_ASSETS[feature.videoSlug];
                return (
                  <div className="relative mt-5 overflow-hidden rounded-lg" style={{ aspectRatio: v.aspect }}>
                    <video
                      autoPlay muted loop playsInline
                      preload="metadata"
                      poster={v.poster}
                      className="absolute inset-0 w-full h-full object-cover"
                    >
                      <source src={v.low} type="video/mp4" />
                    </video>
                  </div>
                );
              })() : (
                <div className="relative mt-5 aspect-[16/9] overflow-hidden rounded-lg bg-white/[0.02]">
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="flex size-10 items-center justify-center rounded-full bg-white/[0.04]">
                      <HugeiconsIcon icon={PlayIcon} size={18} className="ml-0.5 text-white/20" />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function MobileFeatures() {
  const [openIndex, setOpenIndex] = useState(0);

  return (
    <div className="px-6 py-24 md:hidden">
      <div className="mx-auto max-w-lg space-y-2.5">
        {features.map((feature, i) => (
          <MobileFeatureAccordion
            key={i}
            feature={feature}
            index={i}
            isOpen={openIndex === i}
            onToggle={() => setOpenIndex(openIndex === i ? -1 : i)}
          />
        ))}
      </div>
    </div>
  );
}

/* ---------- Export ---------- */

export function FeatureExperience() {
  return (
    <div id="features">
      <DesktopFeatures />
      <MobileFeatures />
    </div>
  );
}
