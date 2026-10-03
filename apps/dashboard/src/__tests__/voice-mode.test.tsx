import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  voice: vi.fn(), live: vi.fn(), start: vi.fn(async () => undefined),
  cancel: vi.fn(), stop: vi.fn(), cancelSpeech: vi.fn(), unlock: vi.fn(), liveEnabled: false, embedded: false,
}));
vi.mock("swr", () => ({ default: () => ({ data: { live: mocks.liveEnabled ? { model: "live" } : null } }) }));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("thinking-orbs", () => ({ ThinkingOrb: ({ state, paused }: { state: string; paused: boolean }) => <span data-testid="voice-orb" data-state={state} data-paused={String(paused)} /> }));
vi.mock("voice-glow", () => ({ VoiceBeam: () => null }));
vi.mock("@/hooks/use-voice-input", () => ({ useVoiceInput: mocks.voice }));
vi.mock("@/hooks/use-live-voice", () => ({ useLiveVoice: mocks.live }));
vi.mock("@/lib/audio-session", () => ({ unlockAudio: mocks.unlock }));
vi.mock("@/hooks/use-desktop-mode", () => ({ useIsEmbeddedFrame: () => mocks.embedded }));
vi.mock("@/hooks/use-speech-output", () => ({ useSpeechOutput: () => ({ cancel: mocks.cancelSpeech }) }));

import { VoiceMode } from "@/components/assistant/voice-mode";
import { WindowDragBridge } from "@/components/desktop/window-drag";
import { parseDesktopWindowDragMessage } from "@/atoms/desktop-window-chrome";

const level = { get: () => 0 };
const props = { open: true, onClose: vi.fn(), onSend: vi.fn(), status: "ready" as const, lastAssistant: null };
function voiceState(engine: "server" | null, error: string | null = null) {
  return { engine, error, status: "idle", level, start: mocks.start, cancel: mocks.cancel, unavailableReason: null };
}

