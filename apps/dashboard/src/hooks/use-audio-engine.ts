"use client";

import { useRef, useEffect, useCallback } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  audioPlayerBookAtom,
  audioPlayerErrorAtom,
  audioPlayerStateAtom,
  audioPlayerCommandAtom,
  type AudioPlayerBook,
  type AudioPlayerCommand,
  type AudioPlayerTrackMeta,
  saveAudioState,
  loadAudioState,
  clearAudioState,
} from "@/atoms/audio-player";
import { CORE_URL } from "@/lib/constants";

/* ── Types ─────────────────────────────────────────────── */

interface StreamTrack {
  index: number;
  streamUrl: string;
  duration: number;
}

/* ── Module-level singletons ──────────────────────────── */
// These survive component re-renders AND React strict-mode double-mounts,
// ensuring the audio element is never duplicated or destroyed during navigation.

let _audio: HTMLAudioElement | null = null;
let _currentBook: AudioPlayerBook | null = null;
let _lastSaveTs = 0;
// Playback state preserved across component remounts (stateRef resets on remount)
let _currentTrackIndex = 0;
let _globalTime = 0;
let _isPlaying = false;
let _primedPlayback: Promise<void> | null = null;

function getSharedAudio(): HTMLAudioElement {
  if (!_audio) {
    _audio = new Audio();
    _audio.preload = "metadata";
  }
  return _audio;
}

/**
 * Starts the media element during the originating click, before React effects
 * consume the player command. Browsers require this synchronous user gesture
 * for audible playback, especially when Talome runs inside a desktop iframe.
 */
export function primeAudiobookPlayback(book: AudioPlayerBook, initialTime: number): boolean {
  if (typeof window === "undefined" || book.trackMetas.length === 0) return false;

  let trackIndex = 0;
  let elapsed = 0;
  for (let index = 0; index < book.trackMetas.length; index++) {
    const track = book.trackMetas[index];
    if (initialTime >= elapsed) trackIndex = index;
    elapsed += track?.duration ?? 0;
  }

  const track = book.trackMetas[trackIndex];
  if (!track?.ino) return false;

  const source = `${CORE_URL}/api/audiobooks/file/${encodeURIComponent(book.bookId)}/${encodeURIComponent(track.ino)}`;
  const audio = getSharedAudio();
  const absoluteSource = new URL(source, window.location.href).href;
  if (audio.src !== absoluteSource && audio.currentSrc !== absoluteSource) audio.src = source;
  _primedPlayback = audio.play();
  void _primedPlayback.catch(() => {
    // The engine records and presents the actionable failure after it consumes
    // the load command; avoid an unhandled rejection in this gesture bridge.
  });
  return true;
}

const SAVE_THROTTLE_MS = 3000;
const STALL_NUDGE_DELAY_MS = 3_000;
const STALL_REFRESH_DELAY_MS = 8_000;

function getPlaybackErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    (error instanceof DOMException && error.name === "NotAllowedError") ||
    message.includes("didn't interact with the document")
  ) {
    return "Your browser blocked audio playback. Select Play again to allow sound.";
  }
  return message || "Playback could not start";
}

/* ── Hook ──────────────────────────────────────────────── */

/**
 * Singleton audio engine — call this exactly once in GlobalAudioPlayer.
 * Owns the single <audio> element and processes commands from the atom.
 */
