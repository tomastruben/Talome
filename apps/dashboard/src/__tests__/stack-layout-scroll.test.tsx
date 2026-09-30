import { act, fireEvent, render } from "@testing-library/react";
import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

let currentPath = "/dashboard/settings";
vi.mock("next/navigation", () => ({ usePathname: () => currentPath }));

// AnimatePresence stand-in: reports the exit as complete one tick after the
// child changes, the way the real exit animation finishes after 140ms.
vi.mock("motion/react", () => ({
  useReducedMotion: () => false,
  AnimatePresence: ({ children, onExitComplete }: { children: ReactElement; onExitComplete?: () => void }) => {
    const key = children.key;
    const previous = useRef(key);
    useEffect(() => {
      if (previous.current === key) return;
      previous.current = key;
      setTimeout(() => onExitComplete?.(), 0);
    }, [key, onExitComplete]);
    return children;
  },
  motion: { div: ({ children }: { children: ReactNode }) => <div>{children}</div> },
}));

import { StackLayout } from "@/components/layout/stack-layout";

function Shell({ children }: { children: ReactNode }) {
  return (
    <div data-testid="scroller" className="overflow-y-auto">
      {children}
    </div>
  );
}

async function navigate(rerender: (ui: ReactElement) => void, scroller: HTMLElement, path: string) {
  act(() => {
    currentPath = path;
    rerender(
      <Shell>
        <StackLayout rootPath="/dashboard/settings">{path}</StackLayout>
      </Shell>,
    );
  });
  // The dashboard shell resets the shared scroller to the top on every route
  // change; the browser reports that scroll after the commit.
  act(() => {
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
  });
  // The outgoing page finishes its exit.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

describe("StackLayout scroll restoration", () => {
  it("returns to where you were on the parent page after going back", async () => {
    currentPath = "/dashboard/settings";
    const { getByTestId, rerender } = render(
      <Shell>
        <StackLayout rootPath="/dashboard/settings">root</StackLayout>
      </Shell>,
    );
    const scroller = getByTestId("scroller");
    const scrollTo = vi.fn(({ top }: { top: number }) => {
      scroller.scrollTop = top;
    });
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;

    scroller.scrollTop = 480;
    fireEvent.scroll(scroller);

    await navigate(rerender, scroller, "/dashboard/settings/ai");
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0 });

    await navigate(rerender, scroller, "/dashboard/settings");
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 480 });
  });
});
