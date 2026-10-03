import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const audio = vi.hoisted(() => {
  const node = () => ({ connect: vi.fn().mockReturnThis(), disconnect: vi.fn(), gain: { value: 1 }, fftSize: 512, getFloatTimeDomainData: vi.fn() });
  return { ctx: { state: "running", currentTime: 0, destination: {}, resume: vi.fn(async () => undefined), addEventListener: vi.fn(), removeEventListener: vi.fn(), createGain: node, createAnalyser: node, createMediaStreamSource: node, audioWorklet: { addModule: vi.fn(async () => undefined) } } };
});
vi.mock("@/lib/audio-session", () => ({ sharedAudioContext: () => audio.ctx, acquireVoiceAudioSession: () => vi.fn(), unlockAudio: vi.fn(), voiceAudioDestination: () => audio.ctx.destination, resumeVoiceAudio: () => audio.ctx.resume(), voiceAudioBlocked: () => audio.ctx.state !== "running", pauseVoiceAudio: vi.fn() }));
import { useLiveVoice } from "@/hooks/use-live-voice";

afterEach(() => vi.unstubAllGlobals());

describe("live microphone mute", () => {
  it("disables capture and audio sending while retaining transcript and socket", async () => {
    const track = { enabled: true, stop: vi.fn() };
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => ({ getAudioTracks: () => [track], getTracks: () => [track] })) } });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:test", revokeObjectURL: vi.fn() });
    const send = vi.fn();
    const close = vi.fn();
    let socket: { readyState: number; send: typeof send; close: typeof close; onopen?: () => void; onmessage?: (event: { data: string }) => void };
    vi.stubGlobal("WebSocket", class {
      readyState = 1; send = send; close = close;
      constructor() { socket = this; }
    });
    let port: { onmessage?: (event: { data: ArrayBuffer }) => void };
    vi.stubGlobal("AudioWorkletNode", class {
      port = {}; connect = vi.fn().mockReturnThis(); disconnect = vi.fn();
      constructor() { port = this.port; }
    });
    audio.ctx.state = "interrupted";
    const hook = renderHook(() => useLiveVoice({ onDelegate: async () => "Done" }));
    await act(async () => { await hook.result.current.start(); });
    act(() => {
      socket!.onopen!();
      socket!.onmessage!({ data: JSON.stringify({ type: "session.started" }) });
      socket!.onmessage!({ data: JSON.stringify({ type: "session.output_transcript.delta", delta: "Still speaking", start_ms: 0, end_ms: 1000 }) });
      port!.onmessage!({ data: new ArrayBuffer(4) });
    });
    expect(hook.result.current.playbackBlocked).toBe(true);
    audio.ctx.resume.mockImplementation(async () => { audio.ctx.state = "running"; });
    await act(async () => { hook.result.current.resumePlayback(); });
    expect(hook.result.current.playbackBlocked).toBe(false);
    expect(send.mock.calls.some(([message]) => JSON.parse(message).type === "session.input_audio.append")).toBe(true);
    send.mockClear();
    act(() => { hook.result.current.toggleMute(); port!.onmessage!({ data: new ArrayBuffer(4) }); });
    expect(track.enabled).toBe(false);
    expect(hook.result.current.muted).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(hook.result.current.transcript[0].text).toBe("Still speaking");
    act(() => { hook.result.current.toggleMute(); port!.onmessage!({ data: new ArrayBuffer(4) }); });
    expect(track.enabled).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    hook.unmount();
    expect(track.stop).toHaveBeenCalledOnce();
  });
});