export function useAudioEngine() {
  const streamsRef = useRef<StreamTrack[]>([]);
  const trackOffsetsRef = useRef<number[]>([]);
  const syncTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingSeekRef = useRef<(() => void) | null>(null);
  const loadRequestRef = useRef(0);
  const bookIdRef = useRef<string | null>(null);
  const stateRef = useRef({ isPlaying: false, currentTime: 0, currentTrackIndex: 0 });
  // Track whether we've already restored from localStorage in this mount cycle
  const restoredRef = useRef(false);
  // Holds the latest refreshCurrentStream for use inside event-handler effects
  const refreshFnRef = useRef<(() => Promise<void>) | undefined>(undefined);

  const [command, setCommand] = useAtom(audioPlayerCommandAtom);
  const setBook = useSetAtom(audioPlayerBookAtom);
  const setError = useSetAtom(audioPlayerErrorAtom);
  const setState = useSetAtom(audioPlayerStateAtom);

  /* ── Track offsets ─────────────────────────────────── */

  const computeOffsets = useCallback((tracks: StreamTrack[]) => {
    const offsets: number[] = [];
    for (let i = 0; i < tracks.length; i++) {
      offsets.push(i === 0 ? 0 : offsets[i - 1] + (tracks[i - 1]?.duration ?? 0));
    }
    return offsets;
  }, []);

  /* ── Progress sync ─────────────────────────────────── */

  const flushProgress = useCallback(async (bookId: string, currentTime: number, totalDuration: number, isFinished: boolean) => {
    try {
      await fetch(`${CORE_URL}/api/audiobooks/progress/${bookId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentTime,
          duration: totalDuration,
          progress: totalDuration > 0 ? currentTime / totalDuration : 0,
          isFinished,
        }),
      });
    } catch { /* non-critical */ }
  }, []);

  const startSyncInterval = useCallback((bookId: string, totalDuration: number) => {
    if (syncTimerRef.current) clearInterval(syncTimerRef.current);
    syncTimerRef.current = setInterval(() => {
      if (stateRef.current.isPlaying && totalDuration > 0) {
        flushProgress(bookId, stateRef.current.currentTime, totalDuration, false);
      }
    }, 15000);
  }, [flushProgress]);

  const stopSyncInterval = useCallback(() => {
    if (syncTimerRef.current) {
      clearInterval(syncTimerRef.current);
      syncTimerRef.current = null;
    }
  }, []);

  /* ── localStorage persistence (throttled) ──────────── */

  const persistState = useCallback(() => {
    if (!_currentBook) return;
    const now = Date.now();
    if (now - _lastSaveTs < SAVE_THROTTLE_MS) return;
    _lastSaveTs = now;
    const a = getSharedAudio();
    saveAudioState(_currentBook, {
      currentTime: stateRef.current.currentTime,
      currentTrackIndex: stateRef.current.currentTrackIndex,
      speed: a.playbackRate,
      volume: a.volume,
      muted: a.muted,
    });
  }, []);

  const persistStateImmediate = useCallback(() => {
    if (!_currentBook) return;
    _lastSaveTs = Date.now();
    const a = getSharedAudio();
    saveAudioState(_currentBook, {
      currentTime: stateRef.current.currentTime,
      currentTrackIndex: stateRef.current.currentTrackIndex,
      speed: a.playbackRate,
      volume: a.volume,
      muted: a.muted,
    });
  }, []);

  /* ── Fetch stream URLs ─────────────────────────────── */

  const fetchStreams = useCallback(async (
    bookId: string,
    knownTracks?: AudioPlayerTrackMeta[],
  ): Promise<StreamTrack[]> => {
    if (knownTracks?.length && knownTracks.every((track) => track.ino)) {
      return knownTracks.map((track) => ({
        index: track.index,
        duration: track.duration,
        streamUrl: `${CORE_URL}/api/audiobooks/file/${encodeURIComponent(bookId)}/${encodeURIComponent(track.ino!)}`,
      }));
    }

    // Compatibility path for persisted player state created before file IDs
    // were stored with each track.
    const res = await fetch(`${CORE_URL}/api/audiobooks/stream/${bookId}`);
    if (!res.ok) throw new Error(`Stream request failed (${res.status})`);
    const data = await res.json();
    // Keep audio on the authenticated dashboard origin. The explicit
    // /api/[...path] handler streams the response body and forwards Range
    // headers, so it is safe for media while avoiding a cross-port 401.
    const tracks = (data.tracks as StreamTrack[]).map((t) => ({
      ...t,
      streamUrl: `${CORE_URL}${t.streamUrl}`,
    }));
    if (tracks.length === 0) throw new Error("This audiobook has no playable audio files");
    return tracks;
  }, []);

  /* ── Refresh current stream (recover from expired URLs / stalls) ── */

  const refreshCurrentStream = useCallback(async () => {
    if (!bookIdRef.current || !_currentBook) return;
    const a = getSharedAudio();
    const idx = _currentTrackIndex;
    const localTime = a.currentTime;
    const wasPlaying = _isPlaying;

    try {
      const tracks = await fetchStreams(bookIdRef.current, _currentBook.trackMetas);
      streamsRef.current = tracks;
      trackOffsetsRef.current = computeOffsets(tracks);

      const newSrc = tracks[idx]?.streamUrl;
      if (!newSrc) return;

      // Cancel any pending seek from prior operations
      if (pendingSeekRef.current) {
        a.removeEventListener("loadedmetadata", pendingSeekRef.current);
        pendingSeekRef.current = null;
      }

      a.pause();
      a.src = newSrc;

      const onLoaded = () => {
        a.currentTime = localTime;
        if (wasPlaying) {
          void a.play().catch(() => {
            _isPlaying = false;
            stateRef.current.isPlaying = false;
            setState((prev) => ({ ...prev, isPlaying: false }));
          });
        }
        pendingSeekRef.current = null;
        a.removeEventListener("loadedmetadata", onLoaded);
      };
      pendingSeekRef.current = onLoaded;
      a.addEventListener("loadedmetadata", onLoaded);

      setState((prev) => ({ ...prev, isBuffering: true }));
    } catch { /* stream refresh failed — non-critical */ }
  }, [fetchStreams, computeOffsets, setState]);

  // Keep ref in sync for use in event-handler effects (avoids stale closures)
  refreshFnRef.current = refreshCurrentStream;

  /* ── Seek to global time (multi-track aware) ───────── */

  const seekToGlobalTime = useCallback((globalTime: number) => {
    const a = getSharedAudio();
    const tracks = streamsRef.current;
    const offsets = trackOffsetsRef.current;

    // Cancel pending seek
    if (pendingSeekRef.current) {
      a.removeEventListener("loadedmetadata", pendingSeekRef.current);
      pendingSeekRef.current = null;
    }

    if (tracks.length <= 1) {
      a.currentTime = globalTime;
      stateRef.current.currentTime = globalTime;
      _globalTime = globalTime;
      setState((prev) => ({ ...prev, currentTime: globalTime }));
      return;
    }

    let trackIdx = 0;
    let localTime = globalTime;
    for (let i = 0; i < offsets.length; i++) {
      if (globalTime >= offsets[i]) {
        trackIdx = i;
        localTime = globalTime - offsets[i];
      }
    }

    const wasPlaying = stateRef.current.isPlaying;

    if (trackIdx !== stateRef.current.currentTrackIndex) {
      a.pause();
      stateRef.current.currentTrackIndex = trackIdx;
      _currentTrackIndex = trackIdx;
      const newSrc = tracks[trackIdx]?.streamUrl;
      if (newSrc) a.src = newSrc;

      const onLoaded = () => {
        a.currentTime = localTime;
        pendingSeekRef.current = null;
        if (wasPlaying) void a.play().catch(() => {/* seek recovery — non-critical */});
        a.removeEventListener("loadedmetadata", onLoaded);
      };
      pendingSeekRef.current = onLoaded;
      a.addEventListener("loadedmetadata", onLoaded);
    } else {
      a.currentTime = localTime;
    }

    stateRef.current.currentTime = globalTime;
    _globalTime = globalTime;
    setState((prev) => ({ ...prev, currentTime: globalTime, currentTrackIndex: trackIdx }));
  }, [setState]);

  /* ── Audio element event handlers ──────────────────── */

  useEffect(() => {
    const a = getSharedAudio();
    let stallRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

    const onTimeUpdate = () => {
      const tracks = streamsRef.current;
      const offsets = trackOffsetsRef.current;
      const offset = tracks.length > 1 ? (offsets[stateRef.current.currentTrackIndex] ?? 0) : 0;
      const globalTime = offset + a.currentTime;
      stateRef.current.currentTime = globalTime;
      _globalTime = globalTime;
      _currentTrackIndex = stateRef.current.currentTrackIndex;
      _isPlaying = stateRef.current.isPlaying;
      setState((prev) => ({ ...prev, currentTime: globalTime }));
      // Throttled localStorage save
      persistState();
    };

    const onEnded = () => {
      const tracks = streamsRef.current;
      const idx = stateRef.current.currentTrackIndex;

      if (idx < tracks.length - 1) {
        // Auto-advance to next track. Three subtle points this has to get
        // right — earlier implementations failed at each one:
        //
        //  1. Attach the `loadedmetadata` listener BEFORE assigning `src`.
        //     Cached or fast responses can fire metadata synchronously from
        //     the src setter; a listener added afterwards misses it and the
        //     next track silently stalls.
        //  2. Handle `readyState >= HAVE_METADATA` after attachment — the
        //     event may have already fired in the microtask window.
        //  3. Surface play() rejection instead of swallowing it. Browsers
        //     sometimes lose the user-gesture chain across the `ended` event,
        //     and silently eating the failure makes this look like "auto-
        //     advance is broken" when the real answer is "tap to continue."
        if (pendingSeekRef.current) {
          a.removeEventListener("loadedmetadata", pendingSeekRef.current);
          pendingSeekRef.current = null;
        }
        const nextIdx = idx + 1;
        stateRef.current.currentTrackIndex = nextIdx;
        _currentTrackIndex = nextIdx;
        const nextSrc = tracks[nextIdx]?.streamUrl;
        if (!nextSrc) return;

        const onLoaded = () => {
          a.removeEventListener("loadedmetadata", onLoaded);
          pendingSeekRef.current = null;
          void a.play().catch((err: unknown) => {
            // Browser blocked programmatic play — most likely autoplay policy
            // after a pause across the `ended` transition. Mark us paused so
            // the UI shows a resume control instead of a phantom-playing state.
            console.warn("[audio-engine] autoplay after chapter end blocked:", err);
            stateRef.current.isPlaying = false;
            _isPlaying = false;
            setState((prev) => ({ ...prev, isPlaying: false, isBuffering: false }));
          });
        };

        // Attach listener BEFORE src assignment so we can't miss a fast-fire.
        pendingSeekRef.current = onLoaded;
        a.addEventListener("loadedmetadata", onLoaded);
        a.src = nextSrc;
        a.load(); // Force a fresh load — some browsers skip it if the URL matches the previous value after a proxy rewrite.

        // If metadata already loaded in the microtask window (e.g. the browser
        // had a cached Range response ready), fire our handler manually.
        if (a.readyState >= HTMLMediaElement.HAVE_METADATA) onLoaded();

        setState((prev) => ({ ...prev, currentTrackIndex: nextIdx, isBuffering: true }));
      } else {
        // Final track ended — book finished
        stateRef.current.isPlaying = false;
        _isPlaying = false;
        setState((prev) => ({ ...prev, isPlaying: false }));
        if (bookIdRef.current) {
          const book = bookIdRef.current;
          const offsets = trackOffsetsRef.current;
          const totalDur = offsets.length > 0
            ? offsets[offsets.length - 1] + (tracks[tracks.length - 1]?.duration ?? 0)
            : a.duration;
          flushProgress(book, totalDur, totalDur, true);
        }
        stopSyncInterval();
        clearAudioState();
      }
    };

    const onError = () => {
      const err = a.error;
      // Ignore MEDIA_ERR_SRC_NOT_SUPPORTED when no source is set (intentional reset)
      if (err?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED && !a.src) return;
      // Audio element error — mark as not playing
      stateRef.current.isPlaying = false;
      _isPlaying = false;
      setState((prev) => ({ ...prev, isPlaying: false, isBuffering: false }));
      setError(err?.message || "The audio stream could not be loaded");
      console.warn("[audio-engine] media failed to load:", {
        code: err?.code,
        message: err?.message,
        src: a.currentSrc || a.src,
      });
    };

    const onStalled = () => {
      if (!_isPlaying) return;
      if (stallRecoveryTimer) clearTimeout(stallRecoveryTimer);

      // Phase 1: Nudge browser to re-buffer after a short delay
      stallRecoveryTimer = setTimeout(() => {
        if (!_isPlaying || a.readyState >= 3) return;
        // Re-seek to same position triggers the browser to re-fetch the buffer
        const t = a.currentTime;
        a.currentTime = t;

        // Phase 2: If still stalled, refresh stream URLs (may have expired)
        stallRecoveryTimer = setTimeout(() => {
          if (!_isPlaying || a.readyState >= 3) return;
          refreshFnRef.current?.();
        }, STALL_REFRESH_DELAY_MS - STALL_NUDGE_DELAY_MS);
      }, STALL_NUDGE_DELAY_MS);
    };

    const onWaiting = () => {
      setState((prev) => ({ ...prev, isBuffering: true }));
    };

    const onPlaying = () => {
      // Clear stall recovery — playback recovered naturally
      if (stallRecoveryTimer) {
        clearTimeout(stallRecoveryTimer);
        stallRecoveryTimer = null;
      }
      setState((prev) => ({ ...prev, isBuffering: false }));
    };

    a.addEventListener("timeupdate", onTimeUpdate);
    a.addEventListener("ended", onEnded);
    a.addEventListener("error", onError);
    a.addEventListener("stalled", onStalled);
    a.addEventListener("waiting", onWaiting);
    a.addEventListener("playing", onPlaying);

    return () => {
      if (stallRecoveryTimer) clearTimeout(stallRecoveryTimer);
      a.removeEventListener("timeupdate", onTimeUpdate);
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("error", onError);
      a.removeEventListener("stalled", onStalled);
      a.removeEventListener("waiting", onWaiting);
      a.removeEventListener("playing", onPlaying);
    };
  }, [setError, setState, flushProgress, stopSyncInterval, persistState]);

  /* ── Visibility change handler ─────────────────────── */

  useEffect(() => {
    const handleVisibilityChange = () => {
      const a = getSharedAudio();
      if (document.visibilityState === "visible") {
        // Tab became visible — recover from potential stall
        if (_isPlaying && a.paused && a.src) {
          // Audio was supposed to be playing but paused (browser throttled it)
          void a.play().catch(() => {/* recovery — non-critical */});
        }
        if (_isPlaying && !a.paused && a.readyState < 3) {
          // Buffer is empty — nudge the browser to re-fetch by re-seeking
          const t = a.currentTime;
          a.currentTime = t;
          // If still stalled after nudge, refresh stream URLs
          setTimeout(() => {
            if (_isPlaying && a.readyState < 2) {
              refreshFnRef.current?.();
            }
          }, 3000);
        }
        // Sync Jotai atoms — timeupdate may have been throttled while hidden
        if (_currentBook) {
          setState((prev) => ({
            ...prev,
            currentTime: _globalTime,
            isPlaying: _isPlaying,
            currentTrackIndex: _currentTrackIndex,
          }));
        }
      } else {
        // Tab going to background — flush progress + localStorage
        if (_currentBook && _isPlaying) {
          persistStateImmediate();
          if (bookIdRef.current) {
            const offsets = trackOffsetsRef.current;
            const tracks = streamsRef.current;
            const totalDur = offsets.length > 0
              ? offsets[offsets.length - 1] + (tracks[tracks.length - 1]?.duration ?? 0)
              : 0;
            flushProgress(bookIdRef.current, stateRef.current.currentTime, totalDur, false);
          }
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [setState, flushProgress, persistStateImmediate]);

  /* ── Save on page unload ───────────────────────────── */

  useEffect(() => {
    const handleBeforeUnload = () => {
      persistStateImmediate();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [persistStateImmediate]);

  /* ── Command processor ─────────────────────────────── */

  const processCommand = useCallback(async (cmd: AudioPlayerCommand) => {
    const a = getSharedAudio();

    switch (cmd.type) {
      case "load": {
        const loadRequestId = ++loadRequestRef.current;
        const autoPlay = cmd.autoPlay !== false; // default true
        setError(null);

        // 1. Stop current playback + flush progress
        if (!cmd.playbackPrimed) a.pause();
        if (bookIdRef.current && bookIdRef.current !== cmd.book.bookId) {
          const offsets = trackOffsetsRef.current;
          const tracks = streamsRef.current;
          const totalDur = offsets.length > 0
            ? offsets[offsets.length - 1] + (tracks[tracks.length - 1]?.duration ?? 0)
            : 0;
          await flushProgress(bookIdRef.current, stateRef.current.currentTime, totalDur, false);
        }
        stopSyncInterval();

        // Cancel pending seek from previous book
        if (pendingSeekRef.current) {
          a.removeEventListener("loadedmetadata", pendingSeekRef.current);
          pendingSeekRef.current = null;
        }

        // 2. Set new book
        bookIdRef.current = cmd.book.bookId;
        _currentBook = cmd.book;
        setBook(cmd.book);

        // 3. Fetch streams
        let tracks: StreamTrack[];
        try {
          tracks = await fetchStreams(cmd.book.bookId, cmd.book.trackMetas);
        } catch (error) {
          if (loadRequestId !== loadRequestRef.current) return;
          setError(error instanceof Error ? error.message : "The audiobook stream could not be loaded");
          console.warn("[audio-engine] failed to fetch audiobook streams:", error);
          // Fetch failed — reset state
          bookIdRef.current = null;
          _currentBook = null;
          _isPlaying = false;
          _globalTime = 0;
          _currentTrackIndex = 0;
          setBook(null);
          setState({ isPlaying: false, isBuffering: false, currentTime: 0, currentTrackIndex: 0, speed: 1, volume: a.volume, muted: a.muted });
          return;
        }
        // A newer load (typically the user's Play after a paused restore) owns
        // the engine now. Never let this older async request overwrite it.
        if (loadRequestId !== loadRequestRef.current) return;
        streamsRef.current = tracks;
        trackOffsetsRef.current = computeOffsets(tracks);

        // 4. Determine starting track + local offset
        const offsets = trackOffsetsRef.current;
        let trackIdx = 0;
        let localTime = cmd.initialTime;
        for (let i = 0; i < offsets.length; i++) {
          if (cmd.initialTime >= offsets[i]) {
            trackIdx = i;
            localTime = cmd.initialTime - offsets[i];
          }
        }

        // 5. Load source + seek + optionally play
        const src = tracks[trackIdx]?.streamUrl;
        if (src) {
          const absoluteSrc = new URL(src, window.location.href).href;
          if (a.src !== absoluteSrc && a.currentSrc !== absoluteSrc) a.src = src;
        }

        stateRef.current = { isPlaying: false, currentTime: cmd.initialTime, currentTrackIndex: trackIdx };
        _isPlaying = false;
        _globalTime = cmd.initialTime;
        _currentTrackIndex = trackIdx;

        setState({
          isPlaying: false,
          isBuffering: autoPlay,
          currentTime: cmd.initialTime,
          currentTrackIndex: trackIdx,
          speed: a.playbackRate,
          volume: a.volume,
          muted: a.muted,
        });

        const onLoaded = () => {
          if (localTime > 0) a.currentTime = localTime;
          if (autoPlay && !cmd.playbackPrimed) {
            void a.play().then(() => {
              if (loadRequestId !== loadRequestRef.current) return;
              stateRef.current.isPlaying = true;
              _isPlaying = true;
              setState((prev) => ({ ...prev, isPlaying: true, isBuffering: false }));
              startSyncInterval(cmd.book.bookId, cmd.book.totalDuration);
            }).catch((error: unknown) => {
              stateRef.current.isPlaying = false;
              _isPlaying = false;
              setState((prev) => ({ ...prev, isPlaying: false, isBuffering: false }));
              setError(getPlaybackErrorMessage(error));
              console.warn("[audio-engine] playback could not start:", error);
            });
          }
          a.removeEventListener("loadedmetadata", onLoaded);
        };

        if (a.readyState >= 1) {
          onLoaded();
        } else {
          a.addEventListener("loadedmetadata", onLoaded);
        }

        // A user-gesture-primed play promise resolves only when media has
        // genuinely started. Reflect that real state instead of showing a
        // phantom Pause button while the browser is still waiting or blocked.
        if (autoPlay && cmd.playbackPrimed) {
          const primedPlayback = _primedPlayback;
          _primedPlayback = null;
          if (primedPlayback) {
            void primedPlayback.then(() => {
              if (loadRequestId !== loadRequestRef.current) return;
              stateRef.current.isPlaying = true;
              _isPlaying = true;
              setState((prev) => ({ ...prev, isPlaying: true, isBuffering: false }));
              startSyncInterval(cmd.book.bookId, cmd.book.totalDuration);
            }).catch((error: unknown) => {
              if (loadRequestId !== loadRequestRef.current) return;
              stateRef.current.isPlaying = false;
              _isPlaying = false;
              setState((prev) => ({ ...prev, isPlaying: false, isBuffering: false }));
              setError(getPlaybackErrorMessage(error));
            });
          }
        }

        // 7. Persist to localStorage
        persistStateImmediate();
        break;
      }

      case "play": {
        setError(null);
        // Guard: don't attempt play if no source is loaded
        if (!a.src && !a.currentSrc) {
          setError("The audio source is not ready. Try Play again.");
          break;
        }
        void a.play().then(() => {
          stateRef.current.isPlaying = true;
          _isPlaying = true;
          setState((prev) => ({ ...prev, isPlaying: true }));
          if (bookIdRef.current) {
            const book = bookIdRef.current;
            const offsets = trackOffsetsRef.current;
            const tracks = streamsRef.current;
            const totalDur = offsets.length > 0
              ? offsets[offsets.length - 1] + (tracks[tracks.length - 1]?.duration ?? 0)
              : 0;
            startSyncInterval(book, totalDur);
          }
          persistStateImmediate();
        }).catch((error: unknown) => {
          // Play failed
          stateRef.current.isPlaying = false;
          _isPlaying = false;
          setState((prev) => ({ ...prev, isPlaying: false }));
          setError(getPlaybackErrorMessage(error));
        });
        break;
      }

      case "pause": {
        a.pause();
        stateRef.current.isPlaying = false;
        _isPlaying = false;
        setState((prev) => ({ ...prev, isPlaying: false }));
        stopSyncInterval();
        // Flush progress on pause
        if (bookIdRef.current) {
          const offsets = trackOffsetsRef.current;
          const tracks = streamsRef.current;
          const totalDur = offsets.length > 0
            ? offsets[offsets.length - 1] + (tracks[tracks.length - 1]?.duration ?? 0)
            : 0;
          flushProgress(bookIdRef.current, stateRef.current.currentTime, totalDur, false);
        }
        persistStateImmediate();
        break;
      }

      case "stop": {
        a.pause();
        a.removeAttribute("src");
        // Note: intentionally NOT calling a.load() — that triggers
        // MEDIA_ERR_SRC_NOT_SUPPORTED (code 4) when there's no source.

        // Flush final progress
        if (bookIdRef.current) {
          const offsets = trackOffsetsRef.current;
          const tracks = streamsRef.current;
          const totalDur = offsets.length > 0
            ? offsets[offsets.length - 1] + (tracks[tracks.length - 1]?.duration ?? 0)
            : 0;
          flushProgress(bookIdRef.current, stateRef.current.currentTime, totalDur, false);
        }

        stopSyncInterval();
        bookIdRef.current = null;
        _currentBook = null;
        _isPlaying = false;
        _globalTime = 0;
        _currentTrackIndex = 0;
        streamsRef.current = [];
        trackOffsetsRef.current = [];
        stateRef.current = { isPlaying: false, currentTime: 0, currentTrackIndex: 0 };
        setBook(null);
        setState({ isPlaying: false, isBuffering: false, currentTime: 0, currentTrackIndex: 0, speed: 1, volume: a.volume, muted: a.muted });
        clearAudioState();
        break;
      }

      case "seek": {
        seekToGlobalTime(cmd.time);
        persistStateImmediate();
        break;
      }

      case "speed": {
        a.playbackRate = cmd.speed;
        setState((prev) => ({ ...prev, speed: cmd.speed }));
        persistStateImmediate();
        break;
      }

      case "volume": {
        a.volume = cmd.volume;
        if (cmd.muted !== undefined) a.muted = cmd.muted;
        setState((prev) => ({
          ...prev,
          volume: cmd.volume,
          muted: cmd.muted ?? prev.muted,
        }));
        persistStateImmediate();
        break;
      }
    }
  }, [setBook, setError, setState, flushProgress, fetchStreams, computeOffsets, seekToGlobalTime, startSyncInterval, stopSyncInterval, persistStateImmediate]);

  // Process commands as they arrive
  useEffect(() => {
    if (!command) return;
    setCommand(null); // Consume immediately
    void processCommand(command).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Playback command failed";
      setError(message);
      console.warn("[audio-engine] playback command failed:", error);
    });
  }, [command, setCommand, setError, processCommand]);

  /* ── Restore from localStorage on mount ────────────── */

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    const a = getSharedAudio();

    // Case 1: Module-level singleton is alive (component remounted within same session,
    // e.g. navigating away from /dashboard and back). Sync Jotai atoms + repopulate refs.
    if (_currentBook && a.src) {
      bookIdRef.current = _currentBook.bookId;
      setBook(_currentBook);
      const isPlaying = !a.paused;
      // Restore from module-level state (stateRef was reset on remount)
      stateRef.current = { isPlaying, currentTime: _globalTime, currentTrackIndex: _currentTrackIndex };
      _isPlaying = isPlaying;
      setState({
        isPlaying,
        isBuffering: false,
        currentTime: _globalTime,
        currentTrackIndex: _currentTrackIndex,
        speed: a.playbackRate,
        volume: a.volume,
        muted: a.muted,
      });
      // Re-fetch streams to repopulate this mount's refs
      fetchStreams(_currentBook.bookId, _currentBook.trackMetas).then((tracks) => {
        streamsRef.current = tracks;
        trackOffsetsRef.current = computeOffsets(tracks);
        // Recompute global time from actual audio element now that we have offsets
        const offsets = trackOffsetsRef.current;
        const offset = tracks.length > 1 ? (offsets[_currentTrackIndex] ?? 0) : 0;
        const correctedTime = offset + a.currentTime;
        stateRef.current.currentTime = correctedTime;
        _globalTime = correctedTime;
        setState((prev) => ({ ...prev, currentTime: correctedTime }));
        if (isPlaying && _currentBook) {
          startSyncInterval(_currentBook.bookId, _currentBook.totalDuration);
        }
      }).catch(() => {/* player still works, sync will resume next command */});
      return;
    }

    // Case 2: Fresh page load / new tab — restore from localStorage
    const saved = loadAudioState();
    if (!saved) return;

    // Restore volume/speed/mute before loading the book
    a.playbackRate = saved.speed;
    a.volume = saved.volume;
    a.muted = saved.muted;

    // Load the book in paused state (user presses play to resume)
    processCommand({
      type: "load",
      book: saved.book,
      initialTime: saved.currentTime,
      autoPlay: false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup on unmount — only stop sync interval, do NOT destroy the audio element
  useEffect(() => {
    return () => {
      stopSyncInterval();
      if (pendingSeekRef.current) {
        const a = getSharedAudio();
        a.removeEventListener("loadedmetadata", pendingSeekRef.current);
      }
      // Persist final state so next mount can restore
      persistStateImmediate();
    };
  }, [stopSyncInterval, persistStateImmediate]);

  return { seekToGlobalTime };
}
