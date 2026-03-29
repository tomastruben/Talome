"use client";

import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { useCinemaBrowser } from "./cinema-browser-context";
import {
  type MediaItem,
  type LibraryData,
  type SeasonData,
} from "./media-detail-sheet";
import { CORE_URL, getDirectCoreUrl, resolveBackdropUrl, resolvePosterUrl } from "@/lib/constants";
import { VideoPlayer } from "@/components/files/media-player";
import {
  HugeiconsIcon,
  PlayIcon,
  ArrowLeft02Icon,
  Cancel01Icon,
  StarIcon,
  Film01Icon,
  Tv01Icon,
  CheckmarkCircle01Icon,
  Search01Icon,
} from "@/components/icons";
import { cn } from "@/lib/utils";

// ── Helpers ──────────────────────────────────────────────────────────────────

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// TV remote Back button keyCodes (VIDAA/Android TV = 10009, HbbTV = 461)
const TV_BACK_KEYCODES = new Set([10009, 461]);

// Cinema rendering mode — "performance" strips GPU-expensive effects for TV/projector hardware
type CinemaRenderMode = "quality" | "performance";
const CINEMA_MODE_KEY = "talome-cinema-render-mode";
function getCinemaRenderMode(): CinemaRenderMode {
  if (typeof localStorage === "undefined") return "quality";
  return (localStorage.getItem(CINEMA_MODE_KEY) as CinemaRenderMode) ?? "quality";
}
function setCinemaRenderMode(mode: CinemaRenderMode) {
  if (typeof localStorage !== "undefined") localStorage.setItem(CINEMA_MODE_KEY, mode);
}

function formatRuntimeMinutes(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ── Edge-zone auto-scroll — returns a callback ref to attach to any scrollable container ──
// Scrolls automatically when cursor enters an edge zone.
// Shows subtle gradient + chevron indicators when cursor is in the zone.
// `axis` controls which edges respond: "x" = left/right, "y" = top/bottom.
function useEdgeScroll(
  axis: "x" | "y" = "y",
  edgeZone = 80,
  maxSpeed = 10,
): (node: HTMLElement | null) => void {
  const cleanupRef = useRef<(() => void) | null>(null);

  return useCallback((node: HTMLElement | null) => {
    // Detach from previous node
    if (cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null; }
    if (!node) return;

    // Ensure relative positioning for the indicators
    const computed = getComputedStyle(node);
    if (computed.position === "static") node.style.position = "relative";

    // Create scroll trigger indicators using position:sticky so they stay
    // visible at the edges of the scroll viewport, not scrolling with content.
    const createIndicator = (edge: "start" | "end"): HTMLDivElement => {
      const el = document.createElement("div");
      const isStart = edge === "start";
      const base = `
        position:sticky; z-index:5; pointer-events:none; opacity:0;
        transition:opacity 150ms ease-out;
        display:flex; align-items:center; justify-content:center;
        flex-shrink:0;
      `;
      if (axis === "y") {
        // For vertical: full-width bars stuck to top/bottom
        // Use negative margins so they don't take up layout space
        el.style.cssText = base + `
          left:0; right:0; width:100%; height:${edgeZone}px;
          margin-bottom:${isStart ? `-${edgeZone}px` : "0"};
          margin-top:${!isStart ? `-${edgeZone}px` : "0"};
          ${isStart ? "top:0" : "bottom:0"};
          background:linear-gradient(${isStart ? "to bottom" : "to top"}, rgba(0,0,0,0.3), transparent);
        `;
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "20");
        svg.setAttribute("height", "20");
        svg.setAttribute("viewBox", "0 0 20 20");
        svg.setAttribute("fill", "none");
        svg.style.opacity = "0.5";
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", isStart ? "M5 13l5-5 5 5" : "M5 7l5 5 5-5");
        path.setAttribute("stroke", "white");
        path.setAttribute("stroke-width", "1.5");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        svg.appendChild(path);
        el.appendChild(svg);
      } else {
        // For horizontal: tall bars stuck to left/right
        el.style.cssText = base + `
          top:0; height:100%; width:${edgeZone}px;
          margin-right:${isStart ? `-${edgeZone}px` : "0"};
          margin-left:${!isStart ? `-${edgeZone}px` : "0"};
          ${isStart ? "left:0" : "right:0"};
          background:linear-gradient(${isStart ? "to right" : "to left"}, rgba(0,0,0,0.3), transparent);
        `;
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "20");
        svg.setAttribute("height", "20");
        svg.setAttribute("viewBox", "0 0 20 20");
        svg.setAttribute("fill", "none");
        svg.style.opacity = "0.5";
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", isStart ? "M13 5l-5 5 5 5" : "M7 5l5 5-5 5");
        path.setAttribute("stroke", "white");
        path.setAttribute("stroke-width", "1.5");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        svg.appendChild(path);
        el.appendChild(svg);
      }
      return el;
    };

    const startIndicator = createIndicator("start");
    const endIndicator = createIndicator("end");
    // Prepend start indicator, append end indicator
    node.prepend(startIndicator);
    node.appendChild(endIndicator);

    let rafId = 0;
    let scrollDir = 0;
    let scrollSpeed = 0;

    const tick = () => {
      if (scrollDir !== 0) {
        if (axis === "y") node.scrollTop += scrollDir * scrollSpeed;
        else node.scrollLeft += scrollDir * scrollSpeed;
        rafId = requestAnimationFrame(tick);
      }
    };

    const onMove = (e: MouseEvent) => {
      const rect = node.getBoundingClientRect();
      const pos = axis === "y" ? e.clientY - rect.top : e.clientX - rect.left;
      const size = axis === "y" ? rect.height : rect.width;
      const scrollPos = axis === "y" ? node.scrollTop : node.scrollLeft;
      const scrollMax = axis === "y"
        ? node.scrollHeight - rect.height
        : node.scrollWidth - rect.width;

      if (pos < edgeZone && scrollPos > 0) {
        scrollDir = -1;
        scrollSpeed = maxSpeed * (1 - pos / edgeZone);
        startIndicator.style.opacity = String(Math.min(1, scrollSpeed / maxSpeed * 1.5));
        endIndicator.style.opacity = "0";
        if (!rafId) rafId = requestAnimationFrame(tick);
      } else if (pos > size - edgeZone && scrollPos < scrollMax) {
        scrollDir = 1;
        scrollSpeed = maxSpeed * (1 - (size - pos) / edgeZone);
        endIndicator.style.opacity = String(Math.min(1, scrollSpeed / maxSpeed * 1.5));
        startIndicator.style.opacity = "0";
        if (!rafId) rafId = requestAnimationFrame(tick);
      } else {
        scrollDir = 0;
        startIndicator.style.opacity = "0";
        endIndicator.style.opacity = "0";
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      }
    };

    const onLeave = () => {
      scrollDir = 0;
      startIndicator.style.opacity = "0";
      endIndicator.style.opacity = "0";
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    };

    node.addEventListener("mousemove", onMove, { passive: true });
    node.addEventListener("mouseleave", onLeave);

    cleanupRef.current = () => {
      node.removeEventListener("mousemove", onMove);
      node.removeEventListener("mouseleave", onLeave);
      if (rafId) cancelAnimationFrame(rafId);
      startIndicator.remove();
      endIndicator.remove();
    };
  }, [axis, edgeZone, maxSpeed]);
}

