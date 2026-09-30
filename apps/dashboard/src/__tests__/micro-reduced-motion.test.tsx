import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const motionPrefs = vi.hoisted(() => ({ reduce: false }));

vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => motionPrefs.reduce };
});

import { IconSwap } from "@/components/ui/micro";
import * as micro from "@/components/ui/micro";

describe("IconSwap", () => {
  beforeEach(() => {
    motionPrefs.reduce = false;
  });

  it("swaps in place with no animation under reduced motion", () => {
    motionPrefs.reduce = true;
    const { rerender } = render(<IconSwap active="a" a={<span>copy</span>} b={<span>copied</span>} />);
    const slot = screen.getByText("copy").parentElement!;
    // A plain element: no motion-driven opacity, transform or filter.
    expect(slot.getAttribute("style")).toBeNull();

    rerender(<IconSwap active="b" a={<span>copy</span>} b={<span>copied</span>} />);
    // The outgoing icon is gone at once: nothing lingers for an exit animation.
    expect(screen.queryByText("copy")).not.toBeInTheDocument();
    expect(screen.getByText("copied").parentElement!.getAttribute("style")).toBeNull();
  });

  it("animates the swap when motion is allowed", () => {
    render(<IconSwap active="a" a={<span>play</span>} b={<span>pause</span>} />);
    // initial={false} on the presence: the first icon is simply there, as a motion element.
    expect(screen.getByText("play").parentElement!.getAttribute("style")).not.toBeNull();
  });
});

describe("micro-interactions", () => {
  it("has no copy hook of its own (CopyButton owns copy feedback and COPY_REVERT_MS)", () => {
    expect("useCopied" in micro).toBe(false);
  });
});
