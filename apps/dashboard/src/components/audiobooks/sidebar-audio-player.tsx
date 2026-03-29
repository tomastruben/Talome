"use client";

import { useAtomValue } from "jotai";
import { usePathname } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { AnimatePresence, motion } from "framer-motion";
import { audioPlayerBookAtom, audioPlayerStateAtom } from "@/atoms/audio-player";
import { useAudiobookPlayer } from "@/hooks/use-audiobook-player";
import {
  HugeiconsIcon,
  PlayIcon,
  PauseIcon,
  Cancel01Icon,
} from "@/components/icons";
import {
  SidebarMenuItem,
} from "@/components/ui/sidebar";

/**
 * Mini audio player in the sidebar footer.
 * Progress is shown as a thin line at the bottom of the cover art.
 */
export function SidebarAudioPlayer() {
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
        <SidebarMenuItem>
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
            className="overflow-hidden"
          >
            <div className="rounded-lg bg-foreground/[0.04] p-2 group-data-[collapsible=icon]:p-0">
              {/* Collapsed icon mode: cover with progress ring */}
              <div className="hidden group-data-[collapsible=icon]:flex items-center justify-center">
                <Link href={`/dashboard/audiobooks/${book.bookId}`} className="relative">
                  <div className="size-8 rounded-md bg-muted overflow-hidden relative">
                    <Image src={book.coverUrl} alt={`${book.title} cover`} className="object-cover" fill />
                    {/* Progress at bottom of cover */}
                    <div className="absolute bottom-0 left-0 right-0 h-px bg-foreground/[0.08]">
                      <div
                        className="h-full bg-foreground/50 transition-[width] duration-1000 ease-linear"
                        style={{ width: `${Math.min(100, progressPct)}%` }}
                      />
                    </div>
                  </div>
                </Link>
              </div>

              {/* Expanded mode */}
              <div className="flex items-center gap-2.5 group-data-[collapsible=icon]:hidden">
                {/* Cover with integrated progress */}
                <Link
                  href={`/dashboard/audiobooks/${book.bookId}`}
                  className="shrink-0 relative"
                >
                  <div className="size-9 rounded-md bg-muted overflow-hidden relative">
                    <Image src={book.coverUrl} alt={`${book.title} cover`} className="object-cover" fill />
                    {/* Progress line at bottom of cover */}
                    <div className="absolute bottom-0 left-0 right-0 h-px bg-foreground/[0.08]">
                      <div
                        className="h-full bg-foreground/50 transition-[width] duration-1000 ease-linear"
                        style={{ width: `${Math.min(100, progressPct)}%` }}
                      />
                    </div>
                  </div>
                </Link>

                <div className="flex-1 min-w-0">
                  <Link href={`/dashboard/audiobooks/${book.bookId}`} className="block hover:opacity-80 transition-opacity">
                    <p className="text-xs font-medium truncate leading-tight">{book.title}</p>
                    <p className="text-xs text-muted-foreground truncate leading-tight mt-0.5">{book.author}</p>
                  </Link>
                </div>

                <div className="flex items-center shrink-0">
                  <button
                    onClick={togglePlay}
                    className="size-7 rounded-full flex items-center justify-center hover:bg-foreground/[0.06] transition-colors"
                    aria-label={state.isPlaying ? "Pause" : "Play"}
                  >
                    <HugeiconsIcon
                      icon={state.isPlaying ? PauseIcon : PlayIcon}
                      size={14}
                      className="text-muted-foreground"
                    />
                  </button>
                  <button
                    onClick={stop}
                    className="size-7 rounded-full flex items-center justify-center hover:bg-foreground/[0.06] transition-colors text-dim-foreground hover:text-muted-foreground"
                    aria-label="Stop playback"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} size={12} />
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </SidebarMenuItem>
      )}
    </AnimatePresence>
  );
}
