import { describe, expect, it } from "vitest";
import {
  parseDesktopAudiobookCommandMessage,
  parseDesktopAudiobookStateMessage,
} from "@/atoms/desktop-audiobook-player";

const state = {
  isPlaying: true,
  isBuffering: false,
  currentTime: 23,
  currentTrackIndex: 0,
  speed: 1,
  volume: 0.8,
  muted: false,
};

const book = {
  bookId: "book-1",
  title: "The Creative Act",
  author: "Rick Rubin",
  coverUrl: "/api/audiobooks/book-1/cover",
  chapters: [{ id: 1, start: 0, end: 90, title: "Introduction" }],
  trackMetas: [{ index: 0, duration: 90, ino: "track-1" }],
  totalDuration: 90,
};

describe("desktop audiobook player messages", () => {
  it("accepts a complete playback state", () => {
    expect(parseDesktopAudiobookStateMessage({
      type: "talome:desktop-audiobook-state",
      book,
      state,
      error: null,
    })).toEqual({
      type: "talome:desktop-audiobook-state",
      book,
      state,
      error: null,
    });
  });

  it("accepts an empty playback state", () => {
    expect(parseDesktopAudiobookStateMessage({
      type: "talome:desktop-audiobook-state",
      book: null,
      state: { ...state, isPlaying: false, currentTime: 0 },
      error: null,
    })).not.toBeNull();
  });

  it("rejects malformed playback state", () => {
    expect(parseDesktopAudiobookStateMessage({
      type: "talome:desktop-audiobook-state",
      book,
      state: { ...state, currentTime: Number.NaN },
      error: null,
    })).toBeNull();
    expect(parseDesktopAudiobookStateMessage({
      type: "talome:desktop-audiobook-state",
      book: { ...book, chapters: "invalid" },
      state,
      error: null,
    })).toBeNull();
  });

  it("accepts only supported playback commands", () => {
    for (const command of ["play", "pause", "stop"] as const) {
      expect(parseDesktopAudiobookCommandMessage({
        type: "talome:desktop-audiobook-command",
        command,
      })).toEqual({ type: command });
    }
    expect(parseDesktopAudiobookCommandMessage({
      type: "talome:desktop-audiobook-command",
      command: "seek",
    })).toBeNull();
  });
});
