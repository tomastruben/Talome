"use client";

import { useAtomValue, useSetAtom } from "jotai";
import {
  audioPlayerBookAtom,
  audioPlayerStateAtom,
  audioPlayerCommandAtom,
  type AudioPlayerBook,
} from "@/atoms/audio-player";

/**
 * Convenience hook for pages/widgets to interact with the global audiobook player.
 * Read state from atoms, dispatch commands via the command atom.
 */
export function useAudiobookPlayer() {
  const book = useAtomValue(audioPlayerBookAtom);
  const state = useAtomValue(audioPlayerStateAtom);
  const setCommand = useSetAtom(audioPlayerCommandAtom);

  const loadBook = (payload: AudioPlayerBook, initialTime: number) =>
    setCommand({ type: "load", book: payload, initialTime });

  const seekTo = (time: number) =>
    setCommand({ type: "seek", time });

  const togglePlay = () =>
    setCommand({ type: state.isPlaying ? "pause" : "play" });

  const play = () => setCommand({ type: "play" });
  const pause = () => setCommand({ type: "pause" });
  const stop = () => setCommand({ type: "stop" });

  const setSpeed = (speed: number) =>
    setCommand({ type: "speed", speed });

  const setVolume = (volume: number, muted?: boolean) =>
    setCommand({ type: "volume", volume, muted });

  return {
    book,
    state,
    isActive: book !== null,
    isActiveBook: (bookId: string) => book?.bookId === bookId,
    loadBook,
    seekTo,
    togglePlay,
    play,
    pause,
    stop,
    setSpeed,
    setVolume,
  };
}