describe("voice conversation startup", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.liveEnabled = false;
    mocks.embedded = false;
  });

  it("forwards drags from empty voice space in a desktop window, excluding controls", () => {
    mocks.embedded = true;
    mocks.voice.mockReturnValue(voiceState("server", "Capture failed."));
    const post = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
    render(<><WindowDragBridge /><VoiceMode {...props} /></>);
    const dialog = screen.getByRole("dialog", { name: "Voice conversation" });
    const pointer = { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, clientX: 80, clientY: 80 };
    fireEvent.pointerDown(screen.getByText("Try microphone again"), pointer);
    fireEvent.pointerDown(screen.getByRole("button", { name: "End voice conversation" }), pointer);
    expect(post).not.toHaveBeenCalled();
    fireEvent.pointerDown(dialog, pointer);
    fireEvent.pointerMove(dialog, { ...pointer, clientX: 120 });
    fireEvent.pointerUp(dialog, { ...pointer, clientX: 120 });
    expect(post.mock.calls.map(([message]) => parseDesktopWindowDragMessage(message)?.phase)).toEqual(["start", "move", "end"]);
    post.mockRestore();
  });

  it("keeps ordinary browser voice mode out of desktop drag forwarding", () => {
    mocks.voice.mockReturnValue(voiceState("server"));
    render(<VoiceMode {...props} />);
    expect(screen.getByRole("dialog", { name: "Voice conversation" })).not.toHaveAttribute("data-window-drag-region");
  });

  it("starts when the speech engine becomes ready after the dialog mounts", async () => {
    mocks.voice.mockReturnValue(voiceState(null));
    const page = render(<VoiceMode {...props} />);
    expect(mocks.start).not.toHaveBeenCalled();
    mocks.voice.mockReturnValue(voiceState("server"));
    page.rerender(<VoiceMode {...props} />);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    page.unmount();
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
  });

  it("shows the fallback microphone error and retries from a user click", () => {
    mocks.voice.mockReturnValue(voiceState("server", "Capture was blocked by the browser."));
    render(<VoiceMode {...props} />);
    expect(screen.getByText("Microphone unavailable")).toBeInTheDocument();
    expect(screen.getByText("Capture was blocked by the browser.")).toBeInTheDocument();
    expect(screen.queryByText("Listening")).not.toBeInTheDocument();
    mocks.start.mockClear();
    fireEvent.click(screen.getByText("Try microphone again"));
    expect(mocks.unlock).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.cancelSpeech).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it("offers a fresh live session after a microphone failure", () => {
    mocks.liveEnabled = true;
    mocks.live.mockReturnValue({ state: "ended", activity: "listening", error: "Capture failed.", userLevel: level, agentLevel: level, start: mocks.start, stop: mocks.stop });
    render(<VoiceMode {...props} />);
    expect(screen.getByText("Capture failed.")).toBeInTheDocument();
    mocks.start.mockClear();
    fireEvent.click(screen.getByText("Try microphone again"));
    expect(mocks.stop).toHaveBeenCalled();
    expect(mocks.unlock).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
  it("lets the user hide and restore complete bubbles and mute without ending voice", () => {
    mocks.liveEnabled = true;
    const toggleMute = vi.fn();
    mocks.live.mockReturnValue({ state: "live", activity: "listening", error: null, muted: false, toggleMute,
      transcript: [{ id: 1, role: "user", text: "My question" }, { id: 2, role: "assistant", text: "A complete reply" }],
      userLevel: level, agentLevel: level, start: mocks.start, stop: mocks.stop });
    render(<VoiceMode {...props} />);
    expect(screen.getByText("A complete reply")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide transcript" }));
    expect(screen.queryByText("A complete reply")).not.toBeInTheDocument();
    expect(mocks.stop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show transcript" }));
    expect(screen.getByText("My question")).toBeInTheDocument();
    expect(screen.getByText("A complete reply")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mute mic" }));
    expect(toggleMute).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Mute mic" }).textContent).toBe("");
    expect(screen.getAllByRole("button", { name: "End voice conversation" }).at(-1)?.textContent).toBe("");
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it("keeps normal conversation free of status headings and ignores brief activity flips", () => {
    vi.useFakeTimers();
    mocks.liveEnabled = true;
    const live = { state: "live", activity: "listening", error: null, muted: false,
      userLevel: level, agentLevel: level, start: mocks.start, stop: mocks.stop };
    mocks.live.mockReturnValue(live);
    const page = render(<VoiceMode {...props} />);
    mocks.live.mockReturnValue({ ...live, activity: "speaking" });
    page.rerender(<VoiceMode {...props} />);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByTestId("voice-orb")).toHaveAttribute("data-state", "breathing");
    mocks.live.mockReturnValue(live);
    page.rerender(<VoiceMode {...props} />);
    act(() => vi.advanceTimersByTime(700));
    expect(screen.getByTestId("voice-orb")).toHaveAttribute("data-state", "breathing");
    mocks.live.mockReturnValue({ ...live, activity: "speaking" });
    page.rerender(<VoiceMode {...props} />);
    act(() => vi.advanceTimersByTime(600));
    expect(screen.getAllByTestId("voice-orb").some(el => el.dataset.state === "weaving")).toBe(true);
    expect(screen.queryByText("Talome", { selector: "p" })).not.toBeInTheDocument();
    expect(screen.queryByText("Just talk — interrupt any time.")).not.toBeInTheDocument();
    page.unmount();
  });

  it("stops the orb when voice ends instead of displaying active listening", () => {
    mocks.liveEnabled = true;
    mocks.live.mockReturnValue({ state: "ended", activity: "listening", error: null,
      userLevel: level, agentLevel: level, start: mocks.start, stop: mocks.stop });
    render(<VoiceMode {...props} />);
    expect(screen.getByTestId("voice-orb")).toHaveAttribute("data-state", "breathing");
    expect(screen.getByTestId("voice-orb")).toHaveAttribute("data-paused", "true");
    expect(screen.getByText("Voice ended")).toBeInTheDocument();
  });

  it("offers audio recovery without ending the conversation", () => {
    mocks.liveEnabled = true;
    const resumePlayback = vi.fn();
    mocks.live.mockReturnValue({ state: "live", activity: "listening", error: null, playbackBlocked: true, resumePlayback,
      userLevel: level, agentLevel: level, start: mocks.start, stop: mocks.stop });
    render(<VoiceMode {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Enable audio" }));
    expect(resumePlayback).toHaveBeenCalledOnce();
    expect(mocks.stop).not.toHaveBeenCalled();
  });

});
