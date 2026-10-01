import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const embedded = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/use-desktop-mode", () => ({
  useIsEmbeddedFrame: () => embedded.value,
}));

import { DesktopAppToolbar } from "@/components/desktop/desktop-app-toolbar";
import { WindowStatusBar, WindowStatusBarSlot, WindowToolbarSlot } from "@/components/desktop/window-content";

function Column({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="column">
      <WindowToolbarSlot />
      <div data-testid="scroller">{children}</div>
      <WindowStatusBarSlot />
    </div>
  );
}

function App() {
  return (
    <>
      <DesktopAppToolbar className="flex items-center gap-3 pb-4">
        <h1>Files</h1>
      </DesktopAppToolbar>
      <p>Folder contents</p>
      <WindowStatusBar className="justify-between">
        <span>12 items</span>
      </WindowStatusBar>
    </>
  );
}

describe("window toolbar and status bar", () => {
  beforeEach(() => {
    embedded.value = false;
  });

  it("portal into the window's slots, outside the scroller, with the window classes", () => {
    embedded.value = true;
    render(
      <Column>
        <App />
      </Column>,
    );

    const scroller = screen.getByTestId("scroller");
    const toolbar = screen.getByRole("heading", { name: "Files" }).parentElement!;
    expect(toolbar).toHaveAttribute("data-desktop-app-toolbar", "true");
    expect(toolbar).toHaveClass("tm-window-toolbar", "flex", "items-center");
    expect(scroller.contains(toolbar)).toBe(false);
    // The toolbar comes before the scroller, the status bar after it
    expect(toolbar.compareDocumentPosition(scroller) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No sticky band, backdrop or negative margins: the slot sits outside the scroller
    expect(toolbar.className).not.toMatch(/sticky|backdrop-blur|bg-background|-m[xt]-/);

    const status = screen.getByText("12 items").parentElement!;
    expect(status).toHaveAttribute("data-window-statusbar");
    expect(status).toHaveClass("tm-window-statusbar", "text-xs", "text-muted-foreground", "justify-between");
    expect(scroller.contains(status)).toBe(false);
    expect(scroller.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scroller).toHaveTextContent("Folder contents");
  });

  it("render in place with the window classes in a window without slots", () => {
    embedded.value = true;
    render(<App />);

    const toolbar = screen.getByRole("heading", { name: "Files" }).parentElement!;
    expect(toolbar).toHaveClass("tm-window-toolbar");
    expect(screen.getByText("12 items").parentElement).toHaveClass("tm-window-statusbar");
  });

  it("render in place with only the page's classes in classic mode", () => {
    render(
      <Column>
        <App />
      </Column>,
    );

    const scroller = screen.getByTestId("scroller");
    const toolbar = screen.getByRole("heading", { name: "Files" }).parentElement!;
    expect(toolbar).not.toHaveAttribute("data-desktop-app-toolbar");
    expect(toolbar.className).toBe("flex items-center gap-3 pb-4");
    expect(scroller.contains(toolbar)).toBe(true);

    const status = screen.getByText("12 items").parentElement!;
    expect(status).not.toHaveAttribute("data-window-statusbar");
    expect(status.className).toBe("justify-between");
    expect(scroller.contains(status)).toBe(true);
  });
});
