"use client";

import { useEffect, useRef } from "react";
import { animate, motion, useReducedMotion, type AnimationPlaybackControls } from "motion/react";
import { DURATION, EASE_ENTER, TRAVEL, enter } from "@/lib/motion";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { LiveTranscriptEntry } from "@/lib/live-transcript";
import { cn } from "@/lib/utils";

export function VoiceTranscript({ entries }: { entries: LiveTranscriptEntry[] }) {
  const root = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const scrolling = useRef<AnimationPlaybackControls | null>(null);
  const programmatic = useRef(false);
  const reduceMotion = useReducedMotion();
  const stopFollowing = () => {
    scrolling.current?.stop();
    programmatic.current = false;
    following.current = false;
  };
  useEffect(() => {
    const viewport = root.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const follow = () => {
      if (!following.current) return;
      scrolling.current?.stop();
      const bottom = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      if (reduceMotion) {
        viewport.scrollTop = bottom;
        return;
      }
      programmatic.current = true;
      scrolling.current = animate(viewport.scrollTop, bottom, {
        duration: DURATION.base,
        ease: EASE_ENTER,
        onUpdate: (position) => { viewport.scrollTop = position; },
        onComplete: () => { programmatic.current = false; },
      });
    };
    follow();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(follow);
    if (viewport.firstElementChild) observer?.observe(viewport.firstElementChild);
    observer?.observe(viewport);
    return () => {
      observer?.disconnect();
      scrolling.current?.stop();
      programmatic.current = false;
    };
  }, [entries, reduceMotion]);

  return (
    <div ref={root} className="relative min-h-0 w-full max-w-2xl flex-1" data-window-no-drag>
      <ScrollArea className="voice-transcript-scroll h-full" onWheelCapture={stopFollowing} onPointerDownCapture={stopFollowing} onKeyDownCapture={(event) => {
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) stopFollowing();
      }} onScrollCapture={(event) => {
        const viewport = event.target as HTMLElement;
        if (programmatic.current || viewport.dataset.slot !== "scroll-area-viewport") return;
        following.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48;
      }}>
        <section aria-label="Conversation transcript" className="flex flex-col gap-6 p-6">
          {entries.length === 0 && <p className="text-center text-sm text-muted-foreground">Your conversation will appear here.</p>}
          {entries.map((entry) => (
            <motion.div key={entry.id}
              layout={reduceMotion ? false : "position"}
              initial={reduceMotion ? false : { opacity: 0, y: TRAVEL.rise }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduceMotion ? { duration: 0 } : enter(DURATION.base)}
              className={cn("flex max-w-full flex-col gap-2", entry.role === "user" ? "items-end self-end" : "items-start self-start")}>
              <span className="sr-only">{entry.role === "user" ? "You" : "Talome"}</span>
              <p className={cn("max-w-full whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-base leading-relaxed [overflow-wrap:anywhere]", entry.role === "user" ? "bg-muted/60 text-foreground" : "bg-card/60 text-card-foreground")}>
                {entry.text}
              </p>
            </motion.div>
          ))}
        </section>
      </ScrollArea>
    </div>
  );
}
