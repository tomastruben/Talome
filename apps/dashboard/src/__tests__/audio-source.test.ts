import { describe, expect, it } from "vitest";
import {
  AUDIO_ATTEMPT_PARAM,
  createAudioAttemptUrl,
  isAudioSourceCurrent,
} from "@/lib/audio-source";

describe("audiobook source attempts", () => {
  const baseUrl = "http://localhost:3000/dashboard/audiobooks/book-1";

  it("creates a unique same-origin URL while preserving existing parameters", () => {
    const first = new URL(createAudioAttemptUrl("/api/audiobooks/file/book-1/10?quality=original", baseUrl, "1"));
    const second = new URL(createAudioAttemptUrl("/api/audiobooks/file/book-1/10?quality=original", baseUrl, "2"));

    expect(first.origin).toBe("http://localhost:3000");
    expect(first.searchParams.get("quality")).toBe("original");
    expect(first.searchParams.get(AUDIO_ATTEMPT_PARAM)).toBe("1");
    expect(second.href).not.toBe(first.href);
  });

  it("compares relative and absolute forms of the same attempt URL", () => {
    expect(isAudioSourceCurrent(
      "/api/audiobooks/file/book-1/10?talome_audio_attempt=3",
      "http://localhost:3000/api/audiobooks/file/book-1/10?talome_audio_attempt=3",
      baseUrl,
    )).toBe(true);
  });

  it("does not treat an earlier attempt as the current source", () => {
    expect(isAudioSourceCurrent(
      "/api/audiobooks/file/book-1/10?talome_audio_attempt=3",
      "/api/audiobooks/file/book-1/10?talome_audio_attempt=4",
      baseUrl,
    )).toBe(false);
  });
});
