import { describe, expect, it } from "vitest";
import { clipCommentary } from "@/hooks/use-live-voice";

describe("clipCommentary", () => {
  it("keeps short answers as they are, on one line", () => {
    expect(clipCommentary("Jellyfin is up.\n\nSonarr too.")).toBe("Jellyfin is up. Sonarr too.");
  });

  it("ends long answers on a sentence so the voice doesn't stop mid-thought", () => {
    const long = `${"Radarr has three updates waiting. ".repeat(60)}Trailing words`;
    const clipped = clipCommentary(long, 200);
    expect(clipped.length).toBeLessThanOrEqual(200);
    expect(clipped.endsWith(".")).toBe(true);
  });
});

import { appendLiveTranscript } from "@/lib/live-transcript";

describe("overlapping voice transcripts", () => {
  it("keeps both speakers growing independently without losing spaces or text", () => {
    let entries = appendLiveTranscript([], "user", "I'd like", 1000, 1200);
    entries = appendLiveTranscript(entries, "assistant", "Sure", 1100, 1300);
    entries = appendLiveTranscript(entries, "user", " to change my booking", 1200, 1800);
    entries = appendLiveTranscript(entries, "assistant", " — tell me more.", 1300, 1900);
    expect(entries.map((entry) => entry.text)).toEqual(["I'd like to change my booking", "Sure — tell me more."]);
  });

  it("uses audio time to start a new bubble after a pause", () => {
    let entries = appendLiveTranscript([], "user", "Hello", 1000, 1500);
    entries = appendLiveTranscript(entries, "user", "Another question", 4000, 4500);
    expect(entries).toHaveLength(2);
  });

  it("retains full replies beyond the former 240-character caption limit", () => {
    const text = "A complete answer. ".repeat(80);
    expect(appendLiveTranscript([], "assistant", text, 0, 10000)[0].text).toBe(text);
  });
});
