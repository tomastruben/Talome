"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useCinemaBrowser } from "./cinema-browser-context";
import { scheduleIdle } from "@/lib/idle";

// The cinema overlay pulls in the full video player (hls.js). Load it on
// first open; on media pages (the only place it can be opened from) the chunk
// is preloaded when idle so opening stays instant and the fullscreen request
// still happens within the click's user-activation window.
const loadCinemaBrowser = () => import("./cinema-browser");

const CinemaBrowserOverlay = dynamic(
  () => loadCinemaBrowser().then((m) => ({ default: m.CinemaBrowserOverlay })),
  { ssr: false },
);

export function CinemaBrowserLauncher() {
  const { isOpen } = useCinemaBrowser();
  const pathname = usePathname();
  const [overlayMounted, setOverlayMounted] = useState(false);

  // Mount on first open and keep mounted afterwards (render-phase adjustment).
  if (isOpen && !overlayMounted) {
    setOverlayMounted(true);
  }

  const onMediaPage = pathname?.startsWith("/dashboard/media") ?? false;
  useEffect(() => {
    if (!onMediaPage || overlayMounted) return;
    return scheduleIdle(() => {
      void loadCinemaBrowser().catch(() => {});
    }, 1_500);
  }, [onMediaPage, overlayMounted]);

  return overlayMounted ? <CinemaBrowserOverlay /> : null;
}
