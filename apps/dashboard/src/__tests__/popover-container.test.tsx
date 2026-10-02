import { useState } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** A fullscreen element hides everything outside it, so a popover opened from
 *  inside the media player must be able to render inside the player. */
function Player({ inside }: { inside: boolean }) {
  const [player, setPlayer] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setPlayer} data-testid="player">
      <Popover open>
        <PopoverTrigger>Style</PopoverTrigger>
        <PopoverContent container={inside ? player : undefined}>Font size</PopoverContent>
      </Popover>
    </div>
  );
}

describe("PopoverContent container", () => {
  it("portals into the given container", () => {
    render(<Player inside />);
    expect(screen.getByTestId("player")).toContainElement(screen.getByText("Font size"));
  });

  it("portals to the body by default", () => {
    render(<Player inside={false} />);
    expect(screen.getByTestId("player")).not.toContainElement(screen.getByText("Font size"));
    expect(document.body).toContainElement(screen.getByText("Font size"));
  });
});
