import { atom } from "jotai";

/* ── Types ─────────────────────────────────────────────── */

export interface AudioPlayerChapter {
  id: number;
  start: number;
  end: number;
  title: string;
}

export interface AudioPlayerTrackMeta {
  index: number;
  duration: number;
}

export interface AudioPlayerBook {
  bookId: string;
  title: string;
  author: string;
  coverUrl: string;
  chapters: AudioPlayerChapter[];
  trackMetas: AudioPlayerTrackMeta[];
  totalDuration: number;
}

export interface AudioPlayerState {
  isPlaying: boolean;
  isBuffering: boolean;
  currentTime: number;
  currentTrackIndex: number;
  speed: number;
  volume: number;
  muted: boolean;
}

export type AudioPlayerCommand =
  | { type: "load"; book: AudioPlayerBook; initialTime: number; autoPlay?: boolean }
  | { type: "play" }
  | { type: "pause" }
  | { type: "stop" }
  | { type: "seek"; time: number }
  | { type: "speed"; speed: number }
  | { type: "volume"; volume: number; muted?: boolean };

/* ── Atoms ─────────────────────────────────────────────── */

/** The currently loaded audiobook identity, or null when nothing is loaded. */
export const audioPlayerBookAtom = atom<AudioPlayerBook | null>(null);

/** Frequently-changing playback state (subscribed by player UI). */
export const audioPlayerStateAtom = atom<AudioPlayerState>({
  isPlaying: false,
  isBuffering: false,
  currentTime: 0,
  currentTrackIndex: 0,
  speed: 1,
  volume: 1,
  muted: false,
});

/** One-shot command atom — written by pages, consumed by the audio engine. */
export const audioPlayerCommandAtom = atom<AudioPlayerCommand | null>(null);

/** Whether the mini-player bar is visible (derived from book + route). */
export const miniPlayerVisibleAtom = atom(false);

/* ── localStorage persistence ─────────────────────────── */

const AUDIO_STORAGE_KEY = "talome-audio-player";

export interface PersistedAudioState {
  book: AudioPlayerBook;
  currentTime: number;
  currentTrackIndex: number;
  speed: number;
  volume: number;
  muted: boolean;
  timestamp: number;
}

export function saveAudioState(
  book: AudioPlayerBook,
  state: { currentTime: number; currentTrackIndex: number; speed: number; volume: number; muted: boolean },
): void {
  try {
    const data: PersistedAudioState = { book, ...state, timestamp: Date.now() };
    localStorage.setItem(AUDIO_STORAGE_KEY, JSON.stringify(data));
  } catch { /* quota exceeded or SSR */ }
}

export function loadAudioState(): PersistedAudioState | null {
  try {
    const raw = localStorage.getItem(AUDIO_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedAudioState;
    // Expire after 7 days
    if (Date.now() - data.timestamp > 7 * 24 * 60 * 60 * 1000) {
      localStorage.removeItem(AUDIO_STORAGE_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function clearAudioState(): void {
  try {
    localStorage.removeItem(AUDIO_STORAGE_KEY);
  } catch { /* SSR */ }
}
