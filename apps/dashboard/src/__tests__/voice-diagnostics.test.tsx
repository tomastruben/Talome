import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceDiagnostics } from "@/components/settings/voice-diagnostics";
import { microphonePromptExplanation, readVoiceEnvironment, type VoiceEnvironment } from "@/lib/voice-diagnostics";

const environment: VoiceEnvironment = { origin: "http://localhost", secure: true, embedded: false, capture: true, recorder: true, recognition: false, policy: true, permission: "prompt" };
const status = { server: true, model: "whisper-1", live: null };
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 502, json: async () => body });
let getUserMedia: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getUserMedia = vi.fn();
  fetchMock = vi.fn(async () => json(status));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia }, permissions: { query: vi.fn(async () => ({ state: "prompt" })) } });
  vi.stubGlobal("isSecureContext", true);
});
afterEach(() => vi.unstubAllGlobals());

it("distinguishes no-prompt causes without asserting a system denial", () => {
  expect(microphonePromptExplanation({ ...environment, secure: false })).toMatch(/secure context/);
  expect(microphonePromptExplanation({ ...environment, policy: false })).toMatch(/policy blocks/);
  expect(microphonePromptExplanation({ ...environment, permission: "granted" })).toMatch(/another prompt is not expected/);
  expect(microphonePromptExplanation({ ...environment, permission: "denied" })).toMatch(/site setting, page policy, or browser restriction/);
});
it("keeps unavailable permission queries unknown and does not request capture", async () => {
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia }, permissions: { query: vi.fn(async () => { throw new TypeError("unsupported"); }) } });
  expect((await readVoiceEnvironment()).permission).toBe("unknown");
  expect(getUserMedia).not.toHaveBeenCalled();
});

describe("voice diagnostic tool", () => {
  it("requests capture only on click and releases every track", async () => {
    const stop = vi.fn();
    getUserMedia.mockResolvedValue({ getAudioTracks: () => [{ readyState: "live" }], getTracks: () => [{ stop }] });
    render(<VoiceDiagnostics />);
    const button = screen.getByRole("button", { name: "Test microphone" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(button);
    await screen.findByText(/Capture succeeded/);
    expect(stop).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.every(([, init]) => !init || init.method !== "POST")).toBe(true);
  });
  it("releases capture even when permission arrives after cancellation", async () => {
    let resolve!: (value: unknown) => void;
    const stop = vi.fn();
    getUserMedia.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<VoiceDiagnostics />);
    const button = screen.getByRole("button", { name: "Test microphone" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "Cancel test" }));
    resolve({ getAudioTracks: () => [{ readyState: "live" }], getTracks: () => [{ stop }] });
    await waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(screen.getByText(/Test canceled/)).toBeInTheDocument();
    expect(screen.queryByText(/Capture succeeded/)).not.toBeInTheDocument();
  });
  it("shows the browser error name and capture explanation", async () => {
    getUserMedia.mockRejectedValue(new DOMException("blocked", "NotAllowedError"));
    render(<VoiceDiagnostics />);
    const button = screen.getByRole("button", { name: "Test microphone" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByText(/NotAllowedError after/)).toHaveTextContent(/couldn't access the microphone/);
  });
  it("tests selected audio separately and exposes upstream failures", async () => {
    fetchMock.mockImplementation(async (url: string) => url.endsWith("/transcribe") ? json({ ok: false, error: "Transcription failed (401)" }, false) : json(status));
    render(<VoiceDiagnostics />);
    await screen.findByText(/Configured \(whisper-1\)/);
    const clip = new File(["audio"], "test.wav", { type: "audio/wav" });
    fireEvent.change(screen.getByLabelText("Audio clip"), { target: { files: [clip] } });
    fireEvent.click(screen.getByRole("button", { name: "Transcribe test clip" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Transcription failed (401)");
    expect(fetchMock.mock.calls.find(([url]) => url.endsWith("/transcribe"))?.[1]).toMatchObject({ method: "POST", body: clip, headers: { "Content-Type": "audio/wav" } });
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
