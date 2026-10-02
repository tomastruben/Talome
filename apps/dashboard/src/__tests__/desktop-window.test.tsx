import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopWindow, desktopWindowChrome } from "@/components/desktop/desktop-window";
import {
  DESKTOP_WINDOW_CHROME_MESSAGE,
  DESKTOP_WINDOW_CHROME_REQUEST_MESSAGE,
  DESKTOP_WINDOW_DRAG_MESSAGE,
  DESKTOP_WINDOW_STATE_MESSAGE,
  DESKTOP_WINDOW_ZOOM_MESSAGE,
} from "@/atoms/desktop-window-chrome";

describe("DesktopWindow", () => {
  const defaultProps = {
    id: "files",
    title: "Files",
    bounds: { x: 80, y: 100, width: 700, height: 500 },
    area: { width: 1400, height: 820 },
    minimum: { width: 420, height: 320 },
    active: true,
    maximized: false,
    zIndex: 2,
    onFocus: vi.fn(),
    onClose: vi.fn(),
    onMinimize: vi.fn(),
    onBoundsChange: vi.fn(),
    onMaximizeChange: vi.fn(),
  };

  const openArrangeMenu = () => {
    const trigger = screen.getByRole("button", { name: "Arrange Files" });
    fireEvent.keyDown(trigger, { key: "Enter" });
  };

  it("uses quiet window controls instead of coloured traffic lights", () => {
    render(
      <DesktopWindow {...defaultProps}>
        <div>Files content</div>
      </DesktopWindow>,
    );

    const controls = screen.getByRole("group", { name: "Window controls" });
    const colouredAtRest = Array.from(controls.querySelectorAll("button")).filter((button) =>
      button.className.split(/\s+/).some((token) => token.startsWith("bg-status-")),
    );
    expect(colouredAtRest).toEqual([]);
    expect(screen.getByRole("button", { name: "Minimize Files" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Arrange Files" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close Files" })).toBeVisible();
  });

  it("arranges a window into the left half and remembers its size", async () => {
    const onTile = vi.fn();
    render(
      <DesktopWindow {...defaultProps} onTile={onTile}>
        <div>Files content</div>
      </DesktopWindow>,
    );

    openArrangeMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Left half" }));

    expect(onTile).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 700, height: 820 },
      defaultProps.bounds,
    );
  });

  it("fills the desktop from Arrange", async () => {
    const onMaximizeChange = vi.fn();
    const onBoundsChange = vi.fn();
    render(
      <DesktopWindow {...defaultProps} onTile={vi.fn()} onMaximizeChange={onMaximizeChange} onBoundsChange={onBoundsChange}>
        <div>Files content</div>
      </DesktopWindow>,
    );

    openArrangeMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Fill" }));

    expect(screen.queryByRole("menuitem", { name: "Previous size" })).toBeNull();
    expect(onMaximizeChange).toHaveBeenCalledWith(true, defaultProps.bounds);
    expect(onBoundsChange).toHaveBeenCalledWith({ x: 0, y: 0, width: 1400, height: 820 });
  });

  it("offers the previous size once a window is arranged", async () => {
    const onMaximizeChange = vi.fn();
    render(
      <DesktopWindow
        {...defaultProps}
        maximized
        bounds={{ x: 0, y: 0, width: 1400, height: 820 }}
        restoreBounds={defaultProps.bounds}
        onTile={vi.fn()}
        onMaximizeChange={onMaximizeChange}
      >
        <div>Files content</div>
      </DesktopWindow>,
    );

    openArrangeMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Previous size" }));

    expect(onMaximizeChange).toHaveBeenCalledWith(false, defaultProps.bounds);
  });

  it("reports pointer-driven resize geometry", () => {
    const onBoundsChange = vi.fn();

    render(
      <DesktopWindow
        {...defaultProps}
        onBoundsChange={onBoundsChange}
      >
        <div>Files content</div>
      </DesktopWindow>,
    );

    fireEvent.pointerDown(document.querySelector('[data-resize-edge="se"]')!, {
      button: 0,
      clientX: 780,
      clientY: 600,
    });
    fireEvent.pointerMove(window, { clientX: 860, clientY: 650 });

    expect(onBoundsChange).toHaveBeenLastCalledWith({
      x: 80,
      y: 100,
      width: 780,
      height: 550,
    });
  });

  it("resizes with arrow keys and clamps accelerated keyboard resizing", () => {
    const onBoundsChange = vi.fn();
    render(<DesktopWindow {...defaultProps} onBoundsChange={onBoundsChange}>Content</DesktopWindow>);
    const handle = screen.getByRole("button", { name: "Resize Files" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onBoundsChange).toHaveBeenLastCalledWith({ ...defaultProps.bounds, width: 716 });
    fireEvent.keyDown(handle, { key: "ArrowUp", shiftKey: true });
    expect(onBoundsChange).toHaveBeenLastCalledWith({ ...defaultProps.bounds, height: 436 });
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(onBoundsChange).toHaveBeenCalledTimes(2);
  });

  it("activates a window when its controls receive keyboard focus", () => {
    const onFocus = vi.fn();
    render(<DesktopWindow {...defaultProps} active={false} onFocus={onFocus}>Content</DesktopWindow>);
    fireEvent.focus(screen.getByRole("button", { name: "Close Files" }));
    expect(onFocus).toHaveBeenCalledOnce();
  });

  it("keeps keyboard resizing within the available workspace", () => {
    const onBoundsChange = vi.fn();
    render(<DesktopWindow {...defaultProps} bounds={{ x: 80, y: 100, width: 1310, height: 330 }} onBoundsChange={onBoundsChange}>Content</DesktopWindow>);
    const handle = screen.getByRole("button", { name: "Resize Files" });
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(onBoundsChange).toHaveBeenLastCalledWith({ x: 80, y: 100, width: 1320, height: 330 });
    fireEvent.keyDown(handle, { key: "ArrowUp", shiftKey: true });
    expect(onBoundsChange).toHaveBeenLastCalledWith({ x: 80, y: 100, width: 1310, height: 320 });
  });

  it("captures resize gestures and keeps the handle inside the workspace", () => {
    const onBoundsChange = vi.fn();
    const setPointerCapture = vi.fn();
    const resizePrototype = HTMLElement.prototype as HTMLElement & {
      setPointerCapture?: (pointerId: number) => void;
    };
    const originalSetPointerCapture = resizePrototype.setPointerCapture;
    resizePrototype.setPointerCapture = setPointerCapture;

    try {
      render(
        <DesktopWindow
          {...defaultProps}
          onBoundsChange={onBoundsChange}
        >
          <iframe title="Service app" />
        </DesktopWindow>,
      );

      fireEvent.pointerDown(screen.getByRole("button", { name: "Resize Files" }), {
        button: 0,
        pointerId: 7,
        clientX: 780,
        clientY: 600,
      });
      fireEvent.pointerMove(window, { pointerId: 7, clientX: 2400, clientY: 1600 });

      expect(setPointerCapture).toHaveBeenCalledWith(7);
      expect(onBoundsChange).toHaveBeenLastCalledWith({
        x: 80,
        y: 100,
        width: 1320,
        height: 720,
      });
    } finally {
      resizePrototype.setPointerCapture = originalSetPointerCapture;
    }
  });

  it("lets pointer dragging place a normal window flush with the top-left edges", () => {
    const onBoundsChange = vi.fn();

    render(
      <DesktopWindow
        {...defaultProps}
        onBoundsChange={onBoundsChange}
      >
        <div>Files content</div>
      </DesktopWindow>,
    );

    fireEvent.pointerDown(screen.getByText("Files"), {
      button: 0,
      clientX: 200,
      clientY: 220,
    });
    fireEvent.pointerMove(window, { clientX: 0, clientY: 0 });

    expect(onBoundsChange).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 700,
      height: 500,
    });
  });

  it("resizes from the left edge while the right edge stays put", () => {
    const onBoundsChange = vi.fn();
    render(
      <DesktopWindow {...defaultProps} onBoundsChange={onBoundsChange}>
        <div>Files content</div>
      </DesktopWindow>,
    );

    fireEvent.pointerDown(document.querySelector('[data-resize-edge="w"]')!, { button: 0, clientX: 80, clientY: 300 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 300 });

    expect(onBoundsChange).toHaveBeenLastCalledWith({ x: 40, y: 100, width: 740, height: 500 });
  });

  it("snaps to the left half when dragged to the left edge, remembering its size", () => {
    const onTile = vi.fn();
    render(
      <DesktopWindow {...defaultProps} onTile={onTile}>
        <div>Files content</div>
      </DesktopWindow>,
    );

    fireEvent.pointerDown(screen.getByText("Files").parentElement!.parentElement!, { button: 0, clientX: 300, clientY: 120 });
    fireEvent.pointerMove(window, { clientX: 2, clientY: 300 });
    fireEvent.pointerUp(window);

    expect(onTile).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 700, height: 820 },
      { x: 80, y: 100, width: 700, height: 500 },
    );
  });

  it("is a rounded-2xl window, and its snap preview turns solid under reduced transparency", () => {
    render(
      <DesktopWindow {...defaultProps} onTile={vi.fn()}>
        <div>Files content</div>
      </DesktopWindow>,
    );

    const windowRegion = screen.getByRole("region", { name: "Files window" });
    expect(windowRegion).toHaveClass("tm-window", "rounded-2xl", "border");
    expect(windowRegion.className).not.toMatch(/rounded-(?:b-)?xl\b/);

    fireEvent.pointerDown(screen.getByText("Files").parentElement!.parentElement!, { button: 0, clientX: 300, clientY: 120 });
    fireEvent.pointerMove(window, { clientX: 2, clientY: 300 });
    const preview = document.querySelector("[data-window-snap-preview]");
    expect(preview).not.toBeNull();
    // A blur surface outside the named materials must go solid with them
    expect(preview).toHaveClass("backdrop-blur-sm", "solid-materials:backdrop-blur-none", "solid-materials:bg-muted");
    fireEvent.pointerUp(window);
  });

  it("shows an inactive window by its title colour alone, never by fading it", () => {
    render(
      <DesktopWindow {...defaultProps} active={false}>
        <div>Files content</div>
      </DesktopWindow>,
    );

    const title = screen.getByText("Files");
    expect(title).toHaveClass("text-muted-foreground");
    expect(title.className).not.toMatch(/\bopacity-/);
    expect(screen.getByRole("region", { name: "Files window" }).className).not.toMatch(/\bopacity-\d/);
  });

  it("gives a snapped window its previous size back when dragged away", () => {
    const onTile = vi.fn();
    render(
      <DesktopWindow
        {...defaultProps}
        bounds={{ x: 0, y: 0, width: 700, height: 820 }}
        restoreBounds={{ x: 80, y: 100, width: 600, height: 400 }}
        onTile={onTile}
      >
        <div>Files content</div>
      </DesktopWindow>,
    );

    fireEvent.pointerDown(screen.getByText("Files").parentElement!.parentElement!, { button: 0, clientX: 350, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 351, clientY: 21 }); // below the drag threshold
    expect(onTile).not.toHaveBeenCalled();
    fireEvent.pointerMove(window, { clientX: 400, clientY: 60 });

    expect(onTile).toHaveBeenCalledTimes(1);
    const [restored, restore] = onTile.mock.calls[0];
    expect(restored).toMatchObject({ width: 600, height: 400 });
    expect(restore).toBeUndefined();
  });

  it("renders a leading Back and keeps a trailing slot for a page that still publishes a verb", () => {
    const onAction = vi.fn();

    render(
      <DesktopWindow
        {...defaultProps}
        title="Grocy"
        appTitle="Grocy"
        actions={[
          { id: "back", label: "Back", icon: "back", placement: "leading" },
          // An AppSpec native app (native-app-runtime.tsx) may still publish one
          { id: "native-app-assistant", label: "Ask about Grocy" },
          { id: "auto", label: "Auto", kind: "toggle", active: true },
        ]}
        onAction={onAction}
      >
        <div>Grocy content</div>
      </DesktopWindow>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask about Grocy" }));
    // A toggle is a pressed button now: no app publishes a title-bar switch
    const toggle = screen.getByRole("button", { name: "Auto" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(toggle);

    expect(onAction.mock.calls).toEqual([["back"], ["native-app-assistant"], ["auto"]]);
    expect(screen.getByText("Grocy")).toHaveAttribute("data-title-placement", "leading");
    expect(screen.getByRole("group", { name: "Grocy navigation" })).toHaveAttribute("data-window-actions", "leading");
    expect(screen.getByRole("group", { name: "Grocy actions" })).toHaveAttribute("data-window-actions", "trailing");
  });

  it("keeps the title beside the window controls when there are no actions", () => {
    render(
      <DesktopWindow {...defaultProps}>
        <div>Files content</div>
      </DesktopWindow>,
    );

    expect(screen.getByText("Files")).toHaveAttribute("data-title-placement", "leading");
    // No empty action groups for assistive tech to stop on
    expect(document.querySelector("[data-window-actions]")).toBeNull();
  });

  it("names the window and its controls after the app, not the page it shows", () => {
    render(
      <DesktopWindow {...defaultProps} title="Photos" appTitle="Files">
        <div>Files content</div>
      </DesktopWindow>,
    );

    expect(screen.getByText("Photos")).toHaveAttribute("data-title-placement", "leading");
    expect(screen.getByRole("region", { name: "Files window" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Minimize Files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Arrange Files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resize Files" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Photos/ })).toBeNull();
  });

  it("gives a leading action without an icon its label instead of an empty button", () => {
    render(
      <DesktopWindow
        {...defaultProps}
        actions={[{ id: "up", label: "Enclosing folder", placement: "leading" }]}
      >
        <div>Files content</div>
      </DesktopWindow>,
    );

    expect(screen.getByRole("button", { name: "Enclosing folder" })).toHaveTextContent("Enclosing folder");
  });

  it("grows title-bar actions with the window controls on touch, above the resize strips", () => {
    const css = readFileSync(join(__dirname, "../app/globals.css"), "utf8");
    const touch = css.slice(css.indexOf("@media (hover: none) and (pointer: coarse)"));
    // The controls: 32px to see, 44px to hit, spaced so the hit areas never overlap
    expect(touch).toMatch(/\[data-window-controls\] \{ gap: 0\.75rem; \}/);
    expect(touch).toMatch(/\[data-window-controls\] > button \{[^}]*width: 2rem; height: 2rem; \}/);
    expect(touch).toMatch(/\[data-window-controls\] > button::after \{[^}]*inset: -0\.375rem; \}/);
    // ...and the unified toolbar leaves them that room: 12px + 3 × 32px + 2 × 12px + 12px
    expect(touch).toMatch(/\.tm-window-content \{ --window-controls-inset: 9rem; \}/);
    expect(touch).toMatch(/\[data-window-actions\] button \{[^}]*min-width: 2rem;[^}]*min-height: 2rem;/);
    expect(touch).toMatch(/\[data-window-actions\] button::after \{[^}]*inset: -0\.375rem 0;/);
    expect(touch).toMatch(/\[data-window-actions="leading"\] button::after \{ inset: -0\.375rem; \}/);
    // A title bar's controls rise above the resize strips; the unified overlay is already absolute (z-30)
    expect(touch).toMatch(/\[data-desktop-window\] :is\(\.tm-window-titlebar \[data-window-controls\], \[data-window-actions\]\) \{ position: relative; z-index: 30; \}/);
  });

  it("fills the area edge to edge when maximized, rounding only the corners above the Dock", () => {
    render(
      <DesktopWindow
        {...defaultProps}
        maximized
        bounds={{ x: 0, y: 0, width: 1400, height: 820 }}
      >
        <div>Files content</div>
      </DesktopWindow>,
    );

    const windowRegion = screen.getByRole("region", { name: "Files window" });
    expect(windowRegion).toHaveClass("rounded-t-none", "rounded-b-2xl", "border-x-0", "border-t-0");
    expect(windowRegion).not.toHaveClass("rounded-2xl");
    expect(windowRegion.className).not.toMatch(/rounded-(?:b-)?xl\b/);
    expect(document.querySelector("[data-resize-edge]")).toBeNull();
  });

  it("removes a disabled window and its controls from interaction", () => {
    render(
      <DesktopWindow {...defaultProps} disabled>
        <div>Files content</div>
      </DesktopWindow>,
    );

    const windowRegion = document.querySelector('[data-desktop-window="files"]');
    expect(windowRegion).toHaveAttribute("inert");
    expect(windowRegion).toHaveAttribute("aria-hidden", "true");
    expect(windowRegion).toHaveClass("pointer-events-none");
  });

  it("keeps a minimized window mounted without exposing it to interaction", () => {
    render(
      <DesktopWindow {...defaultProps} minimized>
        <iframe title="Persistent app frame" src="about:blank" />
      </DesktopWindow>,
    );

    const windowRegion = document.querySelector('[data-desktop-window="files"]');
    expect(windowRegion).toHaveAttribute("data-window-minimized", "true");
    expect(windowRegion).toHaveAttribute("inert");
    expect(windowRegion).toHaveAttribute("aria-hidden", "true");
    expect(windowRegion).toHaveClass(
      "invisible",
      "pointer-events-none",
      "opacity-0",
    );
    expect(screen.getByTitle("Persistent app frame")).toBeInTheDocument();
  });

  it("renders a titlebar menu and dispatches its selected item", async () => {
    const onAction = vi.fn();

    render(
      <DesktopWindow
        {...defaultProps}
        title="Terminal"
        actions={[{
          id: "sessions",
          label: "default",
          kind: "menu",
          placement: "leading",
          items: [
            { id: "session-default", label: "default", active: true },
            { id: "session-refresh", label: "Refresh sessions" },
          ],
        }]}
        onAction={onAction}
      >
        <div>Terminal content</div>
      </DesktopWindow>,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "default" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Refresh sessions" }));

    expect(onAction).toHaveBeenCalledWith("session-refresh");
  });

  it("has no app-specific controls: a menu action is a quiet trigger on the glass, never an opaque patch", async () => {
    const onAction = vi.fn();

    render(
      <DesktopWindow
        {...defaultProps}
        title="session 2"
        actions={[{
          id: "app-menu",
          label: "View",
          kind: "menu",
          items: [{ id: "app-menu-item", label: "As list" }],
        }]}
        onAction={onAction}
      >
        <div>Terminal content</div>
      </DesktopWindow>,
    );

    // Terminal's controls live in its own toolbar row now (terminal-toolbar.tsx)
    expect(screen.queryByRole("group", { name: "Terminal controls" })).toBeNull();
    const trigger = screen.getByRole("button", { name: "View" });
    expect(trigger.className).not.toMatch(/\bbg-background\b/);
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "As list" }));
    expect(onAction).toHaveBeenCalledWith("app-menu-item");
  });

  it("never special-cases an app's actions in the title bar", () => {
    const source = readFileSync(join(__dirname, "../components/desktop/desktop-window.tsx"), "utf8");
    expect(source).not.toMatch(/terminal-(auto|remote|agent|session)/);
    expect(source).not.toMatch(/\bbg-background\b/);
  });
});

