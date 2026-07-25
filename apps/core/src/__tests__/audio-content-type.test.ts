import { describe, expect, it } from "vitest";
import { resolveAudioContentType } from "../utils/audio-content-type.js";

describe("resolveAudioContentType", () => {
  it("keeps valid upstream audio types", () => {
    expect(resolveAudioContentType("audio/mpeg", "chapter.bin")).toBe("audio/mpeg");
  });

  it("repairs generic content types from the file extension", () => {
    expect(resolveAudioContentType("application/octet-stream", "Chapter 01.mp3")).toBe("audio/mpeg");
    expect(resolveAudioContentType(null, "book.m4b")).toBe("audio/mp4");
  });

  it("falls back safely for unknown formats", () => {
    expect(resolveAudioContentType(null, "chapter.unknown")).toBe("application/octet-stream");
  });
});