// ── Detail view — shown when an item is selected ─────────────────────────────

function CinemaDetail({
  item,
  onBack,
  onPlay,
  onSelectItem,
  onFilterByGenre,
  cinemaContainerRef,
  lite,
}: {
  item: MediaItem;
  onBack: () => void;
  onPlay: (item: MediaItem) => void;
  lite: boolean;
  onSelectItem: (item: MediaItem) => void;
  onFilterByGenre: (genre: string) => void;
  cinemaContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const backdrop = resolveBackdropUrl(item.backdrop, lite ? 780 : 1280);
  const poster = resolvePosterUrl(item.poster, lite ? 240 : 400);

  // Related items
  const { data: relatedData } = useSWR<{ results: MediaItem[] }>(
    `${CORE_URL}/api/media/related?type=${item.type}&id=${item.id}&limit=10`,
    fetcher,
  );
  const related = relatedData?.results ?? [];

  // Episodes for TV shows
  const { data: episodesResponse } = useSWR<{ seriesId: number; seasons: SeasonData[] }>(
    item.type === "tv" ? `${CORE_URL}/api/media/episodes?seriesId=${item.id}` : null,
    fetcher,
  );
  const seasonsData = episodesResponse?.seasons;
  const [selectedSeason, setSelectedSeason] = useState(1);
  const [playingEpisodeId, setPlayingEpisodeId] = useState<number | null>(null);
  const [playingPath, setPlayingPath] = useState<string | null>(null);
  const episodesRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const apiBase = getDirectCoreUrl() + "/api/media";

  // Quality selector state
  const [selectedQuality, setSelectedQuality] = useState<string>("original");
  const [qualityOptions, setQualityOptions] = useState<Array<{ label: string; height: number; bitrate: number }>>([]);
  const [hasDirectPlay, setHasDirectPlay] = useState(false);

  // Fetch quality options from Jellyfin
  useEffect(() => {
    if (item.type !== "movie" || !item.filePath) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/jellyfin-playback`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: item.filePath }),
        });
        if (!res.ok || cancelled) return;
        const jf = await res.json();
        if (cancelled) return;
        if (jf.available) {
          setQualityOptions(jf.transcodeQualities ?? []);
          setHasDirectPlay(!!jf.directPlayUrl);
        }
      } catch { /* non-critical */ }
    })();
    return () => { cancelled = true; };
  }, [item.filePath, item.type, apiBase]);

  // Cycle through quality options
  const cycleQuality = useCallback(() => {
    const options = ["original", ...qualityOptions.map((q) => q.label), "local"];
    const idx = options.indexOf(selectedQuality);
    setSelectedQuality(options[(idx + 1) % options.length]);
  }, [selectedQuality, qualityOptions]);

  // Edge-zone auto-scrolling callback refs for pointer/cursor navigation
  const detailEdgeRef = useEdgeScroll("y", 100, 12);
  const relatedEdgeRef = useEdgeScroll("x", 80, 10);
  const seasonEdgeRef = useEdgeScroll("x", 60, 8);

  // Start playback — just set the path, the player renders as an overlay within the
  // already-fullscreen cinema container. No separate fullscreen transition needed.
  const stopPlayback = useCallback(() => {
    setPlayingPath(null);
    setActionIndex(-1);
    requestAnimationFrame(() => detailRef.current?.focus());
  }, []);

  const startPlayback = useCallback((path: string) => {
    setPlayingPath(path);
  }, []);

  // Navigable actions: 0=Back, 1=Play/Episodes, 2+=episode rows
  const actionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [actionIndex, setActionIndex] = useState(-1); // -1 = none focused, ArrowDown enters
  const registerAction = useCallback((el: HTMLButtonElement | null, idx: number) => {
    actionRefs.current[idx] = el;
  }, []);
  // Reset when item changes
  useEffect(() => {
    actionRefs.current = [];
    setActionIndex(-1);
  }, [item.id]);

  const handleDetailKey = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "VIDEO") return;

    // TV remote Back button
    if (TV_BACK_KEYCODES.has(e.keyCode)) {
      e.preventDefault();
      e.stopPropagation();
      if (playingPath) {
        setPlayingPath(null);
        setActionIndex(-1);
        requestAnimationFrame(() => detailRef.current?.focus());
      } else {
        onBack();
      }
      return;
    }

    const scrollBehavior = lite ? "instant" as const : "smooth" as const;
    switch (e.key) {
      case "Escape":
      case "Backspace":
        e.preventDefault();
        e.stopPropagation();
        if (playingPath) {
          setPlayingPath(null);
          setActionIndex(-1);
          requestAnimationFrame(() => detailRef.current?.focus());
        } else {
          onBack();
        }
        break;
      case "ArrowDown":
      case "s": {
        e.preventDefault();
        e.stopPropagation();
        const count = actionRefs.current.filter(Boolean).length;
        if (count > 0) {
          const next = Math.min(actionIndex + 1, count - 1);
          setActionIndex(next);
          actionRefs.current[next]?.scrollIntoView({ block: "nearest", behavior: scrollBehavior });
        }
        break;
      }
      case "ArrowUp":
      case "w": {
        e.preventDefault();
        e.stopPropagation();
        if (actionIndex > 0) {
          const next = actionIndex - 1;
          setActionIndex(next);
          actionRefs.current[next]?.scrollIntoView({ block: "nearest", behavior: scrollBehavior });
        } else {
          setActionIndex(-1);
          detailRef.current?.scrollTo({ top: 0, behavior: scrollBehavior });
        }
        break;
      }
      case "ArrowRight":
      case "d": {
        e.preventDefault();
        e.stopPropagation();
        const count = actionRefs.current.filter(Boolean).length;
        if (count > 0) {
          const next = Math.min(actionIndex + 1, count - 1);
          setActionIndex(next);
          actionRefs.current[next]?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: scrollBehavior });
        }
        break;
      }
      case "ArrowLeft":
      case "a": {
        e.preventDefault();
        e.stopPropagation();
        if (actionIndex > 0) {
          const next = actionIndex - 1;
          setActionIndex(next);
          actionRefs.current[next]?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: scrollBehavior });
        } else if (actionIndex === 0) {
          // Already at back button — trigger it
          onBack();
        }
        break;
      }
      case "Enter":
      case " ":
        e.preventDefault();
        e.stopPropagation();
        if (actionIndex >= 0 && actionRefs.current[actionIndex]) {
          actionRefs.current[actionIndex].click();
        }
        break;
    }
  }, [item, onBack, actionIndex, playingPath, lite]);

  // Edge-zone auto-scrolling attached via callback refs above (detailEdgeRef, relatedEdgeRef, seasonEdgeRef)

  // Auto-focus on mount + after fullscreen transitions
  useEffect(() => {
    const el = detailRef.current;
    if (!el) return;
    el.focus();
    // Retry after short delays (fullscreen transitions steal focus)
    const timers = [50, 150, 300, 500].map(ms =>
      setTimeout(() => {
        if (document.activeElement !== el) {
          el.focus();
        }
      }, ms)
    );
    const refocus = () => {
      setTimeout(() => el.focus(), 50);
    };
    document.addEventListener("fullscreenchange", refocus);
    return () => {
      timers.forEach(clearTimeout);
      document.removeEventListener("fullscreenchange", refocus);
    };
  }, []);

  return (
    <div
      ref={(el) => { detailRef.current = el; detailEdgeRef(el); }}
      className="dark absolute inset-0 z-20 bg-background overflow-y-auto scrollbar-none outline-none"
      tabIndex={0}
      onKeyDown={handleDetailKey}
      onMouseDown={() => detailRef.current?.focus()}
    >
      {/* Player — fixed overlay so it covers the viewport even when detail is scrolled down.
           Using fixed instead of absolute prevents the player from being positioned at scrollTop=0
           when the user has scrolled to episodes further down the page. */}
      {playingPath && (
        <div className="fixed inset-0 z-30 bg-black">
          <VideoPlayer
            src={`${apiBase}/stream?path=${encodeURIComponent(playingPath)}`}
            fileName={playingPath.split("/").pop() ?? "video"}
            filePath={playingPath}
            apiBase={apiBase}
            cinemaMode
            onBack={stopPlayback}
            onEnded={stopPlayback}
            preferOriginal={selectedQuality === "original"}
          />
        </div>
      )}

      {/* Full-bleed cover background — fixed behind scrollable content */}
      <div className="sticky top-0 w-full h-0 z-0">
        <div className="absolute inset-x-0 top-0 h-screen">
          {backdrop ? (
            <Image src={backdrop} alt="" fill className={cn("object-cover", lite ? "opacity-40" : "opacity-50")} sizes="100vw" priority />
          ) : poster ? (
            <Image src={poster} alt="" fill className={cn("object-cover", lite ? "opacity-15" : "opacity-25 blur-3xl scale-125 saturate-150")} sizes="100vw" />
          ) : null}
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/70 to-background/30" />
          <div className="absolute inset-0 bg-gradient-to-r from-background/60 via-transparent to-transparent" />
        </div>
      </div>

      {/* Back button — sticky so it stays visible while scrolling detail view */}
      <div className="sticky top-0 z-20 h-0">
        <button
          ref={(el) => registerAction(el, 0)}
          className={cn(
            "absolute top-6 left-10 flex items-center gap-2.5 px-6 py-3 rounded-lg text-white/70 hover:text-white hover:bg-white/20 text-lg font-medium",
            lite ? "bg-black/50" : "bg-white/8 backdrop-blur-md transition-all",
            actionIndex === 0 && "ring-2 ring-white/80",
          )}
          onClick={onBack}
        >
          <HugeiconsIcon icon={ArrowLeft02Icon} size={20} />
          Back
        </button>
      </div>

      {/* Title + metadata — normal flow, pulled up over the cover with negative margin */}
      <div className={cn("relative z-10 px-8 sm:px-12 flex gap-6 sm:gap-8", lite ? "mt-[25vh] pt-8" : "mt-[35vh] pt-12")}>
          {poster && !lite && (
            <div className="shrink-0 relative w-[180px] sm:w-[220px] aspect-[2/3] rounded-lg overflow-hidden ring-1 ring-white/15 hidden lg:block">
              <Image src={poster} alt={item.title} fill className="object-cover" sizes="220px" />
            </div>
          )}

          <div className="flex-1 min-w-0 pb-1">
            <h1 className="text-3xl sm:text-5xl lg:text-6xl font-medium text-white leading-tight mb-2 sm:mb-4 line-clamp-1">
              {item.title}
            </h1>

            <div className="flex items-center gap-3 sm:gap-4 mb-2 sm:mb-4 flex-wrap">
              {item.rating != null && item.rating > 0 && (
                <span className="flex items-center gap-1 sm:gap-1.5 text-base sm:text-xl text-amber-400">
                  <HugeiconsIcon icon={StarIcon} size={18} />
                  {item.rating.toFixed(1)}
                </span>
              )}
              {item.year && <span className="text-base sm:text-xl text-white/70">{item.year}</span>}
              {item.runtime && <span className="text-base sm:text-xl text-white/60">{formatRuntimeMinutes(item.runtime)}</span>}
              {(item.studio || item.network) && <span className="text-base sm:text-xl text-white/50 hidden sm:inline">{item.studio || item.network}</span>}
              {item.type === "tv" && item.seasonCount && (
                <span className="text-base sm:text-xl text-white/50">{item.seasonCount} season{item.seasonCount !== 1 ? "s" : ""}</span>
              )}
            </div>

            {item.genres && item.genres.length > 0 && (
              <div className="hidden sm:flex gap-2.5 mb-5">
                {item.genres.slice(0, 4).map((g, gIdx) => {
                  const gActionIdx = 2 + gIdx;
                  return (
                    <button
                      key={g}
                      ref={(el) => registerAction(el, gActionIdx)}
                      onClick={() => onFilterByGenre(g)}
                      className={cn(
                        "text-base px-4 py-1.5 rounded-full border transition-colors",
                        actionIndex === gActionIdx
                          ? "border-white/60 text-white bg-white/10"
                          : "border-white/20 text-white/60 hover:text-white hover:border-white/40 hover:bg-white/8",
                      )}
                    >
                      {g}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-3">
              {item.type === "movie" && item.hasFile && item.filePath && (
                <div className="flex items-center gap-3">
                  <button
                    ref={(el) => registerAction(el, 1)}
                    className={cn(
                      "inline-flex items-center gap-2 sm:gap-2.5 h-12 sm:h-16 px-8 sm:px-12 rounded-lg bg-white text-black font-medium text-lg sm:text-xl hover:bg-white/90",
                      !lite && "hover:scale-105 transition-all",
                      actionIndex === 1 && cn("ring-2 ring-white/80 ring-offset-2 ring-offset-background", !lite && "scale-105"),
                    )}
                    onClick={() => startPlayback(item.filePath!)}
                  >
                    <HugeiconsIcon icon={PlayIcon} size={22} />
                    Play
                  </button>
                  {(qualityOptions.length > 0 || hasDirectPlay) && (
                    <button
                      onClick={cycleQuality}
                      className={cn(
                        "h-12 sm:h-16 px-5 rounded-lg text-base font-medium",
                        !lite && "transition-all",
                        "bg-white/10 text-white/70 hover:bg-white/20 hover:text-white",
                      )}
                    >
                      {selectedQuality === "original" ? "Original" : selectedQuality === "local" ? "Local" : selectedQuality}
                    </button>
                  )}
                </div>
              )}
              {item.type === "tv" && (
                <button
                  ref={(el) => registerAction(el, 1)}
                  className={cn(
                    "inline-flex items-center gap-2 sm:gap-2.5 h-12 sm:h-16 px-8 sm:px-12 rounded-lg bg-white text-black font-medium text-lg sm:text-xl hover:bg-white/90",
                    !lite && "hover:scale-105 transition-all",
                    actionIndex === 1 && cn("ring-2 ring-white/80 ring-offset-2 ring-offset-background", !lite && "scale-105"),
                  )}
                  onClick={() => episodesRef.current?.scrollIntoView({ behavior: lite ? "instant" : "smooth", block: "start" })}
                >
                  <HugeiconsIcon icon={PlayIcon} size={24} />
                  Episodes
                </button>
              )}
            </div>
          </div>
      </div>

      {/* Below-the-fold content */}
      <div className="relative z-10 px-12 py-8 space-y-8">
        {item.overview && (
          <p className="text-lg text-white/70 leading-relaxed max-w-[900px]">{item.overview}</p>
        )}

        {/* Episodes for TV */}
        {item.type === "tv" && seasonsData && seasonsData.length > 0 && (
          <div ref={episodesRef} className="space-y-5">
            <div className="flex items-center gap-3">
              <h3 className="text-xl font-medium text-foreground">Episodes</h3>
              {seasonsData.length > 1 && (
                <div ref={seasonEdgeRef} className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
                  {seasonsData.map((s) => (
                    <button
                      key={s.seasonNumber}
                      type="button"
                      onClick={() => setSelectedSeason(s.seasonNumber)}
                      className={cn(
                        "shrink-0 px-5 py-2.5 rounded-lg text-lg font-medium",
                        !lite && "transition-all",
                        s.seasonNumber === selectedSeason
                          ? "bg-white/15 text-foreground"
                          : "text-muted-foreground hover:text-foreground hover:bg-white/10",
                      )}
                    >
                      Season {s.seasonNumber}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {(() => {
              const currentSeason = seasonsData.find((s) => s.seasonNumber === selectedSeason);
              if (!currentSeason) return null;
              return (
                <div className="flex flex-col max-h-[50vh] overflow-y-auto scrollbar-none">
                  {currentSeason.episodes.map((ep, epIdx) => {
                    const isPlaying = ep.id === playingEpisodeId;
                    const isAvailable = ep.hasFile && !!ep.filePath;
                    const genreCount = Math.min(item.genres?.length ?? 0, 4);
                    const aIdx = 2 + genreCount + epIdx; // action index: 0=back, 1=play, 2..genres, genres+2..episodes
                    return (
                      <button
                        key={ep.id}
                        ref={(el) => registerAction(el, aIdx)}
                        type="button"
                        disabled={!isAvailable}
                        onClick={() => {
                          if (!isAvailable || !ep.filePath) return;
                          setPlayingEpisodeId(ep.id);
                          startPlayback(ep.filePath);
                        }}
                        className={cn(
                          "flex items-center gap-5 px-5 py-4 text-left group rounded-lg",
                          !lite && "transition-all",
                          isPlaying && "bg-white/10",
                          isAvailable && !isPlaying && "hover:bg-white/8",
                          !isAvailable && "opacity-30 cursor-default",
                          actionIndex === aIdx && "ring-2 ring-white/60 bg-white/5",
                        )}
                      >
                        <span className="text-lg text-muted-foreground tabular-nums w-8 shrink-0 text-right font-medium">
                          {ep.episodeNumber}
                        </span>
                        <div className="flex-1 min-w-0">
                          <span className={cn(
                            "text-lg truncate block",
                            isPlaying ? "font-medium text-foreground" : "text-muted-foreground",
                          )}>
                            {ep.title || `Episode ${ep.episodeNumber}`}
                          </span>
                          {ep.airDateUtc && (
                            <span className="text-base text-muted-foreground">
                              {new Date(ep.airDateUtc).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                            </span>
                          )}
                        </div>
                        {ep.quality && <span className="text-base text-muted-foreground shrink-0">{ep.quality}</span>}
                        {ep.runtime && <span className="text-base text-muted-foreground tabular-nums shrink-0">{ep.runtime}</span>}
                        {isAvailable && (
                          <span className={cn("shrink-0", !lite && "transition-opacity", isPlaying ? "opacity-100" : "opacity-0 group-hover:opacity-70")}>
                            <HugeiconsIcon icon={PlayIcon} size={18} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        )}

        {/* File info */}
        {item.quality && (
          <div className="flex items-center gap-3 text-base text-white/40">
            {item.quality.name && <span>{item.quality.name}</span>}
            {item.quality.codec && <><span className="text-white/15">·</span><span>{item.quality.codec}</span></>}
            {item.quality.audioCodec && <><span className="text-white/15">·</span><span>{item.quality.audioCodec}</span></>}
            {item.quality.container && (
              <><span className="text-white/15">·</span>
              <span className="uppercase text-sm font-medium px-2 py-0.5 rounded bg-white/8">{item.quality.container}</span></>
            )}
            {(item.sizeOnDisk ?? 0) > 0 && (
              <><span className="text-white/15">·</span><span>{((item.sizeOnDisk ?? 0) / 1073741824).toFixed(1)} GB</span></>
            )}
          </div>
        )}

        {/* Related content */}
        {related.length > 0 && (
          <div>
            <h3 className="text-xl font-medium text-white/60 mb-4">More like this</h3>
            <div ref={relatedEdgeRef} className="flex gap-4 overflow-x-auto scrollbar-none py-2 -my-2">
              {related.map((r, rIdx) => {
                const rPoster = resolvePosterUrl(r.poster, 120);
                // Action index: 0=back, 1=play, 2..genres, genres+2..episodes, episodes+genres+2..related
                const genreCount = Math.min(item.genres?.length ?? 0, 4);
                const currentSeason = seasonsData?.find((s) => s.seasonNumber === selectedSeason);
                const epCount = currentSeason?.episodes.length ?? 0;
                const rActionIdx = 2 + genreCount + epCount + rIdx;
                return (
                  <button
                    key={`${r.type}-${r.id}`}
                    ref={(el) => registerAction(el, rActionIdx)}
                    type="button"
                    className={cn(
                      "shrink-0 w-[150px] text-left group rounded-xl",
                      !lite && "transition-all duration-200",
                      actionIndex === rActionIdx
                        ? cn("z-10", !lite ? "scale-110 ring-2 ring-white/70" : "ring-2 ring-white ring-offset-2 ring-offset-background")
                        : cn(!lite && "hover:scale-105"),
                    )}
                    onClick={() => onSelectItem(r)}
                  >
                    <div className="relative aspect-[2/3] rounded-xl overflow-hidden bg-muted/30 mb-2">
                      {rPoster ? (
                        <Image src={rPoster} alt={r.title} fill
                          className={cn("object-cover",
                            !lite && "transition-all duration-200",
                            actionIndex === rActionIdx ? "brightness-110 saturate-110" : "brightness-90 group-hover:brightness-105")}
                          sizes="150px" />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <HugeiconsIcon icon={r.type === "tv" ? Tv01Icon : Film01Icon} size={24} className="text-white/20" />
                        </div>
                      )}
                    </div>
                    <p className={cn("text-base font-medium truncate", actionIndex === rActionIdx ? "text-white" : "text-white/90 group-hover:text-white")}>{r.title}</p>
                    <p className={cn("text-sm", actionIndex === rActionIdx ? "text-white/60" : "text-white/40")}>{r.year}{r.rating ? ` · ${r.rating.toFixed(1)}` : ""}</p>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main cinema browser overlay ──────────────────────────────────────────────

interface PlexWatchStatusData {
  configured: boolean;
  watchStatus: Record<string, "watched" | "in-progress">;
}

interface PlexContinueItem {
  ratingKey?: string;
  title?: string;
  episodeTitle?: string;
  type: "movie" | "tv";
  year?: number;
  thumb?: string;
  viewOffset?: number;
  duration?: number;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
}

interface PlexWatchingData {
  configured: boolean;
  continueWatching?: PlexContinueItem[];
  recentlyWatched?: PlexContinueItem[];
}

type CinemaFilter = "all" | "unwatched" | "watched" | "in-progress" | string;

export function CinemaBrowserOverlay() {
  const { isOpen, tab, close } = useCinemaBrowser();
  const router = useRouter();

  const { data: library } = useSWR<LibraryData>(
    isOpen ? `${CORE_URL}/api/media/library` : null,
    fetcher,
  );
  const { data: plexWatchStatus } = useSWR<PlexWatchStatusData>(
    isOpen ? `${CORE_URL}/api/media/plex/watch-status` : null,
    fetcher,
  );
  const { data: plexWatchingData } = useSWR<PlexWatchingData>(
    isOpen ? `${CORE_URL}/api/media/plex/watching` : null,
    fetcher,
  );

  // Map titles to progress for poster overlays
  const progressByTitle = useMemo(() => {
    const map = new Map<string, { viewOffset: number; duration: number }>();
    for (const item of plexWatchingData?.continueWatching ?? []) {
      if (item.viewOffset && item.duration && item.title) {
        map.set(item.title.toLowerCase(), { viewOffset: item.viewOffset, duration: item.duration });
      }
    }
    return map;
  }, [plexWatchingData]);

  const movies = useMemo(() => library?.movies ?? [], [library]);
  const tvShows = useMemo(() => library?.tv ?? [], [library]);

  // State
  const [activeTab, setActiveTab] = useState<"movies" | "tv">("movies");
  const [activeFilter, setActiveFilter] = useState<CinemaFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Navigation zones: "tabs" | "filters" | "grid"
  type FocusZone = "tabs" | "filters" | "grid";
  const [focusZone, setFocusZone] = useState<FocusZone>("grid");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [filterFocusIndex, setFilterFocusIndex] = useState(0);
  const [tabFocusIndex, setTabFocusIndex] = useState(0);
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const filterRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const filterRowRef = useRef<HTMLDivElement>(null);
  // Track whether user is actively using keyboard — suppress mouse hover updates during keyboard nav
  const usingKeyboard = useRef(false);
  const keyboardTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Hide keyboard hints after first interaction
  const [showHints, setShowHints] = useState(true);
  const [renderMode] = useState<CinemaRenderMode>(() => getCinemaRenderMode());
  const lite = renderMode === "performance"; // shorthand for conditional classes

  const getColumnCount = useCallback(() => {
    if (!gridRef.current) return 6;
    const cols = getComputedStyle(gridRef.current).gridTemplateColumns.split(" ").length;
    return cols || 6;
  }, []);

  // Available tabs
  const availableTabs = useMemo(() => {
    const tabs: ("movies" | "tv")[] = [];
    if (movies.length > 0) tabs.push("movies");
    if (tvShows.length > 0) tabs.push("tv");
    return tabs;
  }, [movies.length, tvShows.length]);

  // Genres with counts
  const genresWithCounts = useMemo(() => {
    const items = activeTab === "movies" ? movies : tvShows;
    const counts = new Map<string, number>();
    for (const item of items) for (const g of item.genres ?? []) counts.set(g, (counts.get(g) ?? 0) + 1);
    return Array.from(counts.entries()).filter(([, c]) => c > 0).sort(([a], [b]) => a.localeCompare(b));
  }, [activeTab, movies, tvShows]);

  // Watch status
  const getWatchStatus = useCallback(
    (item: MediaItem): "watched" | "in-progress" | undefined => {
      if (!plexWatchStatus?.watchStatus) return undefined;
      const key = item.tmdbId ? `tmdb:${item.tmdbId}` : item.tvdbId ? `tvdb:${item.tvdbId}` : undefined;
      return key ? plexWatchStatus.watchStatus[key] : undefined;
    },
    [plexWatchStatus],
  );

  const watchCounts = useMemo(() => {
    if (!plexWatchStatus?.watchStatus) return { watched: 0, inProgress: 0, unwatched: 0 };
    const items = activeTab === "movies" ? movies : tvShows;
    let watched = 0, inProgress = 0, unwatched = 0;
    for (const item of items) {
      const key = item.tmdbId ? `tmdb:${item.tmdbId}` : item.tvdbId ? `tvdb:${item.tvdbId}` : undefined;
      const status = key ? plexWatchStatus.watchStatus[key] : undefined;
      if (status === "watched") watched++; else if (status === "in-progress") inProgress++; else unwatched++;
    }
    return { watched, inProgress, unwatched };
  }, [activeTab, movies, tvShows, plexWatchStatus]);

  // Available filter list
  const availableFilters = useMemo(() => {
    const filters: CinemaFilter[] = ["all"];
    if (watchCounts.inProgress > 0) filters.push("in-progress");
    if (watchCounts.unwatched > 0 && watchCounts.watched > 0) filters.push("unwatched");
    if (watchCounts.watched > 0) filters.push("watched");
    for (const [g] of genresWithCounts) filters.push(g);
    return filters;
  }, [watchCounts, genresWithCounts]);

  // Filtered + sorted items
  const sortedItems = useMemo(() => {
    const items = activeTab === "movies" ? movies : tvShows;
    // Cinema mode only shows available content — hide missing/undownloaded items
    let filtered = items.filter((i) =>
      i.type === "movie" ? i.hasFile : (i.sizeOnDisk ?? 0) > 0,
    );
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter((i) =>
        i.title.toLowerCase().includes(q) ||
        (i.genres ?? []).some((g) => g.toLowerCase().includes(q)) ||
        (i.studio ?? "").toLowerCase().includes(q) ||
        (i.network ?? "").toLowerCase().includes(q),
      );
    }
    if (activeFilter === "watched") filtered = filtered.filter((i) => getWatchStatus(i) === "watched");
    else if (activeFilter === "in-progress") filtered = filtered.filter((i) => getWatchStatus(i) === "in-progress");
    else if (activeFilter === "unwatched") filtered = filtered.filter((i) => !getWatchStatus(i));
    else if (activeFilter !== "all") filtered = filtered.filter((i) => i.genres?.includes(activeFilter));
    return filtered.sort((a, b) => (b.added ?? "").localeCompare(a.added ?? ""));
  }, [activeTab, movies, tvShows, activeFilter, getWatchStatus, searchQuery]);

  // Progressive loading (performance mode only)
  const [renderLimit, setRenderLimit] = useState(lite ? 24 : 9999);
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!lite) return;
    const el = loadMoreRef.current;
    const root = gridScrollRef.current;
    if (!el || !root || sortedItems.length <= renderLimit) return;
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) setRenderLimit((n) => n + 36); },
      { root, rootMargin: "300px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [lite, sortedItems.length, renderLimit]);

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      let targetTab = tab;
      if (targetTab === "movies" && movies.length === 0 && tvShows.length > 0) targetTab = "tv";
      if (targetTab === "tv" && tvShows.length === 0 && movies.length > 0) targetTab = "movies";
      setActiveTab(targetTab);
      setFocusedIndex(0);
      setSelectedItem(null);
      setShowHints(true);
      setRenderLimit(lite ? 24 : 9999);
    }
  }, [isOpen, tab, movies.length, tvShows.length, lite]);

  // Reset on tab change
  useEffect(() => {
    setFocusedIndex(0);
    setSelectedItem(null);
    setActiveFilter("all");
    setSearchQuery("");
    setFocusZone("grid");
    setFilterFocusIndex(0);
    setRenderLimit(lite ? 24 : 9999);
  }, [activeTab, lite]);

  // Scroll focused card into view — expand render limit if needed
  useEffect(() => {
    if (selectedItem || focusZone !== "grid") return;
    if (focusedIndex >= renderLimit) {
      setRenderLimit(focusedIndex + 12);
      return;
    }
    const card = cardRefs.current.get(focusedIndex);
    if (card) card.scrollIntoView({ block: "nearest", behavior: lite ? "instant" : "smooth" });
  }, [focusedIndex, selectedItem, focusZone, renderLimit, lite]);

  // Scroll focused filter into view
  useEffect(() => {
    if (focusZone !== "filters") return;
    const pill = filterRefs.current.get(filterFocusIndex);
    if (pill) pill.scrollIntoView({ inline: "center", behavior: lite ? "instant" : "smooth", block: "nearest" });
  }, [filterFocusIndex, focusZone]);

  // ── Edge-zone auto-scrolling for pointer/cursor navigation (VIDAA, smart TVs) ──
  const gridEdgeRef = useEdgeScroll("y", 100, 12);
  const filterEdgeRef = useEdgeScroll("x", 60, 8);

  // Backdrop — in quality mode, preload with Image() for smooth crossfade.
  // In lite mode, skip the expensive preload but still show the poster as a static bg.
  const focusedItem = sortedItems[focusedIndex] ?? null;
  const backdropSrc = lite ? undefined : resolveBackdropUrl(focusedItem?.backdrop, 1280);
  const posterFallbackSrc = resolvePosterUrl(focusedItem?.poster, lite ? 120 : 400);
  const [displayedBackdrop, setDisplayedBackdrop] = useState<string | undefined>();
  const [displayedPosterFallback, setDisplayedPosterFallback] = useState<string | undefined>();
  useEffect(() => {
    if (lite) {
      // Lite: no preload, just set poster directly (no Image() overhead)
      setDisplayedBackdrop(undefined);
      setDisplayedPosterFallback(posterFallbackSrc);
      return;
    }
    if (backdropSrc) {
      if (backdropSrc === displayedBackdrop) return;
      const img = new window.Image();
      img.src = backdropSrc;
      img.onload = () => { setDisplayedBackdrop(backdropSrc); setDisplayedPosterFallback(undefined); };
      img.onerror = () => { setDisplayedBackdrop(undefined); setDisplayedPosterFallback(posterFallbackSrc); };
    } else {
      setDisplayedBackdrop(undefined);
      setDisplayedPosterFallback(posterFallbackSrc);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backdropSrc, posterFallbackSrc, lite]);

  // Fullscreen + close management
  const containerRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const originalClose = close;
  const safeClose = useCallback(() => { closingRef.current = true; originalClose(); }, [originalClose]);

  const playItem = useCallback(
    (item: MediaItem) => {
      // Exit fullscreen first, then navigate — prevents race conditions
      const navigate = () => {
        safeClose();
        router.push(`/dashboard/media/${item.type}/${item.id}?autoplay=1`);
      };
      if (document.fullscreenElement) {
        document.exitFullscreen().then(navigate).catch(navigate);
      } else {
        navigate();
      }
    },
    [safeClose, router],
  );

  // ── Keyboard navigation ──────────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      // Mark keyboard active — suppress mouse hover for a short period
      usingKeyboard.current = true;
      clearTimeout(keyboardTimer.current);
      keyboardTimer.current = setTimeout(() => { usingKeyboard.current = false; }, 800);
      // Hide hints after first interaction
      if (showHints) setShowHints(false);

      // Search input focused — only intercept nav keys
      if (document.activeElement === searchInputRef.current) {
        if (e.key === "ArrowDown" || e.key === "s") { e.preventDefault(); setFocusZone("filters"); containerRef.current?.focus(); }
        else if (e.key === "Escape") { e.preventDefault(); setSearchQuery(""); containerRef.current?.focus(); }
        return;
      }

      const cols = getColumnCount();
      const gridMax = sortedItems.length - 1;
      const key = e.key;

      // TV remote Back button
      if (TV_BACK_KEYCODES.has(e.keyCode)) {
        e.preventDefault();
        if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
        safeClose();
        return;
      }

      switch (key) {
        case "Escape":
          e.preventDefault();
          if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
          safeClose();
          break;

        case "/":
          e.preventDefault();
          searchInputRef.current?.focus();
          break;

        case "ArrowLeft":
        case "a":
          e.preventDefault();
          if (focusZone === "grid") setFocusedIndex((i) => Math.max(0, i - 1));
          else if (focusZone === "filters") setFilterFocusIndex((i) => Math.max(0, i - 1));
          else if (focusZone === "tabs") setTabFocusIndex((i) => Math.max(0, i - 1));
          break;

        case "ArrowRight":
        case "d":
          e.preventDefault();
          if (focusZone === "grid") setFocusedIndex((i) => Math.min(gridMax, i + 1));
          else if (focusZone === "filters") setFilterFocusIndex((i) => Math.min(availableFilters.length - 1, i + 1));
          else if (focusZone === "tabs") setTabFocusIndex((i) => Math.min(availableTabs.length, i + 1));
          break;

        case "ArrowUp":
        case "w":
          e.preventDefault();
          if (focusZone === "grid") {
            if (focusedIndex - cols < 0) setFocusZone("filters");
            else setFocusedIndex((i) => i - cols);
          } else if (focusZone === "filters") setFocusZone("tabs");
          break;

        case "ArrowDown":
        case "s":
          e.preventDefault();
          if (focusZone === "tabs") setFocusZone("filters");
          else if (focusZone === "filters") { setFocusZone("grid"); setFocusedIndex(0); }
          else if (focusZone === "grid") setFocusedIndex((i) => Math.min(gridMax, i + cols));
          break;

        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          if (focusZone === "grid" && focusedItem) setSelectedItem(focusedItem);
          else if (focusZone === "filters") {
            const f = availableFilters[filterFocusIndex];
            if (f) { setActiveFilter(activeFilter === f && f !== "all" ? "all" : f); setFocusedIndex(0); }
          } else if (focusZone === "tabs") {
            if (tabFocusIndex < availableTabs.length) setActiveTab(availableTabs[tabFocusIndex]);
            else searchInputRef.current?.focus();
          }
          break;

        case " ":
          e.preventDefault();
          if (focusZone === "grid" && focusedItem) setSelectedItem(focusedItem);
          else if (focusZone === "filters") {
            const f = availableFilters[filterFocusIndex];
            if (f) { setActiveFilter(activeFilter === f && f !== "all" ? "all" : f); setFocusedIndex(0); }
          }
          break;

        case "Tab":
          e.preventDefault();
          if (focusZone === "grid") setFocusZone("tabs");
          else if (focusZone === "tabs") setFocusZone("filters");
          else setFocusZone("grid");
          break;

        case "Home":
          e.preventDefault();
          if (focusZone === "grid") setFocusedIndex(0);
          else if (focusZone === "filters") setFilterFocusIndex(0);
          break;

        case "End":
          e.preventDefault();
          if (focusZone === "grid") setFocusedIndex(gridMax);
          else if (focusZone === "filters") setFilterFocusIndex(availableFilters.length - 1);
          break;
      }
    },
    [sortedItems.length, focusedItem, focusZone, focusedIndex, filterFocusIndex,
     availableFilters, availableTabs, tabFocusIndex, activeFilter, safeClose, playItem, getColumnCount],
  );

  // Fullscreen
  useEffect(() => {
    if (!isOpen) return;
    const el = containerRef.current;
    if (el && !document.fullscreenElement) el.requestFullscreen?.().catch(() => {});
  }, [isOpen]);

  // Re-enter fullscreen if browser exits it unexpectedly (only in grid browse mode).
  // Don't re-enter when in detail view — user may be exiting player fullscreen.
  useEffect(() => {
    if (!isOpen) { closingRef.current = false; return; }
    const handleFsChange = () => {
      if (!document.fullscreenElement && isOpen && !closingRef.current && !selectedItem) {
        containerRef.current?.requestFullscreen?.().catch(() => {});
      }
    };
    document.addEventListener("fullscreenchange", handleFsChange);
    return () => document.removeEventListener("fullscreenchange", handleFsChange);
  }, [isOpen, selectedItem]);

  // Auto-focus container
  useEffect(() => {
    if (isOpen && containerRef.current && !selectedItem) containerRef.current.focus();
  }, [isOpen, selectedItem]);

  if (!isOpen) return null;

  const overlay = (
    <div
      ref={containerRef}
      className="dark fixed inset-0 z-[100] bg-background flex flex-col outline-none"
      tabIndex={selectedItem ? -1 : 0}
      onKeyDown={selectedItem ? undefined : handleKeyDown}
      onMouseMove={showHints ? () => setShowHints(false) : undefined}
      role="application"
      aria-label="Cinema browser"
    >
      {/* Detail view */}
      {selectedItem && (
        <CinemaDetail
          item={selectedItem}
          onBack={() => { setSelectedItem(null); setFocusZone("grid"); requestAnimationFrame(() => containerRef.current?.focus()); }}
          onPlay={playItem}
          onSelectItem={setSelectedItem}
          onFilterByGenre={(genre) => { setActiveFilter(genre); setSelectedItem(null); setFocusedIndex(0); setFocusZone("grid"); requestAnimationFrame(() => containerRef.current?.focus()); }}
          cinemaContainerRef={containerRef}
          lite={lite}
        />
      )}


      {/* ── Hero ── */}
      <div className="relative flex-shrink-0 overflow-hidden" style={{ height: lite ? "22vh" : "38vh", minHeight: lite ? "140px" : "240px", maxHeight: lite ? "260px" : "440px" }}>
        {displayedBackdrop && (
          <Image key={displayedBackdrop} src={displayedBackdrop} alt="" fill
            className={cn("object-cover", !lite && "animate-[cinemaFadeIn_0.6s_ease-out_both]")} sizes="100vw" priority />
        )}
        {!displayedBackdrop && displayedPosterFallback && (
          <Image key={`p-${displayedPosterFallback}`} src={displayedPosterFallback} alt="" fill
            className={cn("object-cover", lite ? "opacity-20" : "opacity-30 blur-3xl scale-125 animate-[cinemaFadeIn_0.6s_ease-out_both]")} sizes="100vw" />
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/60 to-background/20" />
        <div className="absolute inset-0 bg-gradient-to-r from-background/70 via-transparent to-transparent" />

        {/* ── Top bar: tabs + search + close ── */}
        <div className="absolute top-0 left-0 right-0 z-10 px-10 py-6">
          <div className="flex items-center justify-between gap-4">
            {/* Tabs */}
            <div className={cn("flex items-center gap-1.5 rounded-xl p-1.5", lite ? "bg-black/50" : "bg-white/10 backdrop-blur-md")}>
              {availableTabs.map((t, i) => (
                <button
                  key={t}
                  className={cn(
                    "px-6 py-2.5 rounded-lg text-base font-medium", !lite && "transition-all duration-150",
                    activeTab === t ? "bg-white/25 text-white" : "text-white/60 hover:text-white hover:bg-white/10",
                    focusZone === "tabs" && tabFocusIndex === i && "ring-2 ring-white/60",
                  )}
                  onClick={() => { setActiveTab(t); requestAnimationFrame(() => containerRef.current?.focus()); }}
                >
                  {t === "movies" ? "Movies" : "TV Shows"}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3">
              {/* Search — always visible, same height as tabs */}
              <div className={cn(
                cn("flex items-center gap-3 rounded-xl px-5 h-[52px] transition-colors", lite ? "bg-black/50" : "bg-white/10 backdrop-blur-md"),
                focusZone === "tabs" && tabFocusIndex === availableTabs.length && "ring-2 ring-white/60",
              )}>
                <HugeiconsIcon icon={Search01Icon} size={20} className="text-white/60 shrink-0" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setFocusedIndex(0); }}
                  onFocus={() => { setFocusZone("tabs"); setTabFocusIndex(availableTabs.length); }}
                  onBlur={() => requestAnimationFrame(() => containerRef.current?.focus())}
                  placeholder="Search..."
                  className="bg-transparent border-none outline-none text-base text-white placeholder:text-white/50 w-[180px]"
                />
              </div>
              {/* Close */}
              <button
                className={cn("flex items-center justify-center size-[52px] rounded-xl text-white/60 hover:text-white hover:bg-white/15 transition-colors", lite ? "bg-black/50" : "bg-white/10 backdrop-blur-md")}
                onClick={() => { if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); safeClose(); }}
                aria-label="Close"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={22} />
              </button>
            </div>
          </div>
        </div>

        {/* ── Hero metadata ── */}
        {focusedItem && !selectedItem && (
          <div className={cn("absolute bottom-0 left-0 right-0 px-10 flex items-end gap-5", lite ? "pb-3" : "pb-6")}>
            {!lite && !displayedBackdrop && posterFallbackSrc && (
              <div className="shrink-0 relative w-[80px] aspect-[2/3] rounded-md overflow-hidden ring-1 ring-white/10 hidden sm:block">
                <Image src={posterFallbackSrc} alt="" fill className="object-cover" sizes="80px" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <h1 className={cn("font-medium text-white leading-tight max-w-[60%] line-clamp-1", lite ? "text-2xl mb-1" : "text-3xl sm:text-4xl mb-2")}>
                {focusedItem.title}
              </h1>
              <div className="flex items-center gap-3 flex-wrap">
                {focusedItem.rating != null && focusedItem.rating > 0 && (
                  <span className="flex items-center gap-1 text-base text-amber-400">
                    <HugeiconsIcon icon={StarIcon} size={16} />{focusedItem.rating.toFixed(1)}
                  </span>
                )}
                {focusedItem.year && <span className="text-base text-white/60">{focusedItem.year}</span>}
                {!lite && focusedItem.runtime && <span className="text-base text-white/50">{formatRuntimeMinutes(focusedItem.runtime)}</span>}
                {!lite && focusedItem.genres && focusedItem.genres.length > 0 && (
                  <span className="text-base text-white/50">{focusedItem.genres.slice(0, 3).join(" · ")}</span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Filter row ── */}
      <div ref={(el) => { filterRowRef.current = el; filterEdgeRef(el); }} className="flex-shrink-0 px-10 pt-5 pb-2 flex items-center gap-1.5 overflow-x-auto scrollbar-none">
        {availableFilters.map((f, i) => {
          const labels: Record<string, string> = { all: "All", "in-progress": "Continue Watching", unwatched: "Unwatched", watched: "Watched" };
          const label = labels[f] ?? f;
          const isActive = activeFilter === f;
          const isFocused = focusZone === "filters" && filterFocusIndex === i;
          const isFirstGenre = !labels[f] && (i === 0 || labels[availableFilters[i - 1]]);

          return (
            <div key={f} className="flex items-center shrink-0">
              {isFirstGenre && <div className="w-px h-5 bg-border/20 shrink-0 mx-2" />}
              <button
                ref={(el) => { if (el) filterRefs.current.set(i, el); else filterRefs.current.delete(i); }}
                className={cn(
                  "whitespace-nowrap px-5 py-2 text-base rounded-lg", !lite && "transition-all duration-150",
                  isActive ? "text-white font-medium bg-white/20" : labels[f] ? "text-white/50 hover:text-white hover:bg-white/8" : "text-white/40 hover:text-white/70 hover:bg-white/8",
                  isFocused && "ring-2 ring-white/60",
                )}
                onClick={() => { setActiveFilter(isActive && f !== "all" ? "all" : f); setFocusedIndex(0); requestAnimationFrame(() => containerRef.current?.focus()); }}
              >
                {label}
              </button>
            </div>
          );
        })}
      </div>

      {/* ── Poster grid ── */}
      <div ref={(el) => { gridScrollRef.current = el; gridEdgeRef(el); }} className="flex-1 min-h-0 overflow-y-auto scrollbar-none">
        {!library ? (
          /* Skeleton grid while loading */
          <div className="grid gap-x-5 gap-y-8 px-14 pt-10 pb-10" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            {Array.from({ length: 18 }).map((_, i) => (
              <div key={i} className="rounded-xl overflow-hidden">
                <div className="aspect-[2/3] bg-white/5 animate-pulse rounded-xl" />
                <div className="px-1.5 py-2 space-y-1.5">
                  <div className="h-3.5 bg-white/5 rounded w-3/4 animate-pulse" />
                  <div className="h-2.5 bg-white/5 rounded w-1/2 animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : (<>
        <div ref={gridRef} className="grid gap-x-5 gap-y-8 px-14 pt-10 pb-10" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
          {sortedItems.slice(0, renderLimit).map((item, i) => {
            const focused = i === focusedIndex && !selectedItem && focusZone === "grid";
            const poster = resolvePosterUrl(item.poster, lite ? 120 : 240);
            const watchStatus = getWatchStatus(item);
            return (
              <div
                key={`${item.type}-${item.id}`}
                ref={(el) => { if (el) cardRefs.current.set(i, el); else cardRefs.current.delete(i); }}
                className={cn(
                  "cinema-card group cursor-pointer rounded-xl",
                  !lite && "transition-all duration-200 ease-out will-change-transform",
                  focused
                    ? cn("z-10", !lite ? "scale-110 ring-2 ring-white/70" : "ring-2 ring-white ring-offset-2 ring-offset-background")
                    : cn(!lite && "hover:scale-105 hover:z-10"),
                )}
                style={lite ? { contentVisibility: "auto", containIntrinsicSize: "150px 280px" } : undefined}
                onClick={() => setSelectedItem(item)}
                onMouseEnter={() => { if (!usingKeyboard.current) { setFocusedIndex(i); setFocusZone("grid"); } }}
                onMouseDown={() => requestAnimationFrame(() => containerRef.current?.focus())}
              >
                <div className="relative aspect-[2/3] bg-muted/30 rounded-xl overflow-hidden">
                  {poster ? (
                    <Image src={poster} alt={item.title} fill
                      className={cn("object-cover",
                        !lite && "transition-all duration-200",
                        focused ? "brightness-110 saturate-110" : (lite ? "" : "brightness-90 group-hover:brightness-105"))}
                      sizes="150px" loading={i < (lite ? 8 : 12) ? "eager" : "lazy"} />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <HugeiconsIcon icon={item.type === "tv" ? Tv01Icon : Film01Icon} size={28} className="text-dim-foreground" />
                    </div>
                  )}
                  {watchStatus === "watched" && (
                    <div className="absolute top-2 left-2 flex items-center justify-center size-5 rounded-full bg-status-healthy/90">
                      <HugeiconsIcon icon={CheckmarkCircle01Icon} size={12} className="text-white" />
                    </div>
                  )}
                  {watchStatus === "in-progress" && (
                    <div className="absolute top-2 left-2 flex items-center justify-center size-5 rounded-full bg-blue-500/90">
                      <HugeiconsIcon icon={PlayIcon} size={10} className="text-white" />
                    </div>
                  )}
                  {(() => {
                    const progress = progressByTitle.get(item.title.toLowerCase());
                    if (!progress || progress.duration <= 0) return null;
                    const pct = Math.min(100, (progress.viewOffset / progress.duration) * 100);
                    if (pct < 1) return null;
                    return (
                      <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/60">
                        <div className="h-full bg-white/80 rounded-r-full" style={{ width: `${pct}%` }} />
                      </div>
                    );
                  })()}
                </div>
                <div className="px-1.5 py-2">
                  <p className={cn("text-sm font-medium truncate",
                    !lite && "transition-colors",
                    focused ? "text-white" : "text-white/90 group-hover:text-white")}>
                    {item.title}
                  </p>
                  <p className={cn("text-xs truncate", focused ? "text-white/60" : "text-white/40")}>
                    {item.year}{item.type === "tv" && item.seasonCount ? ` · ${item.seasonCount}S` : ""}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
        {lite && sortedItems.length > renderLimit && <div ref={loadMoreRef} className="h-1" />}
        </>)}
      </div>

      {/* ── Bottom hints — hidden after first interaction ── */}
      {showHints && (
        <div className={cn("flex-shrink-0 flex items-center justify-center gap-6 px-10 py-3 border-t border-white/5 bg-background/90", !lite && "backdrop-blur-sm")}>
          {[
            { keys: ["←→↑↓", "WASD"], label: "Navigate" },
            { keys: ["Space", "Enter"], label: "Select" },
            { keys: ["Tab"], label: "Section" },
            { keys: ["Esc"], label: "Exit" },
          ].map(({ keys, label }) => (
            <span key={label} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              {keys.map((k, i) => (
                <span key={k} className="inline-flex items-center gap-1">
                  {i > 0 && <span className="text-dim-foreground">/</span>}
                  <kbd className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded-md bg-white/5 border border-white/10 font-mono text-xs text-muted-foreground">
                    {k}
                  </kbd>
                </span>
              ))}
              <span>{label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );

  if (typeof window === "undefined") return null;
  return createPortal(overlay, document.body);
}
