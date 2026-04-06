"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import Hls from "hls.js";
import {
  HugeiconsIcon,
  PlayIcon,
  PauseIcon,
  GoForward15SecIcon,
  GoBackward15SecIcon,
  MaximizeScreenIcon,
  MinimizeScreenIcon,
  DashboardSpeed01Icon,
  Download01Icon,
  SubtitleIcon,
  LanguageSkillIcon,
  InformationCircleIcon,
  ArrowLeft02Icon,
  PictureInPictureOnIcon,
  PictureInPictureExitIcon,
  AirplayLineIcon,
  Settings01Icon,
  NextIcon,
  PreviousIcon,
} from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getDirectCoreUrl } from "@/lib/constants";
import type { IconSvgElement } from "@/components/icons";

// ── Types (from extracted module) ────────────────────────────────────────
import type {
  AudioTrackInfo,
  SubtitleTrackInfo,
  PlaybackMode,
  SubtitleStyle,
  SubtitleFontSize,
  JellyfinSession,
  ChapterInfo,
  TrickplayInfo,
  QualityLevel,
  VideoPlayerProps,
  AudioPlayerProps,
} from "./media-player/types";
import {
  DIRECT_PLAY_EXTS,
  HLS_EXTS,
  BROWSER_AUDIO,
  SPEED_OPTIONS,
  SUBTITLE_FONT_SIZES,
  SUBTITLE_DEFAULTS,
  FS_DEFAULTS,
} from "./media-player/types";

// ── Helpers (from extracted module) ──────────────────────────────────────
import {
  formatTime,
  getVolumeIcon,
  trackLabel,
  fileExt,
  needsHls,
  isSafari,
  supportsHevc,
  supportsPiP,
  supportsAirPlay,
  loadFsSettings,
  loadSubtitleStyle,
  saveSubtitleStyle,
  loadSpeed,
  saveSpeed,
  isIntroChapter,
  isCreditsChapter,
} from "./media-player/helpers";

// ── MediaSlider (from extracted module) ──────────────────────────────────
import { MediaSlider } from "./media-player/media-slider";

// ── VideoPlayer ──────────────────────────────────────────────────────────

