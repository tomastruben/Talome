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
import {
  createAudioAttemptUrl,
  isAudioSourceCurrent,
  normalizeAudioSource,
} from "@/lib/audio-source";

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
// The listener's intent is distinct from the media element's current state.
// play() can still be pending while Safari reports a source error and Talome
// swaps in a recovery URL. Keeping this outside React also lets the intent
// survive route/window remounts and physical chapter-file boundaries.
let _playbackDesired = false;
let _primedPlayback: Promise<void> | null = null;
let _mediaRecoveryKey: string | null = null;
let _audioSourceAttempt = 0;
let _expectedAudioSource: string | null = null;

function assignAudioSource(audio: HTMLAudioElement, source: string, fresh = true): string {
  const baseUrl = typeof window === "undefined" ? "http://localhost" : window.location.href;
  const nextSource = fresh
    ? createAudioAttemptUrl(source, baseUrl, `${Date.now()}-${++_audioSourceAttempt}`)
    : normalizeAudioSource(source, baseUrl);
  _expectedAudioSource = nextSource;
  audio.src = nextSource;
  return nextSource;
}

function currentAudioSourceBelongsToLatestAttempt(audio: HTMLAudioElement): boolean {
  if (!_expectedAudioSource || typeof window === "undefined") return true;
  const currentSource = audio.currentSrc || audio.src;
  return !currentSource || isAudioSourceCurrent(currentSource, _expectedAudioSource, window.location.href);
}

function getSharedAudio(): HTMLAudioElement {
  if (!_audio) {
    _audio = new Audio();
    _audio.preload = "metadata";
    _audio.setAttribute("playsinline", "");
  }
  return _audio;
}

function updateMediaSessionMetadata(book: AudioPlayerBook): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: book.title,
    artist: book.author,
    album: "Talome Audiobooks",
    artwork: book.coverUrl ? [{ src: book.coverUrl }] : [],
  });
}

function updateMediaSessionState(state: MediaSessionPlaybackState): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  navigator.mediaSession.playbackState = state;
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
  audio.autoplay = true;
  _playbackDesired = true;
  _mediaRecoveryKey = null;
  // A failed HTMLMediaElement cannot reliably be revived by calling play()
  // with the same URL in Safari. A new attempt URL also prevents a cached,
  // incomplete Range response from being reused.
  assignAudioSource(audio, source);
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
  if (
    (error instanceof DOMException && error.name === "NotSupportedError") ||
    message.includes("MEDIA_ELEMENT_ERROR") ||
    message.includes("Format error")
  ) {
    return "This chapter could not be decoded. Select Play to request a fresh stream.";
  }
  return message || "Playback could not start";
}

