import { describe, expect, it } from "vitest";
import { shouldSuppressEmptyNormalBufferWheel } from "@/components/terminal/terminal-scroll";

describe("terminal wheel handling", () => {
  it("suppresses wheel-to-arrow conversion at an empty shell prompt", () => {
    expect(
      shouldSuppressEmptyNormalBufferWheel({ type: "normal", baseY: 0 }),
    ).toBe(true);
  });

  it("keeps normal scrollback navigation enabled", () => {
    expect(
      shouldSuppressEmptyNormalBufferWheel({ type: "normal", baseY: 42 }),
    ).toBe(false);
  });

  it("keeps alternate-screen TUI wheel navigation enabled", () => {
    expect(
      shouldSuppressEmptyNormalBufferWheel({ type: "alternate", baseY: 0 }),
    ).toBe(false);
  });
});