describe("DesktopWindow with a unified toolbar (a Talome page in the frame)", () => {
  const baseProps = {
    id: "files",
    title: "Photos",
    appTitle: "Files",
    chrome: "unified" as const,
    bounds: { x: 80, y: 100, width: 700, height: 500 },
    area: { width: 1400, height: 820 },
    minimum: { width: 420, height: 320 },
    active: true,
    maximized: false,
    zIndex: 2,
    onFocus: vi.fn(),
    onClose: vi.fn(),
    onMinimize: vi.fn(),
    onBoundsChange: vi.fn(),
    onMaximizeChange: vi.fn(),
  };

  function renderUnified(props: Partial<React.ComponentProps<typeof DesktopWindow>> = {}) {
    const view = render(
      <DesktopWindow {...baseProps} {...props}>
        <iframe title="Files app" />
      </DesktopWindow>,
    );
    const frame = screen.getByTitle("Files app") as HTMLIFrameElement;
    return { ...view, frame };
  }

  /** A message from the window's own frame (or another source / origin). */
  function post(data: unknown, source: unknown, origin = window.location.origin) {
    const event = new MessageEvent("message", { data, origin });
    Object.defineProperty(event, "source", { value: source });
    act(() => {
      window.dispatchEvent(event);
    });
  }
  const drag = (phase: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
    type: DESKTOP_WINDOW_DRAG_MESSAGE, phase, pointerId: 1, x, y, space: "parent", ...extra,
  });

  it("draws no title bar: the controls float over the frame's top-left corner, named for the app, before the frame", () => {
    const { frame } = renderUnified();

    expect(document.querySelector(".tm-window-titlebar")).toBeNull();
    // The page's place is the frame's to show; the window shows no title of its own
    expect(screen.queryByText("Photos")).toBeNull();
    const controls = screen.getByRole("group", { name: "Window controls" });
    // 12px in, centred in the 52px band, above the resize strips; the gaps let presses through
    expect(controls).toHaveClass("absolute", "top-0", "left-3", "h-13", "z-30", "pointer-events-none", "*:pointer-events-auto");
    const names = Array.from(controls.querySelectorAll("button"), (button) => button.getAttribute("aria-label"));
    expect(names).toEqual(["Close Files", "Minimize Files", "Arrange Files"]);
    // Keyboard order: the controls, then the app, then the resize handle
    const close = screen.getByRole("button", { name: "Close Files" });
    const resize = screen.getByRole("button", { name: "Resize Files" });
    expect(close.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(frame.compareDocumentPosition(resize) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("region", { name: "Files window" })).toHaveAttribute("data-window-chrome", "unified");
  });

  it("keeps a drag strip on the top band until the frame says it draws the toolbar, and after each reload", () => {
    const { frame } = renderUnified();
    const toFrame = vi.spyOn(frame.contentWindow!, "postMessage");
    const strip = () => document.querySelector("[data-window-drag-fallback]");

    expect(strip()).toHaveClass("h-13", "touch-none");
    post({ type: DESKTOP_WINDOW_CHROME_MESSAGE, unified: true }, frame.contentWindow);
    expect(strip()).toBeNull();
    // The frame learns the window's state once it can show it
    expect(toFrame).toHaveBeenCalledWith(
      { type: DESKTOP_WINDOW_STATE_MESSAGE, active: true, title: "Files" },
      window.location.origin,
    );

    // A new page: the strip comes back and the window asks again
    toFrame.mockClear();
    act(() => {
      frame.dispatchEvent(new Event("load"));
    });
    expect(strip()).not.toBeNull();
    expect(toFrame).toHaveBeenCalledWith({ type: DESKTOP_WINDOW_CHROME_REQUEST_MESSAGE }, window.location.origin);
  });

  it("tells the frame when the window stops being the active one", () => {
    const { frame, rerender } = renderUnified();
    const toFrame = vi.spyOn(frame.contentWindow!, "postMessage");
    post({ type: DESKTOP_WINDOW_CHROME_MESSAGE, unified: true }, frame.contentWindow);
    toFrame.mockClear();

    rerender(
      <DesktopWindow {...baseProps} active={false}>
        <iframe title="Files app" />
      </DesktopWindow>,
    );
    expect(toFrame).toHaveBeenCalledWith(
      { type: DESKTOP_WINDOW_STATE_MESSAGE, active: false, title: "Files" },
      window.location.origin,
    );
  });

  it("moves the window by a drag the frame forwards, and snaps it on release", () => {
    const onBoundsChange = vi.fn();
    const onTile = vi.fn();
    const onFocus = vi.fn();
    const { frame } = renderUnified({ onBoundsChange, onTile, onFocus });

    post(drag("start", 300, 120), frame.contentWindow);
    expect(onFocus).toHaveBeenCalled();
    // A forwarded drag leaves the frame its pointer (it holds the capture)
    expect(frame.parentElement).not.toHaveClass("pointer-events-none");
    expect(screen.getByRole("region", { name: "Files window" })).toHaveAttribute("data-window-manipulating", "true");

    post(drag("move", 340, 150), frame.contentWindow);
    expect(onBoundsChange).toHaveBeenLastCalledWith({ x: 120, y: 130, width: 700, height: 500 });

    post(drag("move", 2, 300), frame.contentWindow);
    post(drag("end", 2, 300), frame.contentWindow);
    expect(onTile).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 700, height: 820 },
      { x: 80, y: 100, width: 700, height: 500 },
    );
    expect(screen.getByRole("region", { name: "Files window" })).not.toHaveAttribute("data-window-manipulating");
  });

  it("adds the frame's offset to a drag measured in the frame's own coordinates", () => {
    const onBoundsChange = vi.fn();
    const { frame } = renderUnified({ onBoundsChange });
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ left: 81, top: 101 } as DOMRect);

    post(drag("start", 10, 10, { space: "frame" }), frame.contentWindow);
    post(drag("move", 60, 40, { space: "frame" }), frame.contentWindow);
    expect(onBoundsChange).toHaveBeenLastCalledWith({ x: 130, y: 130, width: 700, height: 500 });
  });

  it("cancels without snapping, and ignores other frames, other origins and other pointers", () => {
    const onBoundsChange = vi.fn();
    const onTile = vi.fn();
    const { frame } = renderUnified({ onBoundsChange, onTile });
    const stranger = document.createElement("iframe");
    document.body.appendChild(stranger);

    post(drag("start", 300, 120), stranger.contentWindow);
    post(drag("start", 300, 120), frame.contentWindow, "http://evil.example");
    post(drag("move", 2, 300), frame.contentWindow);
    expect(onBoundsChange).not.toHaveBeenCalled();

    post(drag("start", 300, 120), frame.contentWindow);
    post(drag("move", 2, 300, { pointerId: 9 }), frame.contentWindow);
    expect(onBoundsChange).not.toHaveBeenCalled();
    post(drag("move", 2, 300), frame.contentWindow);
    expect(onBoundsChange).toHaveBeenCalledTimes(1);
    post(drag("cancel", 2, 300), frame.contentWindow);
    expect(onTile).not.toHaveBeenCalled();
    // Malformed coordinates never move a window
    post(drag("start", 300, 120), frame.contentWindow);
    post({ ...drag("move", 0, 0), x: Number.NaN }, frame.contentWindow);
    expect(onBoundsChange).toHaveBeenCalledTimes(1);
    stranger.remove();
  });

  it("ends a forwarded drag that lost its pointer when this document sees the release", () => {
    const onTile = vi.fn();
    const { frame } = renderUnified({ onTile });
    post(drag("start", 300, 120), frame.contentWindow);
    post(drag("move", 2, 300), frame.contentWindow);
    fireEvent.pointerUp(window);
    expect(onTile).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "Files window" })).not.toHaveAttribute("data-window-manipulating");
  });

  it("gives a filled window its previous size back when the frame drags it away", () => {
    const onTile = vi.fn();
    const { frame } = renderUnified({
      maximized: true,
      bounds: { x: 0, y: 0, width: 1400, height: 820 },
      restoreBounds: { x: 80, y: 100, width: 600, height: 400 },
      onTile,
    });
    post(drag("start", 700, 20), frame.contentWindow);
    post(drag("move", 701, 21), frame.contentWindow); // below the drag threshold
    expect(onTile).not.toHaveBeenCalled();
    post(drag("move", 760, 60), frame.contentWindow);
    expect(onTile).toHaveBeenCalledTimes(1);
    expect(onTile.mock.calls[0][0]).toMatchObject({ width: 600, height: 400 });
  });

  it("fills and comes back on a double-click the frame forwards", () => {
    const onMaximizeChange = vi.fn();
    const onBoundsChange = vi.fn();
    const { frame, rerender } = renderUnified({ onMaximizeChange, onBoundsChange });
    post({ type: DESKTOP_WINDOW_ZOOM_MESSAGE }, frame.contentWindow);
    expect(onMaximizeChange).toHaveBeenCalledWith(true, baseProps.bounds);
    expect(onBoundsChange).toHaveBeenCalledWith({ x: 0, y: 0, width: 1400, height: 820 });

    rerender(
      <DesktopWindow
        {...baseProps}
        maximized
        bounds={{ x: 0, y: 0, width: 1400, height: 820 }}
        restoreBounds={baseProps.bounds}
        onMaximizeChange={onMaximizeChange}
      >
        <iframe title="Files app" />
      </DesktopWindow>,
    );
    post({ type: DESKTOP_WINDOW_ZOOM_MESSAGE }, frame.contentWindow);
    expect(onMaximizeChange).toHaveBeenLastCalledWith(false, baseProps.bounds);
  });

  it("takes no drag from the frame of a minimized or disabled window", () => {
    const onBoundsChange = vi.fn();
    const { frame } = renderUnified({ minimized: true, onBoundsChange });
    post(drag("start", 300, 120), frame.contentWindow);
    post(drag("move", 340, 150), frame.contentWindow);
    expect(onBoundsChange).not.toHaveBeenCalled();
  });

  it("drags from the top band while the page loads, and resizes from its edges as before", () => {
    const onBoundsChange = vi.fn();
    renderUnified({ onBoundsChange });
    fireEvent.pointerDown(document.querySelector("[data-window-drag-fallback]")!, { button: 0, clientX: 300, clientY: 110 });
    fireEvent.pointerMove(window, { clientX: 320, clientY: 130 });
    expect(onBoundsChange).toHaveBeenLastCalledWith({ x: 100, y: 120, width: 700, height: 500 });
    fireEvent.pointerUp(window);

    fireEvent.pointerDown(document.querySelector('[data-resize-edge="e"]')!, { button: 0, clientX: 780, clientY: 300 });
    // The window's own gesture takes the pointer from the frames under it
    expect(screen.getByTitle("Files app").parentElement).toHaveClass("pointer-events-none");
    fireEvent.pointerMove(window, { clientX: 800, clientY: 300 });
    expect(onBoundsChange).toHaveBeenLastCalledWith({ x: 80, y: 100, width: 720, height: 500 });
    fireEvent.pointerUp(window);
  });
});

describe("desktopWindowChrome", () => {
  it("gives Talome pages the unified toolbar and everything else a title bar", () => {
    expect(desktopWindowChrome("/dashboard/files?path=%2F")).toBe("unified");
    expect(desktopWindowChrome(`${window.location.origin}/dashboard/native-apps/talome/grocy`)).toBe("unified");
    expect(desktopWindowChrome("http://192.168.1.20:8096/web/index.html")).toBe("titlebar");
    expect(desktopWindowChrome("/dashboard/files", true)).toBe("titlebar");
  });
});
