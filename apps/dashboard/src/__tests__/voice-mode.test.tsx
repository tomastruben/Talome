import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  voice: vi.fn(), live: vi.fn(), start: vi.fn(async () => undefined),
  cancel: vi.fn(), stop: vi.fn(), cancelSpeech: vi.fn(), unlock: vi.fn(), liveEnabled: false,
}));
vi.mock("swr", () => ({ default: () => ({ data: { live: mocks.liveEnabled ? { model: "live" } : null } }) }));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("thinking-orbs", () => ({ ThinkingOrb: () => null }));
vi.mock("voice-glow", () => ({ VoiceBeam: () => null }));
vi.mock("@/hooks/use-voice-input", () => ({ useVoiceInput: mocks.voice }));
vi.mock("@/hooks/use-live-voice", () => ({ useLiveVoice: mocks.live }));
vi.mock("@/lib/audio-session", () => ({ unlockAudio: mocks.unlock }));
vi.mock("@/hooks/use-speech-output", () => ({ useSpeechOutput: () => ({ cancel: mocks.cancelSpeech }) }));

import { VoiceMode } from "@/components/assistant/voice-mode";

const level = { get: () => 0 };
const props = { open: true, onClose: vi.fn(), onSend: vi.fn(), status: "ready" as const, lastAssistant: null };
function voiceState(engine: "server" | null, error: string | null = null) {
  return { engine, error, status: "idle", level, start: mocks.start, cancel: mocks.cancel, unavailableReason: null };
}

describe("voice conversation startup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.liveEnabled = false;
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
});