function isSupersededPlayback(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
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
  const refreshFnRef = useRef<(() => Promise<boolean>) | undefined>(undefined);

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

  const refreshCurrentStream = useCallback(async (): Promise<boolean> => {
    if (!bookIdRef.current || !_currentBook) return false;
    const a = getSharedAudio();
    const idx = _currentTrackIndex;
    const localTime = a.currentTime;
    // A media error commonly arrives before the original play() promise has
    // resolved, so `_isPlaying` alone loses the user's intent. Preserve it
    // through the source swap to make the retry audible and to keep chapter
    // changes playing while the page is backgrounded.
    const shouldResume = _playbackDesired || _isPlaying;

    try {
      const tracks = await fetchStreams(bookIdRef.current, _currentBook.trackMetas);
      streamsRef.current = tracks;
      trackOffsetsRef.current = computeOffsets(tracks);

      const streamUrl = tracks[idx]?.streamUrl;
      if (!streamUrl) return false;

      // Cancel any pending seek from prior operations
      if (pendingSeekRef.current) {
        a.removeEventListener("loadedmetadata", pendingSeekRef.current);
        pendingSeekRef.current = null;
      }

      a.pause();
      a.autoplay = shouldResume;
      const ownedSource = assignAudioSource(a, streamUrl);

      const onLoaded = () => {
        if (!isAudioSourceCurrent(a.currentSrc || a.src, ownedSource, window.location.href)) return;
        a.currentTime = localTime;
        if (shouldResume) {
          void a.play().catch((error: unknown) => {
            if (_mediaRecoveryKey && isSupersededPlayback(error)) return;
            _playbackDesired = false;
            _isPlaying = false;
            stateRef.current.isPlaying = false;
            setState((prev) => ({ ...prev, isPlaying: false }));
            setError(getPlaybackErrorMessage(error));
          });
        }
        pendingSeekRef.current = null;
        a.removeEventListener("loadedmetadata", onLoaded);
      };
      pendingSeekRef.current = onLoaded;
      a.addEventListener("loadedmetadata", onLoaded);

      setState((prev) => ({ ...prev, isBuffering: true }));
      return true;
    } catch {
      return false;
    }
  }, [fetchStreams, computeOffsets, setError, setState]);

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
      if ("mediaSession" in navigator && _currentBook?.totalDuration) {
        try {
          navigator.mediaSession.setPositionState({
            duration: _currentBook.totalDuration,
            playbackRate: a.playbackRate,
            position: Math.min(globalTime, Math.max(0, _currentBook.totalDuration - 0.01)),
          });
        } catch { /* browser may reject position updates during a source swap */ }
      }
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

    const wasPlaying = stateRef.current.isPlaying || _playbackDesired;

    if (trackIdx !== stateRef.current.currentTrackIndex) {
      a.pause();
      a.autoplay = wasPlaying;
      stateRef.current.currentTrackIndex = trackIdx;
      _currentTrackIndex = trackIdx;
      const newSrc = tracks[trackIdx]?.streamUrl;
      const ownedSource = newSrc ? assignAudioSource(a, newSrc) : null;

      const onLoaded = () => {
        if (ownedSource && !isAudioSourceCurrent(a.currentSrc || a.src, ownedSource, window.location.href)) return;
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
        // Auto-advance to the next physical file while preserving the user's
        // continuous-play intent, including when the page is backgrounded.
        if (pendingSeekRef.current) {
          a.removeEventListener("loadedmetadata", pendingSeekRef.current);
          pendingSeekRef.current = null;
        }
        const nextIdx = idx + 1;
        stateRef.current.currentTrackIndex = nextIdx;
        _currentTrackIndex = nextIdx;
        const nextSrc = tracks[nextIdx]?.streamUrl;
        if (!nextSrc) return;

        // Keep the continuous-play intent on the media element itself and
        // call play() from the ended event. Waiting for loadedmetadata can
        // lose the gesture chain while mobile Safari is in the background.
        a.autoplay = true;
        _playbackDesired = true;
        assignAudioSource(a, nextSrc);
        a.load();
        void a.play().catch((err: unknown) => {
          console.warn("[audio-engine] autoplay after chapter end blocked:", err);
          _playbackDesired = false;
          stateRef.current.isPlaying = false;
          _isPlaying = false;
          setState((prev) => ({ ...prev, isPlaying: false, isBuffering: false }));
          setError(getPlaybackErrorMessage(err));
        });

        setState((prev) => ({ ...prev, currentTrackIndex: nextIdx, isBuffering: true }));
      } else {
        // Final track ended — book finished
        stateRef.current.isPlaying = false;
        _isPlaying = false;
        _playbackDesired = false;
        a.autoplay = false;
        updateMediaSessionState("none");
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
      // Source changes are asynchronous. Safari may dispatch the old source's
      // terminal error after a newer chapter/attempt already owns the element.
      // Do not let that stale event consume the new source's single retry.
      if (!currentAudioSourceBelongsToLatestAttempt(a)) return;
      // Ignore MEDIA_ERR_SRC_NOT_SUPPORTED when no source is set (intentional reset)
      if (err?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED && !a.src) return;
      const recoveryKey = `${bookIdRef.current ?? "unknown"}:${stateRef.current.currentTrackIndex}`;
      const isRecoverableFormatError = err?.code === MediaError.MEDIA_ERR_DECODE
        || err?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;

      // Safari can retain a stale or mismatched Range response across chapter
      // source changes. Retry this chapter once with a unique URL before
      // surfacing a failure to the listener.
      if (isRecoverableFormatError && _mediaRecoveryKey !== recoveryKey) {
        _mediaRecoveryKey = recoveryKey;
        setError(null);
        setState((prev) => ({ ...prev, isBuffering: true }));
        void refreshFnRef.current?.().then((started) => {
          if (!started) {
            _playbackDesired = false;
            stateRef.current.isPlaying = false;
            _isPlaying = false;
            setState((prev) => ({ ...prev, isPlaying: false, isBuffering: false }));
            setError("This chapter could not be reloaded. Select Play to try again.");
          }
        });
        return;
      }

      // Audio element error — mark as not playing after recovery was exhausted.
      stateRef.current.isPlaying = false;
      _isPlaying = false;
      _playbackDesired = false;
      updateMediaSessionState("paused");
      setState((prev) => ({ ...prev, isPlaying: false, isBuffering: false }));
      setError(isRecoverableFormatError
        ? "This chapter could not be decoded. Select Play to request a fresh stream."
        : "The audio stream could not be loaded.");
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
          void refreshFnRef.current?.();
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
      _mediaRecoveryKey = null;
      _playbackDesired = true;
      updateMediaSessionState("playing");
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
              void refreshFnRef.current?.();
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
        _mediaRecoveryKey = null;
        _playbackDesired = autoPlay;
        a.autoplay = autoPlay;
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
        updateMediaSessionMetadata(cmd.book);

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
          _playbackDesired = false;
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
        // The synchronous gesture bridge already selected and started this
        // exact track. Reassigning its URL here aborts the primed play promise
        // and can expose WebKit's stale decode state. Unprimed restores still
        // receive a fresh, independently cacheable attempt URL.
        const ownedSource = cmd.playbackPrimed
          ? _expectedAudioSource
          : (src ? assignAudioSource(a, src) : null);

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
          if (loadRequestId !== loadRequestRef.current) {
            a.removeEventListener("loadedmetadata", onLoaded);
            return;
          }
          if (ownedSource && !isAudioSourceCurrent(a.currentSrc || a.src, ownedSource, window.location.href)) return;
          if (localTime > 0) a.currentTime = localTime;
          if (autoPlay && !cmd.playbackPrimed) {
            void a.play().then(() => {
              if (loadRequestId !== loadRequestRef.current) return;
              stateRef.current.isPlaying = true;
              _isPlaying = true;
              setState((prev) => ({ ...prev, isPlaying: true, isBuffering: false }));
              startSyncInterval(cmd.book.bookId, cmd.book.totalDuration);
            }).catch((error: unknown) => {
              if (_mediaRecoveryKey) return;
              _playbackDesired = false;
              stateRef.current.isPlaying = false;
              _isPlaying = false;
              setState((prev) => ({ ...prev, isPlaying: false, isBuffering: false }));
              setError(getPlaybackErrorMessage(error));
              console.warn("[audio-engine] playback could not start:", error);
            });
          }
          a.removeEventListener("loadedmetadata", onLoaded);
        };

        const ownedSourceIsReady = !ownedSource
          || isAudioSourceCurrent(a.currentSrc || a.src, ownedSource, window.location.href);
        if (a.readyState >= 1 && ownedSourceIsReady) {
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
              // The source recovery owns playback now. The rejected promise
              // belongs to the URL that the media-error handler replaced.
              if (_mediaRecoveryKey) return;
              _playbackDesired = false;
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
        _mediaRecoveryKey = null;
        _playbackDesired = true;
        setError(null);
        a.autoplay = true;
        // Guard: don't attempt play if no source is loaded
        if (!a.src && !a.currentSrc) {
          _playbackDesired = false;
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
          if (_mediaRecoveryKey) return;
          // Play failed
          _playbackDesired = false;
          stateRef.current.isPlaying = false;
          _isPlaying = false;
          setState((prev) => ({ ...prev, isPlaying: false }));
          setError(getPlaybackErrorMessage(error));
        });
        break;
      }

      case "pause": {
        _playbackDesired = false;
        a.autoplay = false;
        a.pause();
        updateMediaSessionState("paused");
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
        _playbackDesired = false;
        a.autoplay = false;
        a.pause();
        updateMediaSessionState("none");
        a.removeAttribute("src");
        _expectedAudioSource = null;
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

  /* ── OS / lock-screen media controls ──────────────── */

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    const register = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch { /* action unsupported by this browser */ }
    };

    register("play", () => setCommand({ type: "play" }));
    register("pause", () => setCommand({ type: "pause" }));
    register("seekbackward", (details) => setCommand({
      type: "seek",
      time: Math.max(0, _globalTime - (details.seekOffset ?? 15)),
    }));
    register("seekforward", (details) => setCommand({
      type: "seek",
      time: Math.min(_currentBook?.totalDuration ?? _globalTime, _globalTime + (details.seekOffset ?? 15)),
    }));
    register("seekto", (details) => {
      if (typeof details.seekTime === "number") setCommand({ type: "seek", time: details.seekTime });
    });
    register("previoustrack", () => {
      const chapters = _currentBook?.chapters ?? [];
      const index = chapters.findIndex((chapter) => _globalTime >= chapter.start && _globalTime < chapter.end);
      const current = index >= 0 ? chapters[index] : undefined;
      const target = current && _globalTime - current.start > 3
        ? current
        : chapters[Math.max(0, index - 1)];
      if (target) setCommand({ type: "seek", time: target.start });
    });
    register("nexttrack", () => {
      const chapters = _currentBook?.chapters ?? [];
      const index = chapters.findIndex((chapter) => _globalTime >= chapter.start && _globalTime < chapter.end);
      const target = chapters[Math.min(chapters.length - 1, Math.max(0, index + 1))];
      if (target) setCommand({ type: "seek", time: target.start });
    });

    return () => {
      for (const action of ["play", "pause", "seekbackward", "seekforward", "seekto", "previoustrack", "nexttrack"] as MediaSessionAction[]) {
        register(action, null);
      }
    };
  }, [setCommand]);

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
