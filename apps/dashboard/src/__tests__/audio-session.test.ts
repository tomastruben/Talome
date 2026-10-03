import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireVoiceAudioSession, unlockAudio, voiceAudioDestination, resumeVoiceAudio, voiceAudioBlocked, pauseVoiceAudio } from "@/lib/audio-session";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.querySelectorAll("audio").forEach(el => el.remove()); });

describe("Safari voice audio", () => {
  it("routes Safari through a media element and starts playback before awaiting context resume", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Version/26.0 Safari/605.1.15" });
    const destination = { stream: {} };
    let resolveResume: () => void;
    const resume = vi.fn(() => new Promise<void>(resolve => { resolveResume = resolve; }));
    const ctx = { state: "running", destination: {}, createMediaStreamDestination: vi.fn(() => destination), resume } as unknown as AudioContext;
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    expect(voiceAudioDestination(ctx)).toBe(destination);
    const ready = resumeVoiceAudio(ctx);
    expect(play).toHaveBeenCalledOnce();
    expect(document.querySelector("audio")?.srcObject).toBe(destination.stream);
    expect(voiceAudioBlocked(ctx)).toBe(true); // running context alone does not mean media playback started
    vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockReturnValue(false);
    expect(voiceAudioBlocked(ctx)).toBe(false);
    resolveResume!();
    await ready;
    pauseVoiceAudio(ctx);
    expect(pause).toHaveBeenCalledOnce();
  });

  it("keeps Chrome's working direct output path", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 AppleWebKit/537.36 Chrome/144.0 Safari/537.36" });
    const destination = {};
    const ctx = { destination } as AudioContext;
    expect(voiceAudioDestination(ctx)).toBe(destination);
  });
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