export function VideoPlayer({
  src,
  fileName,
  filePath,
  apiBase: apiBaseProp,
  onEnded,
  autoFullscreen,
  onExitFullscreen,
  cinemaMode,
  onBack,
  onNext,
  onPrevious,
  nextLabel,
  previousLabel,
  preferOriginal,
}: VideoPlayerProps) {
  // ── Playback mode ──────────────────────────────────────────────────────
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>("deciding");
  const hlsRequired = playbackMode === "hls" || playbackMode === "jellyfin-hls";

  // ── Refs ───────────────────────────────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(null);

  // ── Core playback state ────────────────────────────────────────────────
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [error, setError] = useState(false);
  const [hlsReady, setHlsReady] = useState(false);
  const [hlsSrc, setHlsSrc] = useState<string | null>(null);

  // ── HLS state ──────────────────────────────────────────────────────────
  const [hlsSeekOffset, setHlsSeekOffset] = useState(0);
  const hlsStartedAt = useRef(0);
  const hlsHashRef = useRef<string | null>(null);
  const [hlsRetry, setHlsRetry] = useState(0);
  const hlsRetryCount = useRef(0);

  // ── Transmux state ─────────────────────────────────────────────────────
  const [transmuxSrc, setTransmuxSrc] = useState<string | null>(null);
  const [transmuxReady, setTransmuxReady] = useState(false);
  const transmuxHashRef = useRef<string | null>(null);
  const [transmuxProgress, setTransmuxProgress] = useState(0);
  const [probedVideoCodec, setProbedVideoCodec] = useState("");

  // ── Track info ─────────────────────────────────────────────────────────
  const [audioTracks, setAudioTracks] = useState<AudioTrackInfo[]>([]);
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrackInfo[]>([]);
  const [selectedAudio, setSelectedAudio] = useState(0);
  const [selectedSub, setSelectedSub] = useState<number | null>(null);
  const [subVttText, setSubVttText] = useState<string | null>(null);
  const [subBlobUrl, setSubBlobUrl] = useState<string | null>(null);

  // ── Speed ──────────────────────────────────────────────────────────────
  const [speed, setSpeed] = useState(() => loadSpeed());

  // ── Picture-in-Picture ─────────────────────────────────────────────────
  const [isPiP, setIsPiP] = useState(false);
  const pipSupported = useMemo(() => supportsPiP(), []);

  // ── AirPlay ────────────────────────────────────────────────────────────
  const [airplayAvailable, setAirplayAvailable] = useState(false);

  // ── Subtitle styling ──────────────────────────────────────────────────
  const [subStyle, setSubStyle] = useState<SubtitleStyle>(() => loadSubtitleStyle());

  // ── Quality selector ──────────────────────────────────────────────────
  const [qualityLevels, setQualityLevels] = useState<QualityLevel[]>([]);
  const [currentQuality, setCurrentQuality] = useState(-1);
  // Jellyfin transcode quality presets (different bitrate/resolution URLs)
  const [jfQualities, setJfQualities] = useState<Array<{ label: string; height: number; bitrate: number; url: string }>>([]);

  // ── Resume position ────────────────────────────────────────────────────
  const [resumePosition, setResumePosition] = useState<number | null>(null);
  const resumeApplied = useRef(false);
  const [showResumeIndicator, setShowResumeIndicator] = useState(false);

  // ── Chapters (intro/credits skip) ─────────────────────────────────────
  const [chapters, setChapters] = useState<ChapterInfo[]>([]);

  // ── Seek thumbnails (trickplay) ────────────────────────────────────────
  const [trickplay, setTrickplay] = useState<TrickplayInfo | null>(null);
  const [hoverPos, setHoverPos] = useState<{ clientX: number; value: number } | null>(null);

  // ── Next/Previous auto-advance ─────────────────────────────────────────
  const [autoAdvanceCountdown, setAutoAdvanceCountdown] = useState<number | null>(null);

  // ── API base ──────────────────────────────────────────────────────────
  const baseUrl = getDirectCoreUrl();
  const apiBase = apiBaseProp ?? `${baseUrl}/api/files`;
  const isMediaLibrary = apiBase.endsWith("/api/media");

  // ── Jellyfin playback state ────────────────────────────────────────────
  const [jellyfinSrc, setJellyfinSrc] = useState<string | null>(null);
  const jfSessionRef = useRef<JellyfinSession | null>(null);
  const [hasJfSession, setHasJfSession] = useState(false);
  // Store both Jellyfin URLs for quality selector switching
  const jfDirectPlayUrl = useRef<string | null>(null);
  const jfTranscodeUrl = useRef<string | null>(null);

  // ── HLS.js ref ─────────────────────────────────────────────────────────
  const hlsRef = useRef<Hls | null>(null);

  // ── Fullscreen / TV settings ───────────────────────────────────────────
  const [showInfo, setShowInfo] = useState(false);
  const fsSettings = useRef(loadFsSettings());

  // ═══════════════════════════════════════════════════════════════════════
  // EFFECTS
  // ═══════════════════════════════════════════════════════════════════════

  // ── Probe file for tracks (all browsers) ──────────────────────────────
  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;

    void (async () => {
      try {
        // For media library items (movies/TV), use Jellyfin PlaybackInfo.
        // Skip for file-browser items (audiobooks, raw files).
        if (isMediaLibrary) {
          try {
            const jfRes = await fetch(`${apiBase}/jellyfin-playback`, {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: filePath }),
            });
            if (jfRes.ok && !cancelled) {
              const jf = await jfRes.json();
              if (jf.available) {
                // Store session info for progress reporting
                jfSessionRef.current = {
                  jellyfinBaseUrl: jf.jellyfinBaseUrl,
                  apiKey: jf.apiKey,
                  itemId: jf.itemId,
                  mediaSourceId: jf.mediaSourceId,
                  playSessionId: jf.playSessionId,
                };
                setHasJfSession(true);

                // Set tracks from Jellyfin MediaStreams
                if (jf.audioTracks?.length) setAudioTracks(jf.audioTracks);
                if (jf.subtitleTracks?.length) setSubtitleTracks(
                  jf.subtitleTracks.filter((s: { isTextBased: boolean }) => s.isTextBased),
                );
                if (jf.duration > 0) setDuration(jf.duration);

                // Resume position from Jellyfin
                if (jf.resumePositionTicks > 0) {
                  setResumePosition(jf.resumePositionTicks / 10_000_000);
                }

                // Chapters from Jellyfin
                if (jf.chapters?.length) {
                  setChapters(jf.chapters);
                }

                // Store both URLs for quality selector
                if (jf.directPlayUrl) jfDirectPlayUrl.current = jf.directPlayUrl;
                if (jf.transcodeUrl) jfTranscodeUrl.current = jf.transcodeUrl;
                if (jf.transcodeQualities?.length) setJfQualities(jf.transcodeQualities);

                // Trickplay data from backend response
                if (jf.trickplay) {
                  setTrickplay(jf.trickplay);
                }

                const useDirectPlay = (jf.playMethod === "DirectPlay" || preferOriginal) && jf.directPlayUrl;
                if (useDirectPlay) {
                  setJellyfinSrc(jf.directPlayUrl);
                  setPlaybackMode("jellyfin");
                  setCurrentQuality(-2);
                  setHlsReady(true);
                } else if (jf.transcodeUrl) {
                  setHlsSrc(jf.transcodeUrl);
                  setPlaybackMode("jellyfin-hls");
                  // Select the first Jellyfin quality preset if available, otherwise default
                  setCurrentQuality(jf.transcodeQualities?.length ? 100 : -1);
                } else {
                  // Neither direct play nor transcode available — fall through to Talome probe
                }

                if (useDirectPlay || jf.transcodeUrl) {
                  return; // Jellyfin handles playback — skip Talome pipeline
                }
              }
            }
          } catch { /* Jellyfin unavailable — fall through to Talome pipeline */ }
        }

        const res = await fetch(
          `${apiBase}/probe?path=${encodeURIComponent(filePath)}`,
          { credentials: "include" },
        );
        if (!res.ok || cancelled) {
          // Probe failed (e.g. no ffmpeg on host) — show error instead of staying in "deciding"
          if (!cancelled) setError(true);
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        if (data.audio) setAudioTracks(data.audio);
        if (data.subtitle) setSubtitleTracks(data.subtitle.filter((s: SubtitleTrackInfo) => s.textBased));
        if (data.duration > 0) setDuration(data.duration);

        // Decide playback strategy based on container, video codec, and audio codec.
        // Priority: optimized MP4 > direct (MP4+native codecs) > direct-mkv (Chrome+MKV) > transmux (any→MP4) > hls
        if (!cancelled) {
          if (data.optimized) {
            const vCodec = data.videoCodec ?? "";
            const transfer = data.videoColorTransfer ?? "";
            const pixFmt = data.videoPixFmt ?? "";
            const is10bit = pixFmt.includes("10");
            const isSdrTransfer = transfer === "bt709" || transfer === "bt2020-10" || transfer === "iec61966-2-1";
            const isHdr = (vCodec === "hevc" || vCodec === "h265") && is10bit && !isSdrTransfer;

            if (isHdr) {
              setPlaybackMode("hls");
            } else {
              setPlaybackMode("direct");
              setHlsReady(true);
            }
          } else {
            const vCodec = data.videoCodec ?? "";
            const aCodec = (data.audio?.[0]?.codec ?? "").toLowerCase();
            const ext = fileExt(fileName);
            const safari = isSafari();
            const transfer = data.videoColorTransfer ?? "";
            const pixFmt = data.videoPixFmt ?? "";
            const is10bit = pixFmt.includes("10");
            const isHevc = vCodec === "hevc" || vCodec === "h265";
            const isSdrTransfer = transfer === "bt709" || transfer === "bt2020-10" || transfer === "iec61966-2-1";
            const isHdr = isHevc && is10bit && !isSdrTransfer;
            const videoOk = vCodec === "h264" || (isHevc && (safari || supportsHevc()));
            const audioOk = BROWSER_AUDIO.has(aCodec);
            const isDirectContainer = DIRECT_PLAY_EXTS.has(ext);

            let needsOptimization = true;
            if (isHdr) {
              setPlaybackMode("hls");
            } else if (isDirectContainer && videoOk && audioOk) {
              setPlaybackMode("direct");
              setHlsReady(true);
              needsOptimization = false;
            } else if (!safari && ext === "mkv" && videoOk && audioOk) {
              setPlaybackMode("direct-mkv");
            } else if (videoOk) {
              setPlaybackMode("transmux");
            } else {
              setPlaybackMode("hls");
            }
            // Queue for permanent optimization so it direct-plays next time
            if (needsOptimization) {
              void fetch(`${baseUrl}/api/optimization/queue`, {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ paths: [filePath] }),
              }).catch(() => {});
            }
            setProbedVideoCodec(vCodec);
          }
        }
      } catch {
        // Entire probe/Jellyfin flow failed — show error instead of staying in "deciding"
        if (!cancelled) setError(true);
      }
    })();

    return () => { cancelled = true; };
  }, [filePath, apiBase]);

  // ── Stop current transmux job (fire-and-forget) ───────────────────────
  const stopCurrentTransmux = useCallback(() => {
    const hash = transmuxHashRef.current;
    if (!hash) return;
    transmuxHashRef.current = null;
    void fetch(`${apiBase}/transmux-stop`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash }),
    }).catch(() => {});
  }, [apiBase]);

  // ── Transmux effect — Chrome direct play for MKV files ────────────────
  useEffect(() => {
    if (playbackMode !== "transmux" || !filePath) return;
    let cancelled = false;
    setTransmuxReady(false);
    setTransmuxSrc(null);
    setTransmuxProgress(0);

    const init = async () => {
      try {
        const res = await fetch(
          `${apiBase}/transmux-start?path=${encodeURIComponent(filePath)}`,
          { credentials: "include" },
        );
        if (!res.ok || cancelled) { if (!cancelled) setError(true); return; }
        const { hash, duration: d } = await res.json();
        if (cancelled) { stopCurrentTransmux(); return; }
        transmuxHashRef.current = hash;
        if (d > 0) setDuration(d);

        const statusUrl = `${apiBase}/transmux-status/${hash}`;
        const streamUrl = `${apiBase}/transmux/${hash}/stream`;
        const deadline = Date.now() + 300_000;
        while (!cancelled && Date.now() < deadline) {
          try {
            const s = await fetch(statusUrl, { credentials: "include" });
            if (s.ok) {
              const data = await s.json();
              if (data.progress != null && !cancelled) setTransmuxProgress(data.progress);
              if (data.ready) {
                setTransmuxProgress(1);
                setTransmuxSrc(streamUrl);
                setTransmuxReady(true);
                return;
              }
              if (data.error) { if (!cancelled) setError(true); return; }
            }
          } catch { /* not ready */ }
          await new Promise((r) => setTimeout(r, 500));
        }
        if (!cancelled) setError(true);
      } catch {
        if (!cancelled) setError(true);
      }
    };

    void init();
    return () => { cancelled = true; stopCurrentTransmux(); };
  }, [playbackMode, filePath, apiBase, stopCurrentTransmux]);

  // ── Stop current HLS job (fire-and-forget) ────────────────────────────
  const stopCurrentHls = useCallback(() => {
    const hash = hlsHashRef.current;
    if (!hash) return;
    hlsHashRef.current = null;
    void fetch(`${apiBase}/hls-stop`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash }),
    }).catch(() => {});
  }, [apiBase]);

  // ── HLS keep-alive ping ───────────────────────────────────────────────
  useEffect(() => {
    if (!hlsRequired) return;
    const interval = setInterval(() => {
      const hash = hlsHashRef.current;
      if (!hash) return;
      void fetch(`${apiBase}/hls-ping`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash }),
      }).catch(() => {});
    }, 30_000);
    return () => clearInterval(interval);
  }, [hlsRequired, apiBase]);

  // ── Jellyfin session reporting ────────────────────────────────────────
  const currentTimeRef = useRef(0);
  const playingRef = useRef(false);
  currentTimeRef.current = currentTime;
  playingRef.current = playing;
  useEffect(() => {
    const session = jfSessionRef.current;
    if (!session) return;
    const { jellyfinBaseUrl, apiKey, itemId, mediaSourceId, playSessionId } = session;
    const headers = { "Content-Type": "application/json" };

    void fetch(`${jellyfinBaseUrl}/Sessions/Playing?api_key=${apiKey}`, {
      method: "POST", headers,
      body: JSON.stringify({ ItemId: itemId, MediaSourceId: mediaSourceId, PlaySessionId: playSessionId }),
    }).catch(() => {});

    const interval = setInterval(() => {
      const ticks = Math.round(currentTimeRef.current * 10_000_000);
      void fetch(`${jellyfinBaseUrl}/Sessions/Playing/Progress?api_key=${apiKey}`, {
        method: "POST", headers,
        body: JSON.stringify({
          ItemId: itemId, MediaSourceId: mediaSourceId,
          PlaySessionId: playSessionId, PositionTicks: ticks,
          IsPaused: !playingRef.current,
        }),
      }).catch(() => {});
    }, 10_000);

    return () => {
      clearInterval(interval);
      const ticks = Math.round(currentTimeRef.current * 10_000_000);
      void fetch(`${jellyfinBaseUrl}/Sessions/Playing/Stopped?api_key=${apiKey}`, {
        method: "POST", headers,
        body: JSON.stringify({ ItemId: itemId, MediaSourceId: mediaSourceId, PlaySessionId: playSessionId, PositionTicks: ticks }),
      }).catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackMode]);

  // ── Clean up HLS job on true unmount ──────────────────────────────────
  const apiBaseRef = useRef(apiBase);
  apiBaseRef.current = apiBase;
  useEffect(() => {
    return () => {
      const capturedHash = hlsHashRef.current;
      const capturedApi = apiBaseRef.current;
      setTimeout(() => {
        if (capturedHash && capturedHash !== hlsHashRef.current) {
          void fetch(`${capturedApi}/hls-stop`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hash: capturedHash }),
          }).catch(() => {});
        }
      }, 100);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Start HLS conversion, poll for first segment ─────────────────────
  useEffect(() => {
    if (!hlsRequired) return;
    if (playbackMode === "jellyfin-hls") return;
    if (!filePath) { setError(true); return; }

    let cancelled = false;
    setHlsReady(false);
    setHlsSrc(null);

    const init = async () => {
      try {
        const isHevc = probedVideoCodec === "hevc" || probedVideoCodec === "h265";
        const needsTranscode = (isHevc || !["h264", "hevc", "h265"].includes(probedVideoCodec)) ? "&transcodeVideo=1" : "";
        const startRes = await fetch(
          `${apiBase}/hls-start?path=${encodeURIComponent(filePath)}&audioTrack=${selectedAudio}&seekTo=${hlsSeekOffset}${needsTranscode}`,
          { credentials: "include" },
        );
        if (!startRes.ok) { setError(true); return; }
        const { hash, duration: srcDuration } = await startRes.json();
        if (cancelled) return;

        hlsHashRef.current = hash;
        if (srcDuration > 0) setDuration(srcDuration);
        hlsStartedAt.current = Date.now();

        const playlistUrl = `${apiBase}/hls/${hash}/playlist.m3u8`;
        const deadline = Date.now() + 15_000;
        while (!cancelled && Date.now() < deadline) {
          try {
            const res = await fetch(playlistUrl, { credentials: "include", method: "HEAD" });
            if (res.ok) {
              setHlsSrc(playlistUrl);
              setHlsReady(true);
              return;
            }
          } catch { /* not ready yet */ }
          await new Promise((r) => setTimeout(r, 300));
        }
        if (!cancelled) setError(true);
      } catch {
        if (!cancelled) setError(true);
      }
    };

    void init();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlsRequired, filePath, selectedAudio, hlsSeekOffset, apiBase, hlsRetry]);

  // ── Fetch raw VTT text when subtitle selection changes ────────────────
  useEffect(() => {
    setSubVttText(null);
    if (selectedSub === null) return;

    let cancelled = false;

    void (async () => {
      try {
        const jfSub = subtitleTracks.find((s) => s.index === selectedSub);
        const isJf = playbackMode === "jellyfin" || playbackMode === "jellyfin-hls";
        const jfDeliveryUrl = isJf && jfSub && "deliveryUrl" in jfSub ? (jfSub as { deliveryUrl?: string }).deliveryUrl : null;

        let url: string;
        let creds: RequestCredentials;
        if (jfDeliveryUrl) {
          const sep = jfDeliveryUrl.includes("?") ? "&" : "?";
          url = `${jfDeliveryUrl}${sep}api_key=${jfSessionRef.current?.apiKey ?? ""}`;
          creds = "omit";
        } else {
          url = `${apiBase}/subtitle?path=${encodeURIComponent(filePath)}&index=${selectedSub}`;
          creds = "include";
        }

        const res = await fetch(url, { credentials: creds });
        if (cancelled || !res.ok) return;
        const vtt = await res.text();
        if (!cancelled) setSubVttText(vtt);
      } catch { /* non-critical */ }
    })();

    return () => { cancelled = true; };
  }, [selectedSub, filePath, apiBase, playbackMode, subtitleTracks]);

  // ── Build blob URL from VTT text, adjusting timestamps ────────────────
  useEffect(() => {
    setSubBlobUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    if (!subVttText) return;

    const seekShiftMs = hlsRequired ? hlsSeekOffset * 1000 : 0;
    const safariShiftMs = hlsRequired && isSafari() ? -500 : 0;
    const totalShiftMs = seekShiftMs + safariShiftMs;
    const vtt = totalShiftMs !== 0
      ? subVttText.replace(
          /(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/g,
          (_m, h, m, s, ms) => {
            let total = (+(h ?? 0) * 3600 + +m * 60 + +s) * 1000 + +ms - totalShiftMs;
            if (total < 0) total = 0;
            const hh = Math.floor(total / 3600000);
            const mm = Math.floor((total % 3600000) / 60000);
            const ss = Math.floor((total % 60000) / 1000);
            const mmm = Math.floor(total % 1000);
            return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(mmm).padStart(3, "0")}`;
          },
        )
      : subVttText;

    const blob = new Blob([vtt], { type: "text/vtt" });
    setSubBlobUrl(URL.createObjectURL(blob));
  }, [subVttText, hlsRequired, hlsSeekOffset]);

  // ── Enforce subtitle track mode ───────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const enforce = () => {
      for (let i = 0; i < v.textTracks.length; i++) {
        const track = v.textTracks[i];
        if (subBlobUrl && track.label === "Subtitles") {
          if (track.mode !== "showing") track.mode = "showing";
        } else {
          if (track.mode !== "disabled") track.mode = "disabled";
        }
      }
    };
    requestAnimationFrame(enforce);
    v.textTracks.addEventListener("change", enforce);
    return () => { v.textTracks.removeEventListener("change", enforce); };
  }, [subBlobUrl]);

  // ── Cleanup blob URL on unmount ───────────────────────────────────────
  useEffect(() => {
    return () => { setSubBlobUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; }); };
  }, []);

  // ── Controls hide timer ───────────────────────────────────────────────
  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (playing) {
      hideTimer.current = setTimeout(() => setShowControls(false), 3000);
    }
  }, [playing]);

  useEffect(() => {
    if (!playing) {
      setShowControls(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    } else {
      resetHideTimer();
    }
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [playing, resetHideTimer]);

  // ── Fullscreen change listeners ───────────────────────────────────────
  useEffect(() => {
    const d = document as Document & { webkitFullscreenElement?: Element };
    const onFs = () => {
      const fs = !!(document.fullscreenElement ?? d.webkitFullscreenElement);
      setIsFullscreen(fs);
      if (!fs && autoFullscreen && onExitFullscreen) onExitFullscreen();
    };
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);

    const v = videoRef.current;
    const onEnd = () => setIsFullscreen(false);
    const onBegin = () => setIsFullscreen(true);
    v?.addEventListener("webkitendfullscreen", onEnd);
    v?.addEventListener("webkitbeginfullscreen", onBegin);

    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onFs);
      v?.removeEventListener("webkitendfullscreen", onEnd);
      v?.removeEventListener("webkitbeginfullscreen", onBegin);
    };
  }, []);

  // ── Auto-enter fullscreen on mount ────────────────────────────────────
  useEffect(() => {
    if (!autoFullscreen) return;
    const el = containerRef.current;
    if (!el) return;
    const timer = setTimeout(() => {
      if (!document.fullscreenElement) {
        el.requestFullscreen?.().catch(() => {});
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [autoFullscreen]);

  // ── Show info overlay briefly on fullscreen enter ─────────────────────
  useEffect(() => {
    if (isFullscreen && fsSettings.current.showInfoOnStart) {
      setShowInfo(true);
      const t = setTimeout(() => setShowInfo(false), 4000);
      return () => clearTimeout(t);
    }
    if (!isFullscreen) setShowInfo(false);
  }, [isFullscreen]);

  // ── Cleanup: pause video and stop HLS on unmount ──────────────────────
  useEffect(() => {
    const v = videoRef.current;
    return () => {
      if (v) v.pause();
      stopCurrentHls();
    };
  }, [stopCurrentHls]);

  // ── Picture-in-Picture event listeners ────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onEnterPiP = () => setIsPiP(true);
    const onLeavePiP = () => setIsPiP(false);
    v.addEventListener("enterpictureinpicture", onEnterPiP);
    v.addEventListener("leavepictureinpicture", onLeavePiP);
    return () => {
      v.removeEventListener("enterpictureinpicture", onEnterPiP);
      v.removeEventListener("leavepictureinpicture", onLeavePiP);
    };
  }, []);

  // ── AirPlay availability listener ─────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !supportsAirPlay()) return;
    const onAvail = (e: Event) => {
      const evt = e as Event & { availability?: string };
      setAirplayAvailable(evt.availability === "available");
    };
    v.addEventListener("webkitplaybacktargetavailabilitychanged", onAvail);
    return () => {
      v.removeEventListener("webkitplaybacktargetavailabilitychanged", onAvail);
    };
  }, []);

  // ── Apply initial speed to video element ──────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (v && speed !== 1) {
      v.playbackRate = speed;
    }
  }, [speed]);

  // ── Resume position: show indicator ───────────────────────────────────
  useEffect(() => {
    if (resumePosition && resumePosition > 0 && !resumeApplied.current) {
      setShowResumeIndicator(true);
      const t = setTimeout(() => setShowResumeIndicator(false), 3000);
      return () => clearTimeout(t);
    }
  }, [resumePosition]);

  // ── Auto-advance countdown for next episode ───────────────────────────
  useEffect(() => {
    if (autoAdvanceCountdown === null) return;
    if (autoAdvanceCountdown <= 0) {
      setAutoAdvanceCountdown(null);
      onNext?.();
      return;
    }
    const t = setTimeout(() => setAutoAdvanceCountdown((c) => c !== null ? c - 1 : null), 1000);
    return () => clearTimeout(t);
  }, [autoAdvanceCountdown, onNext]);

  // ── Detect active intro/credits chapter ───────────────────────────────
  const activeIntroChapter = useMemo(() => {
    if (chapters.length === 0) return null;
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      const nextStart = i + 1 < chapters.length ? chapters[i + 1].startSeconds : duration;
      if (isIntroChapter(ch.name) && currentTime >= ch.startSeconds && currentTime < nextStart) {
        return { ...ch, endSeconds: nextStart };
      }
    }
    return null;
  }, [chapters, currentTime, duration]);

  const activeCreditsChapter = useMemo(() => {
    if (chapters.length === 0) return null;
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      const nextStart = i + 1 < chapters.length ? chapters[i + 1].startSeconds : duration;
      if (isCreditsChapter(ch.name) && currentTime >= ch.startSeconds && currentTime < nextStart) {
        return { ...ch, endSeconds: nextStart };
      }
    }
    return null;
  }, [chapters, currentTime, duration]);

  // ═══════════════════════════════════════════════════════════════════════
  // CALLBACKS
  // ═══════════════════════════════════════════════════════════════════════

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      setBuffering(true);
      v.play().catch(() => {
        setBuffering(false);
      });
    } else {
      v.pause();
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    const d = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    const v = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    const el = containerRef.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;

    if (document.fullscreenElement || d.webkitFullscreenElement) {
      void (document.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
    } else if (el?.requestFullscreen) {
      void el.requestFullscreen();
    } else if (el?.webkitRequestFullscreen) {
      void el.webkitRequestFullscreen();
    } else if (v?.webkitEnterFullscreen) {
      v.webkitEnterFullscreen();
    }
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  }, []);

  const handleVolumeChange = useCallback((val: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = val;
    setVolume(val);
    if (val > 0 && v.muted) { v.muted = false; setMuted(false); }
  }, []);

  const handleSeek = useCallback((val: number) => {
    const v = videoRef.current;
    if (!v) return;

    if (playbackMode === "transmux" && !transmuxReady) {
      stopCurrentTransmux();
      setHlsSeekOffset(val);
      setCurrentTime(val);
      setPlaybackMode("hls");
      return;
    }

    if (hlsRequired) {
      const videoTarget = val - hlsSeekOffset;
      const elapsedSec = (Date.now() - hlsStartedAt.current) / 1000;
      const estimatedConverted = elapsedSec * 1.2;

      if (videoTarget >= 0 && videoTarget < estimatedConverted) {
        v.currentTime = videoTarget;
        setCurrentTime(val);
      } else {
        setHlsSeekOffset(val);
        setCurrentTime(val);
      }
    } else {
      v.currentTime = val;
      setCurrentTime(val);
    }
  }, [hlsRequired, hlsSeekOffset, playbackMode, transmuxReady, stopCurrentTransmux]);

  const handleError = useCallback(() => {
    if (playbackMode === "direct") {
      setPlaybackMode("transmux");
      return;
    }
    if (playbackMode === "direct-mkv") {
      setPlaybackMode("transmux");
      return;
    }
    if (hlsRequired && hlsRetryCount.current < 1) {
      hlsRetryCount.current += 1;
      setHlsRetry((n) => n + 1);
      return;
    }
    setError(true);
  }, [hlsRequired, playbackMode]);

  // ── Picture-in-Picture toggle ─────────────────────────────────────────
  const togglePiP = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (isPiP) {
        await document.exitPictureInPicture();
      } else {
        // Safari fallback
        const safariV = v as HTMLVideoElement & { webkitSetPresentationMode?: (mode: string) => void };
        if (safariV.webkitSetPresentationMode) {
          safariV.webkitSetPresentationMode("picture-in-picture");
        } else {
          await v.requestPictureInPicture();
        }
      }
    } catch { /* PiP not available or denied */ }
  }, [isPiP]);

  // ── AirPlay toggle ────────────────────────────────────────────────────
  const toggleAirPlay = useCallback(() => {
    const v = videoRef.current as (HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void }) | null;
    v?.webkitShowPlaybackTargetPicker?.();
  }, []);

  // ── Speed change handler ──────────────────────────────────────────────
  const handleSpeedChange = useCallback((s: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = s;
    setSpeed(s);
    saveSpeed(s);
  }, []);

  // ── Quality change handler ────────────────────────────────────────────
  // Values: -1 = auto/default Jellyfin HLS, -2 = direct play, -3 = talome hls
  // Positive values >= 100: index into jfQualities (value - 100)
  // Positive values < 100: HLS.js level index
  const handleQualityChange = useCallback((index: number) => {
    if (index === -2 && jfDirectPlayUrl.current) {
      setJellyfinSrc(jfDirectPlayUrl.current);
      setPlaybackMode("jellyfin");
      setHlsReady(true);
      setCurrentQuality(-2);
      return;
    }
    if (index === -3) {
      setPlaybackMode("hls");
      setCurrentQuality(-3);
      return;
    }
    // Jellyfin quality preset (index >= 100)
    if (index >= 100) {
      const qi = index - 100;
      const q = jfQualities[qi];
      if (q) {
        setHlsSrc(q.url);
        setPlaybackMode("jellyfin-hls");
        setCurrentQuality(index);
      }
      return;
    }
    // Default Jellyfin HLS (-1) or switch from direct play
    if (index === -1 && (playbackMode === "jellyfin" || playbackMode === "direct")) {
      if (jfTranscodeUrl.current) {
        setHlsSrc(jfTranscodeUrl.current);
        setPlaybackMode("jellyfin-hls");
      }
    }
    // HLS.js level switching
    if (hlsRef.current && index < 100) {
      hlsRef.current.currentLevel = index;
    }
    setCurrentQuality(index);
  }, [playbackMode, jfQualities]);

  // ── Skip intro/credits ────────────────────────────────────────────────
  const skipToChapterEnd = useCallback((endSeconds: number) => {
    handleSeek(endSeconds);
  }, [handleSeek]);

  // ── Audio track switch ────────────────────────────────────────────────
  const handleAudioSwitch = useCallback((index: number) => {
    if (index === selectedAudio) return;

    if (!hlsRequired) {
      const v = videoRef.current;
      if (v) {
        const tracks = (v as HTMLVideoElement & { audioTracks?: ArrayLike<{ enabled: boolean }> }).audioTracks;
        if (tracks && tracks.length > 1) {
          for (let i = 0; i < tracks.length; i++) {
            tracks[i].enabled = i === index;
          }
        }
      }
      setSelectedAudio(index);
      return;
    }

    const v = videoRef.current;
    const pos = v ? hlsSeekOffset + (v.currentTime ?? 0) : hlsSeekOffset;
    setHlsSeekOffset(pos);
    setSelectedAudio(index);
  }, [selectedAudio, hlsRequired, hlsSeekOffset]);

  // ── Resume from beginning ─────────────────────────────────────────────
  const startFromBeginning = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    resumeApplied.current = true;
    setResumePosition(null);
    setShowResumeIndicator(false);
    v.currentTime = 0;
    setCurrentTime(0);
  }, []);

  // ── onCanPlay: apply resume position ──────────────────────────────────
  const handleCanPlay = useCallback(() => {
    if (resumePosition && !resumeApplied.current) {
      resumeApplied.current = true;
      const v = videoRef.current;
      if (v) {
        v.currentTime = resumePosition;
        setCurrentTime(resumePosition);
      }
    }
  }, [resumePosition]);

  // ═══════════════════════════════════════════════════════════════════════
  // HLS.js SETUP
  // ═══════════════════════════════════════════════════════════════════════

  const nativeHls = useMemo(() => {
    if (typeof document === "undefined") return true;
    const v = document.createElement("video");
    return v.canPlayType("application/vnd.apple.mpegurl") !== "";
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !hlsRequired || !hlsSrc || nativeHls) return;

    if (!Hls.isSupported()) {
      setError(true);
      return;
    }

    const isJellyfinHls = playbackMode === "jellyfin-hls";
    const hls = new Hls({
      xhrSetup: (xhr) => { xhr.withCredentials = !isJellyfinHls; },
    });
    hlsRef.current = hls;

    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else {
          handleError();
        }
      }
    });

    // Quality levels from HLS manifest
    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      if (data.levels && data.levels.length > 1) {
        const levels: QualityLevel[] = data.levels.map((level, index) => ({
          index,
          height: level.height,
          width: level.width,
          bitrate: level.bitrate,
        }));
        setQualityLevels(levels);
      }
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
      setCurrentQuality(data.level);
    });

    hls.loadSource(hlsSrc);
    hls.attachMedia(v);

    return () => {
      hls.destroy();
      hlsRef.current = null;
      setQualityLevels([]);
      setCurrentQuality(-1);
    };
  }, [hlsRequired, hlsSrc, nativeHls, handleError, playbackMode]);

  // ═══════════════════════════════════════════════════════════════════════
  // KEYBOARD NAVIGATION
  // ═══════════════════════════════════════════════════════════════════════

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const v = videoRef.current;
      if (!v) return;

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      // TV remote Back button (VIDAA/Android TV = 10009, HbbTV = 461)
      if ((e.keyCode === 10009 || e.keyCode === 461) && cinemaMode && onBack) {
        e.preventDefault();
        onBack();
        return;
      }

      const { seekStep, largeSeekStep, volumeStep } = fsSettings.current;

      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          if (v.paused) { void v.play(); } else { v.pause(); }
          resetHideTimer();
          break;
        case "ArrowRight":
          e.preventDefault();
          handleSeek(currentTime + (e.shiftKey ? largeSeekStep : seekStep));
          resetHideTimer();
          break;
        case "ArrowLeft":
          e.preventDefault();
          handleSeek(Math.max(0, currentTime - (e.shiftKey ? largeSeekStep : seekStep)));
          resetHideTimer();
          break;
        case "ArrowUp":
          e.preventDefault();
          handleVolumeChange(Math.min(1, volume + volumeStep));
          resetHideTimer();
          break;
        case "ArrowDown":
          e.preventDefault();
          handleVolumeChange(Math.max(0, volume - volumeStep));
          resetHideTimer();
          break;
        case "+":
        case "=":
          e.preventDefault();
          handleVolumeChange(Math.min(1, volume + volumeStep));
          resetHideTimer();
          break;
        case "-":
          e.preventDefault();
          handleVolumeChange(Math.max(0, volume - volumeStep));
          resetHideTimer();
          break;
        case "m":
          e.preventDefault();
          v.muted = !v.muted;
          setMuted(v.muted);
          resetHideTimer();
          break;
        case "f":
          if (!cinemaMode) {
            e.preventDefault();
            toggleFullscreen();
          }
          break;
        case "Escape":
          e.preventDefault();
          if (cinemaMode && onBack) {
            onBack();
          } else if (isFullscreen) {
            toggleFullscreen();
          }
          break;
        case "i":
          e.preventDefault();
          setShowInfo((prev) => !prev);
          resetHideTimer();
          break;
        case "c":
          e.preventDefault();
          if (subtitleTracks.length > 0) {
            const currentIdx = subtitleTracks.findIndex((s) => s.index === selectedSub);
            if (currentIdx === -1 || currentIdx === subtitleTracks.length - 1) {
              setSelectedSub(selectedSub === null ? subtitleTracks[0].index : null);
            } else {
              setSelectedSub(subtitleTracks[currentIdx + 1].index);
            }
          }
          resetHideTimer();
          break;
        // Picture-in-Picture
        case "p":
          if (!e.shiftKey) {
            e.preventDefault();
            void togglePiP();
            resetHideTimer();
          }
          break;
        // Speed: < decrease, > increase
        case "<":
        case ",": {
          e.preventDefault();
          const curIdx = SPEED_OPTIONS.indexOf(speed as typeof SPEED_OPTIONS[number]);
          if (curIdx > 0) handleSpeedChange(SPEED_OPTIONS[curIdx - 1]);
          resetHideTimer();
          break;
        }
        case ">":
        case ".": {
          e.preventDefault();
          const curIdx = SPEED_OPTIONS.indexOf(speed as typeof SPEED_OPTIONS[number]);
          if (curIdx < SPEED_OPTIONS.length - 1) handleSpeedChange(SPEED_OPTIONS[curIdx + 1]);
          resetHideTimer();
          break;
        }
        // Next episode
        case "n":
          if (onNext) {
            e.preventDefault();
            onNext();
          }
          resetHideTimer();
          break;
        // Previous episode (Shift+P)
        case "P":
          if (e.shiftKey && onPrevious) {
            e.preventDefault();
            onPrevious();
          }
          resetHideTimer();
          break;
        // Skip intro/credits
        case "s":
          e.preventDefault();
          if (activeIntroChapter) {
            skipToChapterEnd(activeIntroChapter.endSeconds);
          } else if (activeCreditsChapter) {
            skipToChapterEnd(activeCreditsChapter.endSeconds);
          }
          resetHideTimer();
          break;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    isFullscreen, currentTime, volume, handleSeek, handleVolumeChange, resetHideTimer,
    toggleFullscreen, subtitleTracks, selectedSub, togglePiP, speed, handleSpeedChange,
    onNext, onPrevious, onBack, cinemaMode, activeIntroChapter, activeCreditsChapter, skipToChapterEnd,
  ]);

  // ═══════════════════════════════════════════════════════════════════════
  // SEEK THUMBNAIL HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  const seekThumbnail = useMemo(() => {
    if (!trickplay || !hoverPos) return null;
    const { width, height, tileWidth, tileHeight, interval, baseUrl } = trickplay;
    const timeMs = hoverPos.value * 1000;
    const tileIndex = Math.floor(timeMs / interval);
    const tilesPerSheet = tileWidth * tileHeight;
    const sheetIndex = Math.floor(tileIndex / tilesPerSheet);
    const indexInSheet = tileIndex % tilesPerSheet;
    const col = indexInSheet % tileWidth;
    const row = Math.floor(indexInSheet / tileWidth);
    return {
      url: `${baseUrl}/${sheetIndex}.jpg?api_key=${jfSessionRef.current?.apiKey ?? ""}`,
      bgX: -(col * width),
      bgY: -(row * height),
      width,
      height,
      sheetWidth: tileWidth * width,
      sheetHeight: tileHeight * height,
    };
  }, [trickplay, hoverPos]);

  // ═══════════════════════════════════════════════════════════════════════
  // LOADING / ERROR STATES
  // ═══════════════════════════════════════════════════════════════════════

  const isProcessing = !error && (playbackMode === "deciding" || (playbackMode === "hls" && !hlsReady) || (playbackMode === "transmux" && !transmuxReady));
  const handleCancelProcessing = useCallback(() => {
    if (playbackMode === "transmux") stopCurrentTransmux();
    else if (playbackMode === "hls") stopCurrentHls();
    if (onBack) {
      onBack();
    } else {
      // Switch to "direct" so transmux/HLS effects clean up (deps change → cancelled=true)
      setPlaybackMode("direct");
      setError(true);
    }
  }, [playbackMode, stopCurrentTransmux, stopCurrentHls, onBack]);

  if (isProcessing) {
    const hasProgress = playbackMode === "transmux" && transmuxProgress > 0;
    const loadingMessage = playbackMode === "deciding" ? "Analyzing" :
      playbackMode === "transmux" ? "Preparing" :
      hlsSeekOffset > 0 ? `Seeking to ${formatTime(hlsSeekOffset)}` :
      "Preparing";
    const radius = 20;
    const circumference = 2 * Math.PI * radius;
    const strokeOffset = circumference * (1 - transmuxProgress);
    return (
      <div className="flex flex-col items-center justify-center gap-4 w-full h-full bg-black">
        <div className="relative size-12">
          {hasProgress ? (
            <svg viewBox="0 0 48 48" className="size-12 -rotate-90">
              <circle cx="24" cy="24" r={radius} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="2" />
              <circle cx="24" cy="24" r={radius} fill="none" stroke="rgba(255,255,255,0.5)"
                strokeWidth="2" strokeLinecap="round"
                strokeDasharray={circumference} strokeDashoffset={strokeOffset}
                style={{ transition: "stroke-dashoffset 1s ease-out" }} />
            </svg>
          ) : (
            <svg viewBox="0 0 48 48" className="size-12 animate-spin" style={{ animationDuration: "1.2s" }}>
              <circle cx="24" cy="24" r={radius} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="2" />
              <circle cx="24" cy="24" r={radius} fill="none" stroke="rgba(255,255,255,0.4)"
                strokeWidth="2" strokeLinecap="round"
                strokeDasharray={circumference} strokeDashoffset={circumference * 0.75} />
            </svg>
          )}
        </div>
        <p className="text-sm text-white/25">
          {loadingMessage}{audioTracks.length > 1 && selectedAudio > 0 ? ` · ${trackLabel(audioTracks[selectedAudio] ?? audioTracks[0], "Audio")}` : ""}
        </p>
        <button
          onClick={handleCancelProcessing}
          className="text-xs text-white/15 hover:text-white/40 transition-colors"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (error) {
    // Determine what recovery options are available
    const canTryJellyfinHls = jfTranscodeUrl.current && playbackMode !== "jellyfin-hls";
    const canTryLocalHls = playbackMode !== "hls";
    const canTryDirectPlay = jfDirectPlayUrl.current && playbackMode !== "jellyfin";
    const jellyfinWebUrl = jfSessionRef.current
      ? `${jfSessionRef.current.jellyfinBaseUrl}/web/#/details?id=${jfSessionRef.current.itemId}`
      : null;

    return (
      <div className="flex flex-col items-center justify-center gap-5 p-8 text-center w-full h-full bg-black">
        {cinemaMode && onBack && (
          <button
            onClick={onBack}
            className="absolute top-6 left-8 flex items-center gap-2.5 px-5 py-2.5 rounded-lg bg-white/10 text-white/70 hover:text-white hover:bg-white/20 transition-colors text-base font-medium"
          >
            <HugeiconsIcon icon={ArrowLeft02Icon} size={20} />
            Back
          </button>
        )}
        <div className="size-16 rounded-full bg-white/5 flex items-center justify-center">
          <HugeiconsIcon icon={PlayIcon} size={24} className="text-white/30" />
        </div>
        <div>
          <p className={cn("font-medium text-white/70", cinemaMode ? "text-lg" : "text-sm")}>
            Playback failed
          </p>
          <p className={cn("text-white/30 mt-1", cinemaMode ? "text-base" : "text-xs")}>
            {probedVideoCodec ? `${probedVideoCodec.toUpperCase()} couldn\u2019t be decoded` : "This format couldn\u2019t be played"} in the current mode.
          </p>
        </div>
        <div className={cn("flex flex-col gap-2", cinemaMode ? "min-w-52" : "min-w-40")}>
          {canTryJellyfinHls && (
            <Button
              variant="outline"
              size={cinemaMode ? "default" : "sm"}
              className="gap-1.5 w-full justify-center"
              onClick={() => {
                setError(false);
                setHlsSrc(jfTranscodeUrl.current);
                setPlaybackMode("jellyfin-hls");
              }}
            >
              Try Jellyfin transcode
            </Button>
          )}
          {canTryLocalHls && (
            <Button
              variant="outline"
              size={cinemaMode ? "default" : "sm"}
              className="gap-1.5 w-full justify-center"
              onClick={() => {
                setError(false);
                setPlaybackMode("hls");
              }}
            >
              Try local transcode
            </Button>
          )}
          {canTryDirectPlay && (
            <Button
              variant="outline"
              size={cinemaMode ? "default" : "sm"}
              className="gap-1.5 w-full justify-center"
              onClick={() => {
                setError(false);
                setJellyfinSrc(jfDirectPlayUrl.current);
                setPlaybackMode("jellyfin");
                setHlsReady(true);
              }}
            >
              Try direct play
            </Button>
          )}
          {jellyfinWebUrl && (
            <Button
              variant="outline"
              size={cinemaMode ? "default" : "sm"}
              className="gap-1.5 w-full justify-center"
              onClick={() => window.open(jellyfinWebUrl, "_blank")}
            >
              Open in Jellyfin
            </Button>
          )}
          <Button
            variant="ghost"
            size={cinemaMode ? "default" : "sm"}
            className="gap-1.5 w-full justify-center text-white/30 hover:text-white/50"
            onClick={() => {
              const a = document.createElement("a");
              a.href = src;
              a.download = fileName;
              a.click();
            }}
          >
            <HugeiconsIcon icon={Download01Icon} size={cinemaMode ? 16 : 12} />
            Download file
          </Button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RENDER — MAIN VIDEO PLAYER
  // ═══════════════════════════════════════════════════════════════════════

  const iconSm = cinemaMode ? 28 : isFullscreen ? 24 : 15;
  const iconMd = cinemaMode ? 36 : isFullscreen ? 32 : 18;
  const btnSize = cinemaMode ? "size-16" : isFullscreen ? "size-14" : "size-8";
  const btnSizeSm = cinemaMode ? "size-14" : isFullscreen ? "size-12" : "size-8";
  const btnHover = (isFullscreen || cinemaMode) ? "hover:bg-white/8 rounded-md transition-all" : "";

  // Current quality label for display
  const currentQualityLabel = (() => {
    if (qualityLevels.length <= 1) return null;
    const level = currentQuality >= 0 ? qualityLevels[currentQuality] : null;
    const heightLabel = level ? `${level.height}p` : null;
    return currentQuality === -1
      ? `Auto${heightLabel ? ` (${heightLabel})` : ""}`
      : heightLabel ?? "Auto";
  })();

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative bg-black select-none group w-full h-full",
        isFullscreen && !showControls && "cursor-none",
      )}
      onMouseMove={resetHideTimer}
      onTouchStart={resetHideTimer}
      tabIndex={0}
      style={{
        "--sub-font-size": SUBTITLE_FONT_SIZES[subStyle.fontSize],
        "--sub-bg-opacity": String(subStyle.bgOpacity),
      } as React.CSSProperties}
    >
      {/* Video surface — click to play/pause */}
      <video
        ref={videoRef}
        src={playbackMode === "jellyfin" ? (jellyfinSrc ?? undefined) : playbackMode === "transmux" ? (transmuxSrc ?? undefined) : playbackMode === "direct-mkv" ? src : hlsRequired && !nativeHls ? undefined : (hlsSrc ?? src)}
        crossOrigin={playbackMode === "jellyfin" || playbackMode === "jellyfin-hls" ? "anonymous" : "use-credentials"}
        preload="metadata"
        playsInline
        // eslint-disable-next-line react/no-unknown-property
        x-webkit-airplay="allow"
        className="w-full h-full object-contain cursor-pointer"
        style={{ fontSize: isFullscreen || cinemaMode ? "2.5rem" : "1.25rem" }}
        onClick={togglePlay}
        onTimeUpdate={() => {
          const video = videoRef.current;
          if (!video) return;
          const t = video.currentTime ?? 0;
          setCurrentTime(hlsRequired ? hlsSeekOffset + t : t);
          // Update buffer position
          if (video.buffered.length > 0) {
            const end = video.buffered.end(video.buffered.length - 1);
            setBufferedEnd(hlsRequired ? hlsSeekOffset + end : end);
          }
        }}
        onLoadedMetadata={() => {
          const d = videoRef.current?.duration ?? 0;
          if (!hlsRequired && isFinite(d) && d > 0) setDuration(d);
        }}
        onDurationChange={() => {
          const d = videoRef.current?.duration ?? 0;
          if (!hlsRequired && isFinite(d) && d > 0) setDuration(d);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => { setPlaying(false); setBuffering(false); }}
        onWaiting={() => { if (!videoRef.current?.paused) setBuffering(true); }}
        onPlaying={() => setBuffering(false)}
        onCanPlay={handleCanPlay}
        onEnded={() => {
          setPlaying(false);
          // Auto-advance to next episode
          if (onNext && nextLabel) {
            setAutoAdvanceCountdown(10);
          } else {
            onEnded?.();
          }
        }}
        onError={handleError}
      >
        {subBlobUrl && (
          <track kind="subtitles" src={subBlobUrl} label="Subtitles" default />
        )}
      </video>

      {/* Buffering spinner */}
      {buffering && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div className={cn(
            "rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center",
            isFullscreen ? "size-20" : "size-10",
          )}>
            <div className={cn(
              "rounded-full border-2 border-white/20 border-t-white/60 animate-spin",
              isFullscreen ? "size-10" : "size-5",
            )} />
          </div>
        </div>
      )}

      {/* ── Resume position indicator ──────────────────────────────────── */}
      {showResumeIndicator && resumePosition && (
        <div className={cn(
          "absolute top-6 inset-x-0 flex justify-center z-30 pointer-events-auto transition-opacity duration-200",
          showResumeIndicator ? "opacity-100" : "opacity-0",
        )}>
          <div className="flex items-center gap-3 px-5 py-2.5 rounded-lg bg-black/70 backdrop-blur-sm">
            <span className="text-sm text-white/80">
              Resuming from {formatTime(resumePosition)}
            </span>
            <button
              onClick={startFromBeginning}
              className="text-sm text-white/50 hover:text-white underline underline-offset-2 transition-colors"
            >
              Start from beginning
            </button>
          </div>
        </div>
      )}

      {/* ── Auto-advance overlay (next episode countdown) ─────────────── */}
      {autoAdvanceCountdown !== null && nextLabel && (
        <div className="absolute inset-0 flex items-center justify-center z-30 bg-black/60">
          <div className="flex flex-col items-center gap-4 p-8 rounded-xl bg-black/80 backdrop-blur-sm max-w-sm">
            <p className="text-sm text-white/50">Up Next</p>
            <p className="text-lg text-white/90 font-medium text-center">{nextLabel}</p>
            <p className="text-2xl text-white/70 tabular-nums">{autoAdvanceCountdown}</p>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setAutoAdvanceCountdown(null);
                  onEnded?.();
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setAutoAdvanceCountdown(null);
                  onNext?.();
                }}
              >
                Play Now
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Skip Intro / Skip Credits floating buttons ────────────────── */}
      {activeIntroChapter && (
        <div className="absolute bottom-28 right-8 z-25">
          <Button
            variant="outline"
            size={isFullscreen ? "default" : "sm"}
            className="bg-black/60 border-white/20 text-white/90 hover:bg-black/80 hover:text-white backdrop-blur-sm"
            onClick={() => skipToChapterEnd(activeIntroChapter.endSeconds)}
          >
            Skip Intro
          </Button>
        </div>
      )}
      {activeCreditsChapter && !activeIntroChapter && (
        <div className="absolute bottom-28 right-8 z-25">
          <Button
            variant="outline"
            size={isFullscreen ? "default" : "sm"}
            className="bg-black/60 border-white/20 text-white/90 hover:bg-black/80 hover:text-white backdrop-blur-sm"
            onClick={() => skipToChapterEnd(activeCreditsChapter.endSeconds)}
          >
            Skip Credits
          </Button>
        </div>
      )}

      {/* ── Top bar — cinema mode: always visible; normal mode: info overlay ── */}
      {(cinemaMode || (isFullscreen && showInfo)) && (
        <div className={cn(
          "absolute inset-x-0 top-0 z-20 transition-opacity duration-200",
          showControls ? "opacity-100" : "opacity-0 pointer-events-none",
        )}>
          <div className="absolute inset-0 bg-gradient-to-b from-black/70 to-transparent pointer-events-none" />
          <div className="relative px-10 pt-8 pb-16">
            <div className="flex items-start justify-between gap-6">
              <div className="flex items-center gap-4 min-w-0 flex-1">
                {cinemaMode && onBack && (
                  <button
                    onClick={onBack}
                    className="shrink-0 flex items-center justify-center size-10 rounded-full bg-white/10 text-white/70 hover:text-white hover:bg-white/20 transition-colors"
                  >
                    <HugeiconsIcon icon={ArrowLeft02Icon} size={20} />
                  </button>
                )}
                <div className="min-w-0">
                  <h2 className={cn(
                    "font-medium text-white/90 truncate leading-tight",
                    cinemaMode ? "text-2xl" : "text-5xl",
                  )}>
                    {fileName.replace(/\.[^.]+$/, "").replace(/[._-]/g, " ")}
                  </h2>
                  {(showInfo || cinemaMode) && (
                    <div className="flex items-center gap-4 flex-wrap mt-1.5">
                      <span className={cn("text-white/50 tabular-nums", cinemaMode ? "text-base" : "text-2xl")}>
                        {formatTime(duration)}
                      </span>
                      {playbackMode !== "direct" && playbackMode !== "direct-mkv" && (
                        <span className={cn("text-white/30 uppercase tracking-wider", cinemaMode ? "text-sm" : "text-lg")}>
                          {playbackMode === "hls" ? "HLS" : "Transmux"}
                        </span>
                      )}
                      {!cinemaMode && audioTracks.length > 1 && (
                        <span className="text-white/30 text-lg">
                          {trackLabel(audioTracks[selectedAudio] ?? audioTracks[0], "Audio")}
                        </span>
                      )}
                      {!cinemaMode && selectedSub !== null && subtitleTracks.length > 0 && (
                        <span className="text-white/30 text-lg">
                          Sub: {trackLabel(subtitleTracks.find((s) => s.index === selectedSub) ?? subtitleTracks[0], "Subtitle")}
                        </span>
                      )}
                      {speed !== 1 && (
                        <span className={cn("text-white/30", cinemaMode ? "text-sm" : "text-lg")}>
                          {speed}x
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Cinema mode: track pickers — top right */}
              {cinemaMode && (audioTracks.length > 1 || subtitleTracks.length > 0) && (
                <div className="flex items-center gap-3 shrink-0">
                  {audioTracks.length > 1 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="flex items-center gap-2.5 px-5 py-2.5 rounded-lg bg-black/50 hover:bg-black/70 transition-colors text-base text-white/70 hover:text-white">
                          <HugeiconsIcon icon={LanguageSkillIcon} size={20} />
                          {trackLabel(audioTracks[selectedAudio] ?? audioTracks[0], "Audio")}
                          {(audioTracks[selectedAudio]?.channels ?? 0) >= 6 && (
                            <span className="text-white/40 text-sm">5.1</span>
                          )}
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" sideOffset={8} className="min-w-48 text-lg" container={isFullscreen || cinemaMode ? containerRef.current : undefined}>
                        <DropdownMenuRadioGroup
                          value={String(selectedAudio)}
                          onValueChange={(v) => handleAudioSwitch(parseInt(v, 10))}
                        >
                          {audioTracks.map((track) => (
                            <DropdownMenuRadioItem key={track.index} value={String(track.index)} className="py-3 pl-10 pr-5 text-base">
                              {trackLabel(track, "Audio")}
                              {track.channels > 0 && (
                                <span className="ml-2 text-muted-foreground">
                                  {track.channels >= 6 ? "5.1" : track.channels >= 8 ? "7.1" : `${track.channels}.0`}
                                </span>
                              )}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  {subtitleTracks.length > 0 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="flex items-center gap-2.5 px-5 py-2.5 rounded-lg bg-black/50 hover:bg-black/70 transition-colors text-base text-white/70 hover:text-white">
                          <HugeiconsIcon icon={SubtitleIcon} size={20} />
                          {selectedSub !== null
                            ? trackLabel(subtitleTracks.find((s) => s.index === selectedSub) ?? subtitleTracks[0], "Subtitle")
                            : "Subtitles off"}
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" sideOffset={8} className="min-w-48 text-lg" container={isFullscreen || cinemaMode ? containerRef.current : undefined}>
                        <DropdownMenuRadioGroup
                          value={selectedSub === null ? "off" : String(selectedSub)}
                          onValueChange={(v) => setSelectedSub(v === "off" ? null : parseInt(v, 10))}
                        >
                          <DropdownMenuRadioItem value="off" className="py-3 pl-10 pr-5 text-base">Off</DropdownMenuRadioItem>
                          {subtitleTracks.map((sub) => (
                            <DropdownMenuRadioItem key={sub.index} value={String(sub.index)} className="py-3 pl-10 pr-5 text-base">
                              {trackLabel(sub, "Subtitle")}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              )}
            </div>
            {!cinemaMode && (
              <p className="text-base text-white/20 mt-2">
                Press <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/40 text-sm font-mono mx-0.5">i</kbd> to toggle info
                {" · "}
                <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/40 text-sm font-mono mx-0.5">c</kbd> subtitles
                {" · "}
                <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/40 text-sm font-mono mx-0.5">p</kbd> PiP
                {" · "}
                <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/40 text-sm font-mono mx-0.5">&lt;&gt;</kbd> speed
                {" · "}
                <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/40 text-sm font-mono mx-0.5">&larr;&rarr;</kbd> seek
                {" · "}
                <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/40 text-sm font-mono mx-0.5">&uarr;&darr;</kbd> volume
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Controls overlay ──────────────────────────────────────────── */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 transition-opacity duration-200 z-20",
          showControls ? "opacity-100" : "opacity-0 pointer-events-none",
        )}
      >
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent pointer-events-none" />

        <div className={cn(
          "relative",
          isFullscreen ? "px-10 pb-10 pt-20" : "px-5 pb-3 pt-6",
        )}>
          {/* Progress bar with seek thumbnails */}
          <div className="relative">
            <MediaSlider
              min={0}
              max={duration || 1}
              step={0.1}
              value={currentTime}
              buffered={bufferedEnd}
              onChange={handleSeek}
              onHoverPosition={trickplay ? setHoverPos : undefined}
              chapters={chapters.length > 1 ? chapters : undefined}
              className={cn(
                "media-slider-overlay w-full",
                isFullscreen ? "mb-5 media-slider-fs" : "mb-3",
              )}
            />
            {/* Seek thumbnail tooltip */}
            {seekThumbnail && hoverPos && (
              <div
                className="absolute bottom-full mb-2 pointer-events-none z-30"
                style={{
                  left: `${hoverPos.clientX - (containerRef.current?.getBoundingClientRect().left ?? 0)}px`,
                  transform: "translateX(-50%)",
                }}
              >
                <div className="rounded overflow-hidden border border-white/20 shadow-lg">
                  <div
                    style={{
                      width: seekThumbnail.width,
                      height: seekThumbnail.height,
                      backgroundImage: `url(${seekThumbnail.url})`,
                      backgroundPosition: `${seekThumbnail.bgX}px ${seekThumbnail.bgY}px`,
                      backgroundSize: `${seekThumbnail.sheetWidth}px ${seekThumbnail.sheetHeight}px`,
                    }}
                  />
                </div>
                <p className="text-xs text-white/80 text-center mt-1 tabular-nums">
                  {formatTime(hoverPos.value)}
                </p>
              </div>
            )}
          </div>

          {/* Controls row */}
          <div className="flex items-center">
            {/* Previous episode (fullscreen/cinema only) */}
            {(isFullscreen || cinemaMode) && onPrevious && (
              <button
                onClick={onPrevious}
                className={cn("flex items-center justify-center text-white/50 hover:text-white transition-colors", btnSizeSm)}
                title={previousLabel ?? "Previous"}
              >
                <HugeiconsIcon icon={PreviousIcon} size={iconSm} />
              </button>
            )}

            {/* Play/pause */}
            <button
              onClick={togglePlay}
              className={cn("flex items-center justify-center text-white/90 hover:text-white transition-colors", btnSize)}
            >
              {buffering ? (
                <div className={cn(
                  "rounded-full border-2 border-white/20 border-t-white/70 animate-spin",
                  isFullscreen ? "size-7" : "size-4",
                )} />
              ) : (
                <HugeiconsIcon icon={playing ? PauseIcon : PlayIcon} size={iconMd} />
              )}
            </button>

            {/* Next episode (fullscreen/cinema only) */}
            {(isFullscreen || cinemaMode) && onNext && (
              <button
                onClick={onNext}
                className={cn("flex items-center justify-center text-white/50 hover:text-white transition-colors", btnSizeSm)}
                title={nextLabel ?? "Next"}
              >
                <HugeiconsIcon icon={NextIcon} size={iconSm} />
              </button>
            )}

            {/* Skip buttons — visible in fullscreen for TV remote users */}
            {isFullscreen && (
              <>
                <button
                  onClick={() => handleSeek(Math.max(0, currentTime - 10))}
                  className={cn("flex items-center justify-center hover:text-white transition-colors", btnSizeSm, cinemaMode ? "text-white/60" : "text-white/50")}
                >
                  <HugeiconsIcon icon={GoBackward15SecIcon} size={iconSm} />
                </button>
                <button
                  onClick={() => handleSeek(currentTime + 10)}
                  className={cn("flex items-center justify-center hover:text-white transition-colors", btnSizeSm, cinemaMode ? "text-white/60" : "text-white/50")}
                >
                  <HugeiconsIcon icon={GoForward15SecIcon} size={iconSm} />
                </button>
              </>
            )}

            {/* Time display */}
            <span className={cn(
              "tabular-nums ml-1",
              cinemaMode ? "text-2xl text-white/70" : isFullscreen ? "text-2xl text-white/50" : "text-xs text-white/40",
            )}>
              {formatTime(currentTime)}
              <span className={cn("mx-1", cinemaMode ? "text-white/30" : "")}>·</span>
              <span className={cinemaMode ? "text-white/40" : ""}>-{formatTime(Math.max(0, duration - currentTime))}</span>
            </span>

            <div className="flex-1" />

            {/* ═══════ Fullscreen/Cinema: individual buttons ═══════ */}
            {(isFullscreen || cinemaMode) && (
              <>
                {/* Info toggle */}
                <button
                  onClick={() => setShowInfo((p) => !p)}
                  className={cn("flex items-center justify-center transition-colors", btnSizeSm, btnHover, showInfo ? "text-white/90" : "text-white/50 hover:text-white")}
                >
                  <HugeiconsIcon icon={InformationCircleIcon} size={iconSm} />
                </button>

                {/* Speed */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className={cn("flex items-center justify-center gap-1 transition-colors", btnSizeSm, btnHover, speed !== 1 ? "text-white/90" : "text-white/50 hover:text-white")}>
                      <HugeiconsIcon icon={DashboardSpeed01Icon} size={iconSm} />
                      <span className={cn("tabular-nums", cinemaMode ? "text-sm text-white/60" : "text-sm text-white/50")}>{speed}x</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" sideOffset={8} className="min-w-24 text-lg" container={isFullscreen || cinemaMode ? containerRef.current : undefined}>
                    <DropdownMenuRadioGroup value={String(speed)} onValueChange={(v) => handleSpeedChange(Number(v))}>
                      {SPEED_OPTIONS.map((s) => (
                        <DropdownMenuRadioItem key={s} value={String(s)}>{s}x</DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Quality */}
                {(isMediaLibrary || hasJfSession || qualityLevels.length > 1) && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button className={cn("flex items-center justify-center gap-1 transition-colors", btnSizeSm, btnHover, "text-white/50 hover:text-white")}>
                        <HugeiconsIcon icon={Settings01Icon} size={iconSm} />
                        <span className={cn("tabular-nums", cinemaMode ? "text-sm text-white/60" : "text-sm text-white/50")}>
                          {currentQuality === -2 ? "Original" : currentQuality === -3 ? "Local" : currentQuality >= 100 ? jfQualities[currentQuality - 100]?.label ?? "" : currentQuality >= 0 ? `${qualityLevels.find((l) => l.index === currentQuality)?.height ?? ""}p` : "Auto"}
                        </span>
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" sideOffset={8} className="min-w-44 text-lg" container={isFullscreen || cinemaMode ? containerRef.current : undefined}>
                      <DropdownMenuRadioGroup value={String(currentQuality)} onValueChange={(v) => handleQualityChange(parseInt(v, 10))}>
                        {jfDirectPlayUrl.current && (
                          <DropdownMenuRadioItem value="-2">Original</DropdownMenuRadioItem>
                        )}
                        {jfQualities.map((q, i) => (
                          <DropdownMenuRadioItem key={`jf-${i}`} value={String(100 + i)}>
                            {q.label}
                            <span className="ml-1.5 text-muted-foreground">{(q.bitrate / 1_000_000).toFixed(0)} Mbps</span>
                          </DropdownMenuRadioItem>
                        ))}
                        {qualityLevels.length > 1 && (
                          <DropdownMenuRadioItem value="-1">Auto</DropdownMenuRadioItem>
                        )}
                        {[...qualityLevels].sort((a, b) => b.height - a.height).map((level) => (
                          <DropdownMenuRadioItem key={level.index} value={String(level.index)}>
                            {level.height}p
                            <span className="ml-1.5 text-muted-foreground">{(level.bitrate / 1_000_000).toFixed(1)} Mbps</span>
                          </DropdownMenuRadioItem>
                        ))}
                        <DropdownMenuRadioItem value="-3">
                          Local
                          <span className="ml-1.5 text-muted-foreground">Talome HLS</span>
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}

                {/* Subtitles (fullscreen — not cinema, cinema has it in top bar) */}
                {!cinemaMode && subtitleTracks.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button className={cn("flex items-center justify-center transition-colors", btnSizeSm, selectedSub !== null ? "text-white/90" : "text-white/50 hover:text-white")}>
                        <HugeiconsIcon icon={SubtitleIcon} size={iconSm} />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" sideOffset={8} className="min-w-36 text-lg" container={isFullscreen || cinemaMode ? containerRef.current : undefined}>
                      <DropdownMenuRadioGroup value={selectedSub === null ? "off" : String(selectedSub)} onValueChange={(v) => setSelectedSub(v === "off" ? null : parseInt(v, 10))}>
                        <DropdownMenuRadioItem value="off">Off</DropdownMenuRadioItem>
                        {subtitleTracks.map((sub) => (
                          <DropdownMenuRadioItem key={sub.index} value={String(sub.index)}>{trackLabel(sub, "Subtitle")}</DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                      <SubtitleStylePicker subStyle={subStyle} onChange={(s) => { setSubStyle(s); saveSubtitleStyle(s); }} />
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}

                {/* Audio */}
                {!cinemaMode && audioTracks.length > 1 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button className={cn("flex items-center justify-center transition-colors", btnSizeSm, selectedAudio > 0 ? "text-white/90" : "text-white/50 hover:text-white")}>
                        <HugeiconsIcon icon={LanguageSkillIcon} size={iconSm} />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" sideOffset={8} className="min-w-36 text-lg" container={isFullscreen || cinemaMode ? containerRef.current : undefined}>
                      <DropdownMenuRadioGroup value={String(selectedAudio)} onValueChange={(v) => handleAudioSwitch(parseInt(v, 10))}>
                        {audioTracks.map((track) => (
                          <DropdownMenuRadioItem key={track.index} value={String(track.index)}>
                            {trackLabel(track, "Audio")}
                            {track.channels > 0 && <span className="ml-1 text-muted-foreground">{track.channels >= 6 ? "5.1" : track.channels >= 8 ? "7.1" : `${track.channels}.0`}</span>}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}

                {/* Volume */}
                <div className={cn("flex items-center", cinemaMode ? "gap-1.5" : "gap-0.5")}>
                  <button onClick={toggleMute} className={cn("flex items-center justify-center hover:text-white transition-colors", btnSizeSm, cinemaMode ? "text-white/70" : "text-white/50")}>
                    <HugeiconsIcon icon={getVolumeIcon({ volume, muted })} size={iconSm} />
                  </button>
                  <MediaSlider min={0} max={1} step={0.01} value={muted ? 0 : volume} onChange={handleVolumeChange} className={cn("media-slider-overlay", cinemaMode ? "w-36" : "w-28")} />
                </div>

                {/* PiP */}
                {pipSupported && (
                  <button onClick={() => void togglePiP()} className={cn("flex items-center justify-center transition-colors", btnSizeSm, btnHover, isPiP ? "text-white/90" : "text-white/50 hover:text-white")}>
                    <HugeiconsIcon icon={isPiP ? PictureInPictureExitIcon : PictureInPictureOnIcon} size={iconSm} />
                  </button>
                )}

                {/* AirPlay */}
                {airplayAvailable && (
                  <button onClick={toggleAirPlay} className={cn("flex items-center justify-center text-white/50 hover:text-white transition-colors", btnSizeSm, btnHover)}>
                    <HugeiconsIcon icon={AirplayLineIcon} size={iconSm} />
                  </button>
                )}
              </>
            )}

            {/* ═══════ Inline (compact/mobile): single settings menu ═══════ */}
            {!isFullscreen && !cinemaMode && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center justify-center size-8 text-white/50 hover:text-white transition-colors">
                    <HugeiconsIcon icon={Settings01Icon} size={15} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={8} className="min-w-44" container={isFullscreen || cinemaMode ? containerRef.current : undefined}>
                  {/* Quality */}
                  {(isMediaLibrary || hasJfSession || qualityLevels.length > 1) && (
                    <>
                      <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground/60 font-medium">Quality</DropdownMenuLabel>
                      <DropdownMenuRadioGroup value={String(currentQuality)} onValueChange={(v) => handleQualityChange(parseInt(v, 10))}>
                        {jfDirectPlayUrl.current && (
                          <DropdownMenuRadioItem value="-2">Original</DropdownMenuRadioItem>
                        )}
                        {jfQualities.map((q, i) => (
                          <DropdownMenuRadioItem key={`jf-${i}`} value={String(100 + i)}>
                            {q.label} <span className="text-muted-foreground ml-1">{(q.bitrate / 1_000_000).toFixed(0)} Mbps</span>
                          </DropdownMenuRadioItem>
                        ))}
                        {qualityLevels.length > 1 && (
                          <DropdownMenuRadioItem value="-1">Auto</DropdownMenuRadioItem>
                        )}
                        {[...qualityLevels].sort((a, b) => b.height - a.height).map((level) => (
                          <DropdownMenuRadioItem key={level.index} value={String(level.index)}>{level.height}p</DropdownMenuRadioItem>
                        ))}
                        <DropdownMenuRadioItem value="-3">Local <span className="text-muted-foreground ml-1">Talome</span></DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                    </>
                  )}

                  {/* Speed */}
                  <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground/60 font-medium">Speed</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={String(speed)} onValueChange={(v) => handleSpeedChange(Number(v))}>
                    {SPEED_OPTIONS.map((s) => (
                      <DropdownMenuRadioItem key={s} value={String(s)}>{s}x</DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>

                  {/* Subtitles */}
                  {subtitleTracks.length > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground/60 font-medium">Subtitles</DropdownMenuLabel>
                      <DropdownMenuRadioGroup value={selectedSub === null ? "off" : String(selectedSub)} onValueChange={(v) => setSelectedSub(v === "off" ? null : parseInt(v, 10))}>
                        <DropdownMenuRadioItem value="off">Off</DropdownMenuRadioItem>
                        {subtitleTracks.map((sub) => (
                          <DropdownMenuRadioItem key={sub.index} value={String(sub.index)}>{trackLabel(sub, "Subtitle")}</DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </>
                  )}

                  {/* Audio */}
                  {audioTracks.length > 1 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground/60 font-medium">Audio</DropdownMenuLabel>
                      <DropdownMenuRadioGroup value={String(selectedAudio)} onValueChange={(v) => handleAudioSwitch(parseInt(v, 10))}>
                        {audioTracks.map((track) => (
                          <DropdownMenuRadioItem key={track.index} value={String(track.index)}>
                            {trackLabel(track, "Audio")}
                            {track.channels > 0 && <span className="ml-1 text-muted-foreground">{track.channels >= 6 ? "5.1" : `${track.channels}.0`}</span>}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </>
                  )}

                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Inline volume control */}
            {!isFullscreen && !cinemaMode && (
              <div className="flex items-center gap-0.5">
                <button onClick={toggleMute} className="flex items-center justify-center size-8 text-white/50 hover:text-white transition-colors">
                  <HugeiconsIcon icon={getVolumeIcon({ volume, muted })} size={15} />
                </button>
                <MediaSlider min={0} max={1} step={0.01} value={muted ? 0 : volume} onChange={handleVolumeChange} className="media-slider-overlay w-20" />
              </div>
            )}

            {/* PiP — always a standalone button, even on mobile */}
            {!isFullscreen && !cinemaMode && pipSupported && (
              <button
                onClick={() => void togglePiP()}
                className={cn("flex items-center justify-center size-8 transition-colors", isPiP ? "text-white/90" : "text-white/50 hover:text-white")}
                aria-label={isPiP ? "Exit Picture-in-Picture" : "Picture-in-Picture"}
              >
                <HugeiconsIcon icon={isPiP ? PictureInPictureExitIcon : PictureInPictureOnIcon} size={15} />
              </button>
            )}

            {/* Fullscreen toggle — hidden in cinema mode */}
            {!cinemaMode && (
              <button
                onClick={toggleFullscreen}
                className={cn("flex items-center justify-center ml-1 text-white/50 hover:text-white transition-colors", btnSizeSm)}
                aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              >
                <HugeiconsIcon icon={isFullscreen ? MinimizeScreenIcon : MaximizeScreenIcon} size={iconSm} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Large centered play button when paused */}
      {!playing && currentTime === 0 && !buffering && (
        <button
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center"
        >
          <div className={cn(
            "rounded-full bg-white/10 backdrop-blur-sm flex items-center justify-center transition-transform hover:scale-105",
            isFullscreen ? "size-28" : "size-16",
          )}>
            <HugeiconsIcon icon={PlayIcon} size={isFullscreen ? 48 : 28} className="text-white/90 ml-1" />
          </div>
        </button>
      )}
    </div>
  );
}

// ── SubtitleStylePicker (inline helper component) ───────────────────────

function SubtitleStylePicker({
  subStyle,
  onChange,
}: {
  subStyle: SubtitleStyle;
  onChange: (style: SubtitleStyle) => void;
}) {
  const fontSizes: { label: string; value: SubtitleFontSize }[] = [
    { label: "S", value: "small" },
    { label: "M", value: "medium" },
    { label: "L", value: "large" },
    { label: "XL", value: "xlarge" },
  ];
  const bgOptions = [
    { label: "0%", value: 0 },
    { label: "25%", value: 0.25 },
    { label: "50%", value: 0.5 },
    { label: "75%", value: 0.75 },
    { label: "100%", value: 1 },
  ];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="w-full text-left px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-sm transition-colors cursor-default">
          Style
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-56 p-4 space-y-4"
      >
        {/* Font size */}
        <div>
          <p className="text-xs text-muted-foreground mb-2">Font size</p>
          <div className="flex gap-1.5">
            {fontSizes.map((fs) => (
              <button
                key={fs.value}
                onClick={() => onChange({ ...subStyle, fontSize: fs.value })}
                className={cn(
                  "flex-1 py-1.5 rounded text-sm text-center transition-colors",
                  subStyle.fontSize === fs.value
                    ? "bg-white/15 text-white"
                    : "bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/70",
                )}
              >
                {fs.label}
              </button>
            ))}
          </div>
        </div>
        {/* Background opacity */}
        <div>
          <p className="text-xs text-muted-foreground mb-2">Background opacity</p>
          <div className="flex gap-1.5">
            {bgOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => onChange({ ...subStyle, bgOpacity: opt.value })}
                className={cn(
                  "flex-1 py-1.5 rounded text-xs text-center transition-colors",
                  subStyle.bgOpacity === opt.value
                    ? "bg-white/15 text-white"
                    : "bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/70",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── AudioPlayer ──────────────────────────────────────────────────────────

export function AudioPlayer({
  src,
  fileName,
  fileIcon,
  fileIconColor,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(() => loadSpeed());
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  // Cleanup: pause on unmount
  useEffect(() => {
    const a = audioRef.current;
    return () => { if (a) a.pause(); };
  }, []);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) { void a.play(); setPlaying(true); }
    else { a.pause(); setPlaying(false); }
  }, []);

  const skip = useCallback((delta: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min(a.duration, a.currentTime + delta));
  }, []);

  const handleSpeedChange = useCallback((s: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.playbackRate = s;
    setSpeed(s);
    saveSpeed(s);
  }, []);

  const toggleMute = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    a.muted = !a.muted;
    setMuted(a.muted);
  }, []);

  const handleSeek = useCallback((val: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = val;
    setCurrentTime(val);
  }, []);

  return (
    <div className="flex flex-col items-center gap-6 p-8">
      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        src={src}
        crossOrigin="use-credentials"
        preload="metadata"
        onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime ?? 0)}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? 0)}
        onEnded={() => setPlaying(false)}
      />

      {/* File icon + name */}
      <div className="flex flex-col items-center gap-4">
        <div className={cn(
          "size-20 rounded-2xl bg-muted/50 flex items-center justify-center",
          fileIconColor,
        )}>
          <HugeiconsIcon icon={fileIcon} size={36} />
        </div>
        <p className="text-sm font-medium text-foreground text-center truncate max-w-full px-4">
          {fileName}
        </p>
      </div>

      {/* Progress */}
      <div className="w-full space-y-1.5">
        <MediaSlider
          min={0}
          max={duration || 1}
          step={0.1}
          value={currentTime}
          onChange={handleSeek}
        />
        <div className="flex justify-between">
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatTime(currentTime)}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatTime(duration)}
          </span>
        </div>
      </div>

      {/* Transport controls */}
      <div className="flex items-center gap-6">
        <button
          onClick={() => skip(-15)}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <HugeiconsIcon icon={GoBackward15SecIcon} size={22} />
        </button>

        <button
          onClick={togglePlay}
          className="size-14 rounded-full bg-muted/50 hover:bg-muted/80 flex items-center justify-center transition-colors"
        >
          <HugeiconsIcon
            icon={playing ? PauseIcon : PlayIcon}
            size={24}
            className={cn("text-foreground", !playing && "ml-0.5")}
          />
        </button>

        <button
          onClick={() => skip(15)}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <HugeiconsIcon icon={GoForward15SecIcon} size={22} />
        </button>
      </div>

      {/* Speed + volume row */}
      <div className="flex items-center justify-between w-full">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1.5 text-xs text-dim-foreground hover:text-muted-foreground transition-colors">
              <HugeiconsIcon icon={DashboardSpeed01Icon} size={14} />
              {speed}x
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-20">
            {SPEED_OPTIONS.map((s) => (
              <DropdownMenuItem
                key={s}
                onClick={() => handleSpeedChange(s)}
                className={cn(s === speed && "font-medium text-foreground")}
              >
                {s}x
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          onClick={toggleMute}
          className="text-dim-foreground hover:text-muted-foreground transition-colors"
        >
          <HugeiconsIcon icon={getVolumeIcon({ volume, muted })} size={16} />
        </button>
      </div>
    </div>
  );
}
