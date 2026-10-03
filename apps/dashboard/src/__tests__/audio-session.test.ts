import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireVoiceAudioSession, unlockAudio } from "@/lib/audio-session";

afterEach(() => vi.unstubAllGlobals());

describe("Safari voice audio", () => {
  it("resumes interrupted audio and starts an inaudible source inside the tap", () => {
    const source = { buffer: null, connect: vi.fn(), start: vi.fn(), disconnect: vi.fn(), onended: null };
    const resume = vi.fn(async () => undefined);
    vi.stubGlobal("AudioContext", class {
      state = "interrupted"; sampleRate = 48000; destination = {};
      resume = resume; createBufferSource = () => source; createBuffer = vi.fn(() => ({}));
    });
    unlockAudio();
    expect(resume).toHaveBeenCalledOnce();
    expect(source.start).toHaveBeenCalledOnce();
    expect(source.connect).toHaveBeenCalledOnce();
  });

  it("uses duplex audio routing only during capture and restores the prior setting", () => {
    const session = { type: "auto" };
    vi.stubGlobal("navigator", { audioSession: session });
    const release = acquireVoiceAudioSession();
    expect(session.type).toBe("play-and-record");
    release();
    expect(session.type).toBe("auto");
  });

  it("supports browsers without the optional audio session API", () => {
    vi.stubGlobal("navigator", {});
    expect(() => acquireVoiceAudioSession()()).not.toThrow();
  });
});
