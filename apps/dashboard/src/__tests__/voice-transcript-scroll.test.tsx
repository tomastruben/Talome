import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ reduced: false, animate: vi.fn(), stop: vi.fn() }));
vi.mock("motion/react", async (original) => ({
  ...await original<typeof import("motion/react")>(),
  useReducedMotion: () => mocks.reduced,
  animate: mocks.animate,
}));
import { VoiceTranscript } from "@/components/assistant/voice-transcript";
import type { LiveTranscriptEntry } from "@/lib/live-transcript";
const entries: LiveTranscriptEntry[] = [
  { id: 1, role: "user", text: "My question", startMs: 0, endMs: 100 },
  { id: 2, role: "assistant", text: "A response", startMs: 200, endMs: 300 },
];

describe("voice transcript following", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reduced = false;
    mocks.animate.mockImplementation((_from, to, options) => {
      options.onUpdate(to);
      options.onComplete();
      return { stop: mocks.stop };
    });
  });

  it("follows new text smoothly, respects reading older turns, and resumes at the bottom", () => {
    const { container, rerender } = render(<VoiceTranscript entries={entries} />);
    const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    Object.defineProperties(viewport, {
      scrollHeight: { value: 600, configurable: true },
      clientHeight: { value: 200, configurable: true },
    });
    rerender(<VoiceTranscript entries={[...entries, { ...entries[1], id: 3 }]} />);
    expect(mocks.animate).toHaveBeenLastCalledWith(0, 400, expect.objectContaining({ duration: 0.18 }));
    expect(viewport.scrollTop).toBe(400);

    fireEvent.wheel(viewport, { deltaY: -100 });
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    mocks.animate.mockClear();
    rerender(<VoiceTranscript entries={[...entries]} />);
    expect(mocks.animate).not.toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(100);

    viewport.scrollTop = 400;
    fireEvent.scroll(viewport);
    Object.defineProperty(viewport, "scrollHeight", { value: 900, configurable: true });
    rerender(<VoiceTranscript entries={[...entries, { ...entries[1], id: 4 }]} />);
    expect(viewport.scrollTop).toBe(700);
  });

  it("follows without animation when reduced motion is requested", () => {
    mocks.reduced = true;
    const { container, rerender } = render(<VoiceTranscript entries={entries} />);
    const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    Object.defineProperties(viewport, { scrollHeight: { value: 600 }, clientHeight: { value: 200 } });
    rerender(<VoiceTranscript entries={[...entries]} />);
    expect(viewport.scrollTop).toBe(400);
    expect(mocks.animate).not.toHaveBeenCalled();
  });
});
