/**
 * Dragging a desktop window by its frame's unified toolbar and sidebar top
 * (components/desktop/window-drag.ts): which presses start a drag, and what
 * the frame tells the window around it.
 */
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_WINDOW_DRAG_MESSAGE,
  DESKTOP_WINDOW_ZOOM_MESSAGE,
  parseDesktopWindowDragMessage,
} from "@/atoms/desktop-window-chrome";
import { WindowDragBridge, findWindowDragRegion } from "@/components/desktop/window-drag";

function Window() {
  return (
    <main>
      <WindowDragBridge />
      <div data-testid="surface" data-window-drag-region="surface" style={{ display: "flex" }}>
        <div data-testid="panel" data-window-drag-region="surface">
          <nav data-testid="sidebar-list" aria-label="Sidebar">
            <button type="button">Movies</button>
          </nav>
        </div>
        <div data-testid="column">
          <div data-testid="toolbar" data-window-drag-region="toolbar">
            <div data-slot="toolbar-group" role="group" aria-label="Navigation" data-testid="capsule">
              <button type="button" data-testid="back"><svg data-testid="back-icon" /></button>
            </div>
            <div data-testid="title-box"><span data-testid="title">Movies</span></div>
            <div data-testid="app-toolbar">
              <span data-testid="count">12 items</span>
              <div role="tablist" data-testid="tabs"><button role="tab" type="button" aria-selected>All</button></div>
              <a href="https://talome.example/docs" data-testid="link">Docs</a>
              <div className="search-field" data-testid="search-field"><input aria-label="Search" data-testid="search" /></div>
              <div data-window-no-drag="" data-testid="opted-out"><span data-testid="opted-out-text">Drop here</span></div>
              <span tabIndex={0} data-testid="focusable">Focusable</span>
            </div>
          </div>
          <div data-testid="scroller">Content</div>
        </div>
      </div>
    </main>
  );
}

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

describe("findWindowDragRegion", () => {
  it("drags from a toolbar's empty space, its title and its plain text, never from a control", () => {
    render(<Window />);
    const toolbar = byId("toolbar");
    for (const id of ["toolbar", "title-box", "title", "app-toolbar", "count"]) {
      expect(findWindowDragRegion(byId(id)), id).toBe(toolbar);
    }
    // A text node (Safari can target one) counts as its element
    expect(findWindowDragRegion(byId("title").firstChild)).toBe(toolbar);
    for (const id of ["back", "back-icon", "capsule", "tabs", "link", "search", "search-field", "opted-out", "opted-out-text", "focusable"]) {
      expect(findWindowDragRegion(byId(id)), id).toBeNull();
    }
    expect(findWindowDragRegion(byId("tabs").querySelector("button"))).toBeNull();
  });

  it("drags from a surface only where nothing sits on it", () => {
    render(<Window />);
    // The sidebar panel's own area (its top band) and the glass around it
    expect(findWindowDragRegion(byId("panel"))).toBe(byId("panel"));
    expect(findWindowDragRegion(byId("surface"))).toBe(byId("surface"));
    // What the sidebar holds, and the page, belong to the app
    expect(findWindowDragRegion(byId("sidebar-list"))).toBeNull();
    expect(findWindowDragRegion(byId("panel").querySelector("button"))).toBeNull();
    expect(findWindowDragRegion(byId("column"))).toBeNull();
    expect(findWindowDragRegion(byId("scroller"))).toBeNull();
    expect(findWindowDragRegion(null)).toBeNull();
  });
});

