import type {
  AudioPlayerBook,
  AudioPlayerState,
} from "@/atoms/audio-player";

export type DesktopAudiobookCommand =
  | { type: "play" }
  | { type: "pause" }
  | { type: "stop" };

export interface DesktopAudiobookStateMessage {
  type: "talome:desktop-audiobook-state";
  book: AudioPlayerBook | null;
  state: AudioPlayerState;
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isString(value: unknown, maximumLength = 4096): value is string {
  return typeof value === "string" && value.length <= maximumLength;
}

function isAudioPlayerBook(value: unknown): value is AudioPlayerBook {
  if (
    !isRecord(value)
    || !isString(value.bookId, 256)
    || !isString(value.title, 1024)
    || !isString(value.author, 1024)
    || !isString(value.coverUrl)
    || !isFiniteNumber(value.totalDuration)
    || value.totalDuration < 0
    || !Array.isArray(value.chapters)
    || value.chapters.length > 10_000
    || !Array.isArray(value.trackMetas)
    || value.trackMetas.length > 10_000
  ) {
    return false;
  }

  const chaptersValid = value.chapters.every((chapter) => (
    isRecord(chapter)
    && isFiniteNumber(chapter.id)
    && isFiniteNumber(chapter.start)
    && isFiniteNumber(chapter.end)
    && isString(chapter.title, 1024)
  ));
  const tracksValid = value.trackMetas.every((track) => (
    isRecord(track)
    && isFiniteNumber(track.index)
    && isFiniteNumber(track.duration)
    && (track.ino === undefined || isString(track.ino, 512))
  ));
  return chaptersValid && tracksValid;
}

function isAudioPlayerState(value: unknown): value is AudioPlayerState {
  return (
    isRecord(value)
    && typeof value.isPlaying === "boolean"
    && typeof value.isBuffering === "boolean"
    && isFiniteNumber(value.currentTime)
    && value.currentTime >= 0
    && isFiniteNumber(value.currentTrackIndex)
    && value.currentTrackIndex >= 0
    && isFiniteNumber(value.speed)
    && value.speed > 0
    && isFiniteNumber(value.volume)
    && value.volume >= 0
    && value.volume <= 1
    && typeof value.muted === "boolean"
  );
}

export function parseDesktopAudiobookStateMessage(
  value: unknown,
): DesktopAudiobookStateMessage | null {
  if (
    !isRecord(value)
    || value.type !== "talome:desktop-audiobook-state"
    || (value.book !== null && !isAudioPlayerBook(value.book))
    || !isAudioPlayerState(value.state)
    || (value.error !== null && !isString(value.error, 2048))
  ) {
    return null;
  }

  return {
    type: "talome:desktop-audiobook-state",
    book: value.book as AudioPlayerBook | null,
    state: value.state,
    error: value.error as string | null,
  };
}

export function parseDesktopAudiobookCommandMessage(
  value: unknown,
): DesktopAudiobookCommand | null {
  if (!isRecord(value) || value.type !== "talome:desktop-audiobook-command") {
    return null;
  }
  if (value.command !== "play" && value.command !== "pause" && value.command !== "stop") {
    return null;
  }
  return { type: value.command };
}
