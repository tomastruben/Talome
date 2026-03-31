"use client";

import { useAtomValue } from "jotai";
import { usePathname } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { AnimatePresence, motion } from "framer-motion";
import { audioPlayerBookAtom, audioPlayerStateAtom } from "@/atoms/audio-player";
import { useAudioEngine } from "@/hooks/use-audio-engine";
import { useAudiobookPlayer } from "@/hooks/use-audiobook-player";
import {
  HugeiconsIcon,
  PlayIcon,
  PauseIcon,
  Cancel01Icon,
} from "@/components/icons";

/**
 * Layout-level component:
 * 1. Initializes the singleton audio engine (always)
 * 2. Renders a mobile-only mini-player bar (md:hidden)
 *    Desktop uses SidebarAudioPlayer instead.
 */
export function GlobalAudioPlayer() {
  useAudioEngine();

  const book = useAtomValue(audioPlayerBookAtom);
  const state = useAtomValue(audioPlayerStateAtom);
  const { togglePlay, stop } = useAudiobookPlayer();
  const pathname = usePathname();

  const isOnBookPage = book ? pathname === `/dashboard/audiobooks/${book.bookId}` : false;
  const show = book !== null && !isOnBookPage;

  const progressPct = book && book.totalDuration > 0
    ? (state.currentTime / book.totalDuration) * 100
    : 0;

  return (
    <AnimatePresence>
      {show && book && (
        <motion.div
          initial={{ y: 48, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 48, opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
          className="md:hidden relative h-12 border-t border-border bg-card/95 backdrop-blur-sm flex items-center shrink-0"
        >
          {/* Progress — top edge, full width */}
          <div className="absolute top-0 left-0 right-0 h-px bg-foreground/[0.06]">
            <div
              className="h-full bg-foreground/40 transition-[width] duration-1000 ease-linear"
              style={{ width: `${Math.min(100, progressPct)}%` }}
            />
          </div>

          {/* Cover — tappable, navigates to book */}
          <Link
            href={`/dashboard/audiobooks/${book.bookId}`}
            className="flex items-center gap-2.5 flex-1 min-w-0 pl-3 active:opacity-70 transition-opacity"
          >
            <div className="size-8 rounded-md bg-muted overflow-hidden shrink-0 relative">
              <Image src={book.coverUrl} alt={`${book.title} cover`} className="object-cover" fill />
            </div>
            <p className="text-xs font-medium truncate min-w-0">{book.title}</p>
          </Link>

          {/* Play/pause + close */}
          <div className="flex items-center shrink-0 mr-1">
            <button
              onClick={togglePlay}
              className="size-10 rounded-full flex items-center justify-center active:bg-foreground/[0.06] transition-colors"
              aria-label={state.isPlaying ? "Pause" : "Play"}
            >
              <HugeiconsIcon
                icon={state.isPlaying ? PauseIcon : PlayIcon}
                size={18}
                className="text-foreground"
              />
            </button>
            <button
              onClick={stop}
              className="size-10 rounded-full flex items-center justify-center active:bg-foreground/[0.06] transition-colors"
              aria-label="Close player"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={14} className="text-muted-foreground" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