describe("window drag bridge", () => {
  let posted: unknown[];

  beforeEach(() => {
    posted = [];
    // In a window the frame posts to its parent; in jsdom the parent is the window itself
    vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
      posted.push(message);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "frameElement");
  });

  const drags = () => posted.map(parseDesktopWindowDragMessage).filter(Boolean);
  const zooms = () => posted.filter((message) => (message as { type?: string }).type === DESKTOP_WINDOW_ZOOM_MESSAGE);
  const press = (target: Element, init: Partial<PointerEventInit> = {}) => fireEvent.pointerDown(target, {
    pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, clientX: 40, clientY: 20, screenX: 400, screenY: 300, ...init,
  });

  it("forwards a press, its moves and its release on empty toolbar space, in the desktop's coordinates", () => {
    // The frame element's place in the desktop, measured with each event
    Object.defineProperty(window, "frameElement", {
      configurable: true,
      value: { getBoundingClientRect: () => ({ left: 81, top: 101 }), clientLeft: 0, clientTop: 0 },
    });
    const capture = vi.fn();
    render(<Window />);
    const toolbar = byId("toolbar");
    toolbar.setPointerCapture = capture;

    // The press moves the window: no text selection, no focus change
    expect(press(byId("title"))).toBe(false);
    expect(capture).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(toolbar, { pointerId: 1, pointerType: "mouse", buttons: 1, clientX: 60, clientY: 30, screenX: 420, screenY: 310 });
    fireEvent.pointerUp(toolbar, { pointerId: 1, pointerType: "mouse", clientX: 60, clientY: 30, screenX: 420, screenY: 310 });
    // Nothing after the release
    fireEvent.pointerMove(toolbar, { pointerId: 1, pointerType: "mouse", buttons: 1, clientX: 90, clientY: 90 });

    expect(drags()).toEqual([
      { type: DESKTOP_WINDOW_DRAG_MESSAGE, phase: "start", pointerId: 1, x: 121, y: 121, space: "parent" },
      { type: DESKTOP_WINDOW_DRAG_MESSAGE, phase: "move", pointerId: 1, x: 141, y: 131, space: "parent" },
      { type: DESKTOP_WINDOW_DRAG_MESSAGE, phase: "end", pointerId: 1, x: 141, y: 131, space: "parent" },
    ]);
    for (const message of posted) expect(window.postMessage).toHaveBeenCalledWith(message, window.location.origin);
  });

  it("leaves the frame offset to the window when it can't see its frame element", () => {
    render(<Window />);
    press(byId("toolbar"), { clientX: 30, clientY: 12 });
    expect(drags()[0]).toMatchObject({ phase: "start", x: 30, y: 12, space: "frame" });
  });

  it("starts nothing from a control, a link, a field, a secondary button or a second finger", () => {
    render(<Window />);
    for (const id of ["back", "link", "search", "tabs", "sidebar-list", "scroller"]) {
      // Left alone: the control gets its own press (focus, selection, click)
      expect(press(byId(id)), id).toBe(true);
    }
    press(byId("toolbar"), { button: 2 });
    press(byId("toolbar"), { isPrimary: false, pointerType: "touch" });
    expect(drags()).toEqual([]);
  });

  it("cancels on pointercancel and when the frame loses focus, without snapping", () => {
    render(<Window />);
    press(byId("toolbar"));
    fireEvent.pointerCancel(byId("toolbar"), { pointerId: 1 });
    press(byId("panel"));
    fireEvent.blur(window);
    expect(drags().map((message) => message!.phase)).toEqual(["start", "cancel", "start", "cancel"]);
  });

  it("ends a drag whose release it never saw instead of moving the window with no button down", () => {
    render(<Window />);
    press(byId("toolbar"));
    fireEvent.pointerMove(byId("toolbar"), { pointerId: 1, pointerType: "mouse", buttons: 0, clientX: 50, clientY: 25 });
    expect(drags().map((message) => message!.phase)).toEqual(["start", "end"]);
  });

  it("fills on a double-click on empty space, not on a control", () => {
    render(<Window />);
    press(byId("title"));
    fireEvent.pointerUp(byId("title"), { pointerId: 1, pointerType: "mouse" });
    fireEvent.doubleClick(byId("title"));
    fireEvent.doubleClick(byId("back"));
    expect(zooms()).toHaveLength(1);
  });

  it("fills on a double tap with a finger, and only for a tap that didn't move", () => {
    render(<Window />);
    const tap = (screenX: number, moveTo?: number) => {
      press(byId("toolbar"), { pointerType: "touch", screenX });
      if (moveTo !== undefined) {
        fireEvent.pointerMove(byId("toolbar"), { pointerId: 1, pointerType: "touch", buttons: 1, screenX: moveTo, screenY: 300 });
      }
      fireEvent.pointerUp(byId("toolbar"), { pointerId: 1, pointerType: "touch", screenX: moveTo ?? screenX, screenY: 300 });
    };
    tap(400, 460); // a drag, not a tap
    tap(460);
    expect(zooms()).toHaveLength(0);
    tap(462);
    expect(zooms()).toHaveLength(1);
    // Safari's own dblclick for the same taps doesn't fill a second time
    fireEvent.doubleClick(byId("toolbar"));
    expect(zooms()).toHaveLength(1);
  });

  it("stops forwarding when the window shell goes away", () => {
    const view = render(<Window />);
    press(byId("toolbar"));
    view.unmount();
    expect(drags().map((message) => message!.phase)).toEqual(["start", "cancel"]);
    posted = [];
    fireEvent.pointerDown(document.body, { pointerId: 2, isPrimary: true, button: 0 });
    expect(posted).toEqual([]);
  });
});
